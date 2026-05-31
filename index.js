import express        from "express";
import { createLogger }                                          from "./lib/logger.js";
import { parseNativeTransfers, detectPumpFunLaunch }            from "./lib/tracker.js";
import { initWatchedWallets, getWatchedWallets, addWallet,
         removeWallet, getActiveChains, registerTransfer,
         getChainForWallet, markChainSniped }                   from "./lib/chainState.js";
import { isWalletActive }                                       from "./lib/walletStatus.js";
import { passesFilter }                                         from "./lib/solFilter.js";
import { upsertWebhook, addWalletsToWebhook }                   from "./lib/helius.js";
import { initTelegramBot }                                      from "./lib/telegram.js";
import { send }                                                 from "./outputs/tradewiz.js";

const log  = createLogger("main");
const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "1mb" }));

// Signal queue
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

// ── Webhook — HOT PATH ────────────────────────────────────────
app.post("/webhook", (req, res) => {
  res.status(200).json({ ok: true }); // respond immediately

// ── Webhook — HOT PATH ────────────────────────────────────────
app.post("/webhook", (req, res) => {
  // ALWAYS respond immediately to Helius
  res.status(200).json({ ok: true });

  // DEBUG (optional but useful)
  log.info("WEBHOOK RECEIVED");

  const txs = Array.isArray(req.body) ? req.body : [req.body];

  // Process async (do NOT block Helius)
  for (const tx of txs) {
    processTx(tx);
  }
});

// ── Setup ─────────────────────────────────────────────────────
app.get("/setup", async (req, res) => {
  if (req.query.secret !== process.env.SETUP_SECRET) return res.status(401).json({ error: "Unauthorized" });
  try {
    const result = await upsertWebhook(getWatchedWallets());
    log.info("Webhook setup complete");
    return res.status(200).json({ ok: true, result });
  } catch (e) {
    log.error("Setup failed", { error: e.message });
    return res.status(500).json({ error: e.message });
  }
});

// ── Health check ──────────────────────────────────────────────
app.get("/health", (_, res) => res.status(200).json({ ok: true, uptime: process.uptime() }));

// ── Core processor ────────────────────────────────────────────
async function processTx(tx) {
  const t0 = Date.now();
  try {
    // Priority 1 — Pump.fun launch
    const launch = detectPumpFunLaunch(tx);
    if (launch) {
      const chain = getChainForWallet(launch.feePayer);
      if (chain && !chain.sniped) {
        if (!isWalletActive(chain.rootWallet)) return;
        const latencyMs = Date.now() - t0;
        log.info("🚨 LAUNCH", { mint: launch.mint, hops: chain.hops.length, latencyMs });
        markChainSniped(chain.rootWallet);
        pushSignal({ mint: launch.mint, dex: launch.dex, solAmount: launch.solAmount, chain, launch, latencyMs });
      }
      return;
    }

    // Priority 2 — Track SOL transfers using SOL range filter
    const transfers = parseNativeTransfers(tx);
    for (const transfer of transfers) {
      if (!passesFilter(transfer.solAmount)) continue; // ← uses min/max range
      if (!isWalletActive(transfer.from)) continue;
      const chain = registerTransfer(transfer);
      if (chain) {
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
initTelegramBot({
  getWatchedWallets,
  addWallet,
  removeWallet,
  getActiveChains,
  onWalletAdded: async (address) => { await addWalletsToWebhook([address]); },
});

app.listen(PORT, () => {
  log.info(`🚀 Bot running on port ${PORT}`, { wallets: WATCHED.length });
});

process.on("SIGTERM", () => { log.info("Shutting down"); process.exit(0); });
process.on("SIGINT",  () => { log.info("Shutting down"); process.exit(0); });
