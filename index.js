import express        from "express";
import { createLogger }                                          from "./lib/logger.js";
import { parseNativeTransfers, detectPumpFunLaunch }            from "./lib/tracker.js";
import { initWatchedWallets, getWatchedWallets, addWallet,
         removeWallet, getActiveChains, registerTransfer,
         getChainForWallet, markChainSniped }                   from "./lib/chainState.js";
import { isWalletActive }                                       from "./lib/walletStatus.js";
import { upsertWebhook, addWalletsToWebhook }                   from "./lib/helius.js";
import { initTelegramBot }                                      from "./lib/telegram.js";
import { send }                                                 from "./outputs/tradewiz.js";

const log     = createLogger("main");
const app     = express();
const PORT    = process.env.PORT || 3000;
const MIN_SOL = parseFloat(process.env.MIN_SOL_THRESHOLD || "0.1");

// ── Parse JSON fast — no middleware overhead ──────────────────
app.use(express.json({ limit: "1mb" }));

// ── Signal queue — decouples detection from Telegram send ─────
const queue = [];
let processing = false;

function pushSignal(signal) {
  queue.push(signal);
  if (!processing) drainQueue();
}

async function drainQueue() {
  if (processing || !queue.length) return;
  processing = true;
  while (queue.length) {
    const s = queue.shift();
    try { await send(s); }
    catch (e) { log.error("Signal failed", { error: e.message }); }
  }
  processing = false;
}

// ── Webhook endpoint — HOT PATH ───────────────────────────────
app.post("/webhook", (req, res) => {
  // Respond to Helius immediately — do NOT await processing
  res.status(200).json({ ok: true });

  // Verify secret if set
  const secret = process.env.HELIUS_WEBHOOK_SECRET;
  if (secret && req.headers["authorization"] !== `Bearer ${secret}`) {
    log.warn("Unauthorized webhook call");
    return;
  }

  const txs = Array.isArray(req.body) ? req.body : [req.body];

  // Fire and forget — response already sent, process in background
  for (const tx of txs) processTx(tx);
});

// ── Setup endpoint — register wallets on Helius (call once) ───
app.get("/setup", async (req, res) => {
  if (req.query.secret !== process.env.SETUP_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  try {
    const result = await upsertWebhook(getWatchedWallets());
    log.info("Webhook setup complete");
    return res.status(200).json({ ok: true, result });
  } catch (e) {
    log.error("Setup failed", { error: e.message });
    return res.status(500).json({ error: e.message });
  }
});

// ── Health check — Railway uses this to verify the service ────
app.get("/health", (_, res) => res.status(200).json({ ok: true, uptime: process.uptime() }));

// ── Core transaction processor ────────────────────────────────
async function processTx(tx) {
  const t0 = Date.now();
  try {
    // Priority 1 — Pump.fun launch detection
    const launch = detectPumpFunLaunch(tx);
    if (launch) {
      const chain = getChainForWallet(launch.feePayer);
      if (chain && !chain.sniped) {
        if (!isWalletActive(chain.rootWallet)) {
          log.info("Launch ignored — wallet paused", { root: chain.rootWallet.slice(0,8) });
          return;
        }
        const latencyMs = Date.now() - t0;
        log.info("🚨 LAUNCH", { mint: launch.mint, hops: chain.hops.length, latencyMs });
        markChainSniped(chain.rootWallet);
        pushSignal({ mint: launch.mint, dex: launch.dex, solAmount: launch.solAmount, chain, launch, latencyMs });
      }
      return;
    }

    // Priority 2 — Track SOL transfer chains
    const transfers = parseNativeTransfers(tx);
    for (const transfer of transfers) {
      if (transfer.solAmount < MIN_SOL) continue;
      if (!isWalletActive(transfer.from)) continue;
      const chain = registerTransfer(transfer);
      if (chain) {
        // Add new hop wallet to Helius webhook — non-blocking
        addWalletsToWebhook([transfer.to]).catch(e =>
          log.error("addWalletsToWebhook failed", { error: e.message })
        );
      }
    }

    log.debug("Tx processed", { ms: Date.now() - t0 });
  } catch (e) {
    log.error("processTx failed", { error: e.message });
  }
}

// ── Startup ───────────────────────────────────────────────────
const WATCHED = (process.env.WATCHED_WALLETS || "").split(",").filter(Boolean);
if (!process.env.HELIUS_API_KEY) { log.error("HELIUS_API_KEY not set"); process.exit(1); }

initWatchedWallets(WATCHED);

// Wire Telegram bot
initTelegramBot({
  getWatchedWallets,
  addWallet,
  removeWallet,
  getActiveChains,
  onWalletAdded: async (address) => {
    await addWalletsToWebhook([address]);
  },
});

app.listen(PORT, () => {
  log.info(`🚀 Bot running on port ${PORT}`, { wallets: WATCHED.length, minSol: MIN_SOL });
  log.info(`Setup: GET /setup?secret=YOUR_SETUP_SECRET`);
});

process.on("SIGTERM", () => { log.info("Shutting down"); process.exit(0); });
process.on("SIGINT",  () => { log.info("Shutting down"); process.exit(0); });
