import { createLogger } from "./logger.js";
import { isWalletActive, setWalletActive, removeWalletStatus } from "./walletStatus.js";
const log = createLogger("telegram");

const TOKEN   = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
let offset    = 0;

// Pending state per chat — waiting for wallet address input
const pendingAction = new Map(); // chatId → "add" | "remove" | "enable" | "disable"

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

// ── Send plain message ────────────────────────────────────────
async function send(chatId, text, extra = {}) {
  try {
    await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({
        chat_id:                  chatId,
        text,
        parse_mode:               "Markdown",
        disable_web_page_preview: true,
        ...extra,
      }),
    });
  } catch (e) {
    log.error("send failed", { error: e.message });
  }
}

// ── Edit existing message (for button responses) ──────────────
async function editMessage(chatId, messageId, text, extra = {}) {
  try {
    await fetch(`https://api.telegram.org/bot${TOKEN}/editMessageText`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({
        chat_id:                  chatId,
        message_id:               messageId,
        text,
        parse_mode:               "Markdown",
        disable_web_page_preview: true,
        ...extra,
      }),
    });
  } catch (e) {
    log.error("editMessage failed", { error: e.message });
  }
}

// ── Answer callback query (removes loading spinner on button) ─
async function answerCallback(callbackQueryId, text = "") {
  try {
    await fetch(`https://api.telegram.org/bot${TOKEN}/answerCallbackQuery`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ callback_query_id: callbackQueryId, text }),
    });
  } catch (e) {
    log.error("answerCallback failed", { error: e.message });
  }
}

// ── Solscan link for a wallet ─────────────────────────────────
function solscanLink(address) {
  return `[${address.slice(0,8)}…${address.slice(-4)}](https://solscan.io/account/${address})`;
}

// ── Main menu ─────────────────────────────────────────────────
async function showMainMenu(chatId, messageId = null) {
  const text = `🤖 *Solana Snipe Bot*\n\nWhat do you want to do?`;
  const keyboard = {
    inline_keyboard: [
      [
        { text: "➕ Add wallet",    callback_data: "action:add" },
        { text: "🗑 Remove wallet", callback_data: "action:remove" },
      ],
      [
        { text: "📋 List wallets",  callback_data: "action:list" },
        { text: "🔗 Active chains", callback_data: "action:chains" },
      ],
      [
        { text: "🟢 Enable wallet",  callback_data: "action:enable" },
        { text: "🔴 Disable wallet", callback_data: "action:disable" },
      ],
    ],
  };
  if (messageId) {
    await editMessage(chatId, messageId, text, { reply_markup: keyboard });
  } else {
    await send(chatId, text, { reply_markup: keyboard });
  }
}

// ── Wallet list with inline enable/disable/remove buttons ─────
async function showWalletList(chatId, messageId = null) {
  const wallets = _getWatchedWallets();
  if (!wallets.length) {
    const text = `📭 *No wallets tracked yet.*\n\nUse ➕ Add wallet to get started.`;
    const keyboard = { inline_keyboard: [[{ text: "⬅️ Back", callback_data: "action:menu" }]] };
    if (messageId) await editMessage(chatId, messageId, text, { reply_markup: keyboard });
    else await send(chatId, text, { reply_markup: keyboard });
    return;
  }

  const lines = wallets.map((w, i) => {
    const active = isWalletActive(w);
    const dot    = active ? "🟢" : "🔴";
    return `${dot} ${i+1}\\. ${solscanLink(w)}`;
  });

  const buttons = wallets.map((w, i) => {
    const active = isWalletActive(w);
    return [
      { text: `${active ? "🔴 Pause" : "🟢 Resume"} #${i+1}`, callback_data: `toggle:${w}` },
      { text: `🗑 Remove #${i+1}`,                              callback_data: `remove:${w}` },
    ];
  });
  buttons.push([{ text: "⬅️ Back", callback_data: "action:menu" }]);

  const text = `👛 *Tracked wallets (${wallets.length})*\n\n${lines.join("\n")}`;
  const keyboard = { inline_keyboard: buttons };
  if (messageId) await editMessage(chatId, messageId, text, { reply_markup: keyboard });
  else await send(chatId, text, { reply_markup: keyboard });
}

// ── Active chains display ─────────────────────────────────────
async function showChains(chatId, messageId = null) {
  const chains = _getActiveChains();
  const keyboard = { inline_keyboard: [[{ text: "⬅️ Back", callback_data: "action:menu" }]] };

  if (!chains.length) {
    const text = `🔗 *No active chains at the moment.*`;
    if (messageId) await editMessage(chatId, messageId, text, { reply_markup: keyboard });
    else await send(chatId, text, { reply_markup: keyboard });
    return;
  }

  const lines = chains.map((c, i) => {
    const age  = Math.floor((Date.now() / 1000 - c.startedAt) / 60);
    const hops = c.hops.map(h =>
      `  • ${solscanLink(h.from)}→${solscanLink(h.to)} \\(${h.solAmount.toFixed(3)} SOL\\)`
    ).join("\n");
    return `*Chain ${i+1}* — ${c.hops.length} hop(s) — ${age}min ago\nRoot: ${solscanLink(c.rootWallet)}\n${hops}`;
  }).join("\n\n");

  const text = `🔗 *Active chains (${chains.length})*\n\n${lines}`;
  if (messageId) await editMessage(chatId, messageId, text, { reply_markup: keyboard });
  else await send(chatId, text, { reply_markup: keyboard });
}

