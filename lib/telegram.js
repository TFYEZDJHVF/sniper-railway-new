import { createLogger } from "./logger.js";
import { isWalletActive, setWalletActive, removeWalletStatus } from "./walletStatus.js";
const log = createLogger("telegram");

const TOKEN   = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
let offset    = 0;

let _getWatchedWallets;
let _addWallet;
let _removeWallet;
let _getActiveChains;
let _onWalletAdded;

export function initTelegramBot({ getWatchedWallets, addWallet, removeWallet, getActiveChains, onWalletAdded }) {
  _getWatchedWallets = getWatchedWallets;
  _addWallet         = addWallet;
  _removeWallet      = removeWallet;
  _getActiveChains   = getActiveChains;
  _onWalletAdded     = onWalletAdded;
  log.info("Telegram bot started — polling");
  poll();
}

async function send(chatId, text) {
  try {
    await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown", disable_web_page_preview: true }),
    });
  } catch (e) {
    log.error("send failed", { error: e.message });
  }
}

async function poll() {
  if (!TOKEN) { log.error("TELEGRAM_BOT_TOKEN not set"); return; }
  while (true) {
    try {
      const res  = await fetch(`https://api.telegram.org/bot${TOKEN}/getUpdates?offset=${offset}&timeout=30`);
      const data = await res.json();
      if (data.ok && data.result.length > 0) {
        for (const update of data.result) {
          offset = update.update_id + 1;
          await handleUpdate(update);
        }
      }
    } catch (e) {
      log.error("Poll error", { error: e.message });
      await sleep(5000);
    }
  }
}

async function handleUpdate(update) {
  const msg = update.message;
  if (!msg?.text) return;
  const chatId = msg.chat.id.toString();
  const text   = msg.text.trim();
  if (chatId !== CHAT_ID) { log.warn("Unauthorized chat", { chatId }); return; }

  if      (text.startsWith("/add"))     await handleAdd(chatId, text);
  else if (text.startsWith("/remove"))  await handleRemove(chatId, text);
  else if (text === "/list")            await handleList(chatId);
  else if (text === "/chains")          await handleChains(chatId);
  else if (text.startsWith("/enable"))  await handleToggle(chatId, text, true);
  else if (text.startsWith("/disable")) await handleToggle(chatId, text, false);
  else if (text === "/help" || text === "/start") await handleHelp(chatId);
  else await send(chatId, `❓ Unknown command. Type /help to see available commands.`);
}

async function handleAdd(chatId, text) {
  const address = text.split(/\s+/)[1]?.trim();
  if (!address || address.length < 32) {
    await send(chatId, `❌ Invalid address.\n\nUsage: \`/add <wallet_address>\``);
    return;
  }
  const added = _addWallet(address);
  if (!added) { await send(chatId, `⚠️ Wallet already tracked:\n\`${address}\``); return; }
  setWalletActive(address, true);
  await _onWalletAdded(address); // add to Helius webhook immediately
  await send(chatId, `✅ *Wallet added* 🟢\n\`${address}\`\n\nTracking is active. Use /disable to pause it.`);
}

async function handleRemove(chatId, text) {
  const address = text.split(/\s+/)[1]?.trim();
  if (!address || address.length < 32) {
    await send(chatId, `❌ Invalid address.\n\nUsage: \`/remove <wallet_address>\``);
    return;
  }
  const removed = _removeWallet(address);
  if (!removed) { await send(chatId, `⚠️ Wallet not found:\n\`${address}\``); return; }
  removeWalletStatus(address);
  await send(chatId, `🗑 *Wallet removed*\n\`${address}\``);
}

async function handleToggle(chatId, text, active) {
  const address = text.split(/\s+/)[1]?.trim();
  if (!address || address.length < 32) {
    await send(chatId, `❌ Invalid address.\n\nUsage: \`/${active ? "enable" : "disable"} <wallet_address>\``);
    return;
  }
  if (!_getWatchedWallets().includes(address)) {
    await send(chatId, `⚠️ Wallet not tracked:\n\`${address}\`\n\nUse /add first.`);
    return;
  }
  setWalletActive(address, active);
  await send(chatId, `${active ? "🟢" : "🔴"} *Tracking ${active ? "enabled" : "paused"}*\n\`${address}\``);
}

async function handleList(chatId) {
  const wallets = _getWatchedWallets();
  if (!wallets.length) {
    await send(chatId, `📭 No wallets tracked yet.\n\nUse /add <address> to add one.`);
    return;
  }
  const lines = wallets.map((w, i) => {
    const active = isWalletActive(w);
    return `${active ? "🟢" : "🔴"} \`${w.slice(0,8)}…${w.slice(-4)}\` — _${active ? "active" : "paused"}_`;
  });
  await send(chatId, `👛 *Tracked wallets (${wallets.length})*\n\n${lines.join("\n")}\n\nUse /enable or /disable to toggle.`);
}

async function handleChains(chatId) {
  const chains = _getActiveChains();
  if (!chains.length) { await send(chatId, `🔗 No active chains at the moment.`); return; }
  const lines = chains.map((c, i) => {
    const age  = Math.floor((Date.now() / 1000 - c.startedAt) / 60);
    const hops = c.hops.map(h => `  • \`${h.from.slice(0,8)}…\`→\`${h.to.slice(0,8)}…\` (${h.solAmount.toFixed(3)} SOL)`).join("\n");
    return `*Chain ${i+1}* — ${c.hops.length} hop(s) — ${age}min ago\nRoot: \`${c.rootWallet}\`\n${hops}`;
  }).join("\n\n");
  await send(chatId, `🔗 *Active chains (${chains.length})*\n\n${lines}`);
}

async function handleHelp(chatId) {
  await send(chatId, [
    `🤖 *Solana Snipe Bot*`,
    ``,
    `*Wallet management:*`,
    `/add <address> — Add a wallet to track`,
    `/remove <address> — Remove a wallet`,
    `/list — Show all wallets with status`,
    `/enable <address> — 🟢 Resume tracking`,
    `/disable <address> — 🔴 Pause tracking`,
    ``,
    `*Monitoring:*`,
    `/chains — Show active transfer chains`,
    ``,
    `🟢 Active — bot is tracking this wallet`,
    `🔴 Paused — tracking paused by you`,
  ].join("\n"));
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
