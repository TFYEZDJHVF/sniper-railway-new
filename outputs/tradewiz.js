import { createLogger } from "../lib/logger.js";
import { getWalletName } from "../lib/walletNames.js";
const log = createLogger("tradewiz");

export async function send({ mint, solAmount, chain, launch, latencyMs }) {
  const token        = process.env.TELEGRAM_BOT_TOKEN;
  const userChatId   = process.env.TELEGRAM_CHAT_ID;
  const tradewizChat = process.env.TRADEWIZ_CHAT_ID;
  if (!token) { log.error("Missing TELEGRAM_BOT_TOKEN"); return; }

  // Get the copy trade name linked to the root wallet
  const copyTradeName = getWalletName(chain.rootWallet);

  const hops = chain.hops
    .map((h, i) => `  #${i+1} ${h.from.slice(0,8)}…→${h.to.slice(0,8)}… (${h.solAmount.toFixed(3)} SOL)`)
    .join("\n");

  // ── Message to TradeWiz ───────────────────────────────────
  // Format: mint on first line so TradeWiz parses it
  // Then the copy trade name so TradeWiz knows which config to use
  const tradeWizMsg = [
    mint,
    copyTradeName ? `COPY: ${copyTradeName}` : "",
  ].filter(Boolean).join("\n");

  // ── Alert to you ──────────────────────────────────────────
  const userMsg = [
    `🚨 *SNIPE SIGNAL — Pump\\.fun*`,
    ``,
    `🪙 *Mint:* [${mint.slice(0,8)}…](https://solscan.io/token/${mint})`,
    `💰 *SOL:* ${solAmount.toFixed(3)}`,
    `🔗 *Chain:* ${chain.hops.length} hop(s)`,
    hops,
    ``,
    `👣 *Root:* [${chain.rootWallet.slice(0,8)}…](https://solscan.io/account/${chain.rootWallet})`,
    copyTradeName ? `📋 *Copy trade:* \`${copyTradeName}\`` : "",
    `⚡ *${latencyMs}ms*`,
  ].filter(Boolean).join("\n");

  const start = Date.now();

  await Promise.allSettled([
    tradewizChat ? postMessage(token, tradewizChat, tradeWizMsg, false) : Promise.resolve(),
    userChatId   ? postMessage(token, userChatId,   userMsg,     true)  : Promise.resolve(),
  ]);

  log.info("✅ Signals sent", { mint, copyTradeName, latencyMs, totalMs: Date.now() - start });
}

async function postMessage(token, chatId, text, markdown) {
  try {
    const res  = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({
        chat_id:                  chatId,
        text,
        ...(markdown ? { parse_mode: "MarkdownV2" } : {}),
        disable_web_page_preview: true,
      }),
    });
    const data = await res.json();
    if (!data.ok) log.error("Telegram rejected", { chatId, response: data });
  } catch (e) {
    log.error("postMessage failed", { chatId, error: e.message });
  }
}