// ── Prompt user to type a wallet address ──────────────────────
async function promptAddress(chatId, messageId, action) {
  pendingAction.set(chatId, action);
  const labels = {
    add:     "➕ *Add wallet*\n\nPlease send the wallet address you want to track:",
    remove:  "🗑 *Remove wallet*\n\nPlease send the wallet address to remove:",
    enable:  "🟢 *Enable wallet*\n\nPlease send the wallet address to enable:",
    disable: "🔴 *Disable wallet*\n\nPlease send the wallet address to pause:",
  };
  const keyboard = { inline_keyboard: [[{ text: "❌ Cancel", callback_data: "action:cancel" }]] };
  await editMessage(chatId, messageId, labels[action], { reply_markup: keyboard });
}

// ── Poll for updates ──────────────────────────────────────────
async function poll() {
  if (!TOKEN) { log.error("TELEGRAM_BOT_TOKEN not set"); return; }
  while (true) {
    try {
      const res  = await fetch(`https://api.telegram.org/bot${TOKEN}/getUpdates?offset=${offset}&timeout=30`);
      const data = await res.json();
      if (data.ok && data.result.length > 0) {
        for (const update of data.result) {
          offset = update.update_id + 1;
          if (update.callback_query) await handleCallback(update.callback_query);
          else if (update.message)   await handleMessage(update.message);
        }
      }
    } catch (e) {
      log.error("Poll error", { error: e.message });
      await sleep(5000);
    }
  }
}

// ── Handle button taps ────────────────────────────────────────
async function handleCallback(cb) {
  const chatId    = cb.message.chat.id.toString();
  const messageId = cb.message.message_id;
  const data      = cb.data;

  if (chatId !== CHAT_ID) return;
  await answerCallback(cb.id);

  // Menu actions
  if (data === "action:menu")    { pendingAction.delete(chatId); return showMainMenu(chatId, messageId); }
  if (data === "action:list")    return showWalletList(chatId, messageId);
  if (data === "action:chains")  return showChains(chatId, messageId);
  if (data === "action:cancel")  { pendingAction.delete(chatId); return showMainMenu(chatId, messageId); }
  if (data === "action:add")     return promptAddress(chatId, messageId, "add");
  if (data === "action:remove")  return promptAddress(chatId, messageId, "remove");
  if (data === "action:enable")  return promptAddress(chatId, messageId, "enable");
  if (data === "action:disable") return promptAddress(chatId, messageId, "disable");

  // Inline toggle from /list
  if (data.startsWith("toggle:")) {
    const address = data.slice(7);
    const current = isWalletActive(address);
    setWalletActive(address, !current);
    log.info(`Wallet ${!current ? "enabled" : "paused"}`, { address: address.slice(0,8) });
    return showWalletList(chatId, messageId);
  }

  // Inline remove from /list
  if (data.startsWith("remove:")) {
    const address = data.slice(7);
    _removeWallet(address);
    removeWalletStatus(address);
    log.info("Wallet removed", { address: address.slice(0,8) });
    return showWalletList(chatId, messageId);
  }
}

// ── Handle text messages ──────────────────────────────────────
async function handleMessage(msg) {
  if (!msg?.text) return;
  const chatId = msg.chat.id.toString();
  const text   = msg.text.trim();
  if (chatId !== CHAT_ID) { log.warn("Unauthorized chat", { chatId }); return; }

  // /start or /help → show menu
  if (text === "/start" || text === "/help") {
    return showMainMenu(chatId);
  }

  // If waiting for a wallet address
  const action = pendingAction.get(chatId);
  if (action) {
    pendingAction.delete(chatId);
    await handleAddressInput(chatId, text, action);
    return;
  }

  // Fallback
  await showMainMenu(chatId);
}

// ── Process wallet address input after prompt ─────────────────
async function handleAddressInput(chatId, address, action) {
  if (address.length < 32 || address.length > 44) {
    await send(chatId, `❌ Invalid address. Please try again.`);
    await showMainMenu(chatId);
    return;
  }

  if (action === "add") {
    const added = _addWallet(address);
    if (!added) {
      await send(chatId, `⚠️ Already tracked: ${solscanLink(address)}`);
    } else {
      setWalletActive(address, true);
      await _onWalletAdded(address);
      await send(chatId, `✅ *Wallet added* 🟢\n\n${solscanLink(address)}\n\nTracking is active.`);
    }
  } else if (action === "remove") {
    const removed = _removeWallet(address);
    if (!removed) await send(chatId, `⚠️ Not found: ${solscanLink(address)}`);
    else { removeWalletStatus(address); await send(chatId, `🗑 *Wallet removed*\n\n${solscanLink(address)}`); }
  } else if (action === "enable") {
    if (!_getWatchedWallets().includes(address)) {
      await send(chatId, `⚠️ Not tracked: ${solscanLink(address)}\n\nUse ➕ Add wallet first.`);
    } else {
      setWalletActive(address, true);
      await send(chatId, `🟢 *Tracking enabled*\n\n${solscanLink(address)}`);
    }
  } else if (action === "disable") {
    if (!_getWatchedWallets().includes(address)) {
      await send(chatId, `⚠️ Not tracked: ${solscanLink(address)}\n\nUse ➕ Add wallet first.`);
    } else {
      setWalletActive(address, false);
      await send(chatId, `🔴 *Tracking paused*\n\n${solscanLink(address)}`);
    }
  }

  await showMainMenu(chatId);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }