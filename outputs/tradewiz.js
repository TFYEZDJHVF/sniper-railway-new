import { createLogger } from "../lib/logger.js";
const log = createLogger("tradewiz");

function tradeWizLine(mint) {
  const fmt = (process.env.TRADEWIZ_FORMAT || "mint_only").trim();
  if (fmt === "BUY")   return `BUY ${mint}`;
  if (fmt === "SNIPE") return `SNIPE ${mint}`;
  return mint;
}

export async function send({ mint, solAmount, chain, launch, latencyMs }) {
  const token  = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) { log.error("Missing Telegram env vars"); return; }

  const hops = chain.hops
    .map((h, i) => `  #${i+1} ${h.from.slice(0,8)}…→${h.to.slice(0,8)}… (${h.solAmount.toFixed(3)} SOL)`)
    .join("\n");

  const msg = [
    tradeWizLine(mint),
    ``,
    `🚨 SNIPE SIGNAL — Pump.fun`,
    `🪙 Mint: ${mint}`,
    `💰 SOL: ${solAmount.toFixed(3)}`,
    `🔗 Chain: ${chain.hops.length} hop(s)`,
    hops,
    `👣 Root: ${chain.rootWallet}`,
    `🔎 Tx: ${launch.signature}`,
    `⚡ ${latencyMs}ms`,
  ].join("\n");

  const start = Date.now();
  try {
    const res  = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: msg, disable_web_page_preview: true }),
    });
    const data = await res.json();
    if (!data.ok) log.error("Telegram rejected", { response: data });
    else log.info("✅ Signal sent", { mint, latencyMs, telegramMs: Date.now() - start });
  } catch (e) {
    log.error("Telegram fetch failed", { error: e.message });
  }
}
