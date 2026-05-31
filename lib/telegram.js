import { createLogger } from "./logger.js";
import { isWalletActive, setWalletActive, removeWalletStatus } from "./walletStatus.js";
import { getSolFilter, setSolFilter } from "./solFilter.js";
const log = createLogger("telegram");

const TOKEN   = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
let offset    = 0;

// Pending state per chat
const pendingAction = new Map(); // chatId → "add" | "remove" | "enable" | "disable" | "solfilter"

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

async function send(chatId, text, extra = {}) {
  try {
    await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown", disable_web_page_preview: true, ...extra }),
    });
  } catch (e) { log.error("send failed", { error: e.message }); }
}

async function editMessage(chatId, messageId, text, extra = {}) {
  try {
    await fetch(`https://api.telegram.org/bot${TOKEN}/editMessageText`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ chat_id: chatId, message_id: messageId, text, parse_mode: "Markdown", disable_web_page_preview: true, ...extra }),
    });
  } catch (e) { log.error("editMessage failed", { error: e.message }); }
}

async function answerCallback(id, text = "") {
  try {
    await fetch(`https://api.telegram.org/bot${TOKEN}/answerCallbackQuery`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ callback_query_id: id, text }),
    });
  } catch (e) { log.error("answerCallback failed", { error: e.message }); }
}

function solscanLink(address) {
  return `[${address.slice(0,8)}…${address.slice(-4)}](https://solscan.io/account/${address})`;
}

// ── Main menu ─────────────────────────────────────────────────
async function showMainMenu(chatId, messageId = null) {
  const { minSol, maxSol } = getSolFilter();
  const filterLabel = maxSol >= 999999
    ? `⚙️ SOL filter: > ${minSol}`
    : `⚙️ SOL filter: ${minSol} — ${maxSol}`;

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
      [
        { text: filterLabel, callback_data: "action:solfilter" },
      ],
    ],
  };
  if (messageId) await editMessage(chatId, messageId, text, { reply_markup: keyboard });
  else await send(chatId, text, { reply_markup: keyboard });
}

// ── Wallet list ───────────────────────────────────────────────
async function showWalletList(chatId, messageId = null) {
  const wallets = _getWatchedWallets();
  const keyboard_back = { inline_keyboard: [[{ text: "⬅️ Back", callback_data: "action:menu" }]] };
  if (!wallets.length) {
    const text = `📭 *No wallets tracked yet.*\n\nUse ➕ Add wallet to get started.`;
    if (messageId) await editMessage(chatId, messageId, text, { reply_markup: keyboard_back });
    else await send(chatId, text, { reply_markup: keyboard_back });
    return;
  }
  const lines   = wallets.map((w, i) => `${isWalletActive(w) ? "🟢" : "🔴"} ${i+1}\\. ${solscanLink(w)}`);
  const buttons = wallets.map((w, i) => [
    { text: `${isWalletActive(w) ? "🔴 Pause" : "🟢 Resume"} #${i+1}`, callback_data: `toggle:${w}` },
    { text: `🗑 Remove #${i+1}`, callback_data: `remove:${w}` },
  ]);
  buttons.push([{ text: "⬅️ Back", callback_data: "action:menu" }]);
  const text = `👛 *Tracked wallets (${wallets.length})*\n\n${lines.join("\n")}`;
  if (messageId) await editMessage(chatId, messageId, text, { reply_markup: { inline_keyboard: buttons } });
  else await send(chatId, text, { reply_markup: { inline_keyboard: buttons } });
}

// ── Chains ────────────────────────────────────────────────────
async function showChains(chatId, messageId = null) {
  const chains  = _getActiveChains();
  const keyboard = { inline_keyboard: [[{ text: "⬅️ Back", callback_data: "action:menu" }]] };
  if (!chains.length) {
    const text = `🔗 *No active chains at the moment.*`;
    if (messageId) await editMessage(chatId, messageId, text, { reply_markup: keyboard });
    else await send(chatId, text, { reply_markup: keyboard });
    return;
  }
  const lines = chains.map((c, i) => {
    const age  = Math.floor((Date.now() / 1000 - c.startedAt) / 60);
    const hops = c.hops.map(h => `  • ${solscanLink(h.from)}→${solscanLink(h.to)} (${h.solAmount.toFixed(3)} SOL)`).join("\n");
    return `*Chain ${i+1}* — ${c.hops.length} hop(s) — ${age}min ago\nRoot: ${solscanLink(c.rootWallet)}\n${hops}`;
  }).join("\n\n");
  if (messageId) await editMessage(chatId, messageId, `🔗 *Active chains (${chains.length})*\n\n${lines}`, { reply_markup: keyboard });
  else await send(chatId, `🔗 *Active chains (${chains.length})*\n\n${lines}`, { reply_markup: keyboard });
}

// ── SOL filter UI ─────────────────────────────────────────────
async function showSolFilter(chatId, messageId = null) {
  const { minSol, maxSol } = getSolFilter();
  const current = maxSol >= 999999
    ? `Current: *> ${minSol} SOL* (no max)`
    : `Current: *${minSol} — ${maxSol} SOL*`;

  const text = [
    `⚙️ *SOL Transfer Filter*`,
    ``,
    current,
    ``,
    `Choose a preset or set a custom range:`,
  ].join("\n");

  const keyboard = {
    inline_keyboard: [
      [
        { text: "1 — 5 SOL",   callback_data: "filter:1:5" },
        { text: "5 — 10 SOL",  callback_data: "filter:5:10" },
      ],
      [
        { text: "10 — 50 SOL", callback_data: "filter:10:50" },
        { text: "50 — 100 SOL",callback_data: "filter:50:100" },
      ],
      [
        { text: "✏️ Custom range", callback_data: "filter:custom" },
        { text: "♾ No limit",     callback_data: "filter:0:999999" },
      ],
      [{ text: "⬅️ Back", callback_data: "action:menu" }],
    ],
  };
  if (messageId) await editMessage(chatId, messageId, text, { reply_markup: keyboard });
  else await send(chatId, text, { reply_markup: keyboard });
}

// ── Address prompt ────────────────────────────────────────────
async function promptAddress(chatId, messageId, action) {
  pendingAction.set(chatId, action);
  const labels = {
    add:     `➕ *Add wallet*\n\nSend the wallet address you want to track:`,
    remove:  `🗑 *Remove wallet*\n\nSend the wallet address to remove:`,
    enable:  `🟢 *Enable wallet*\n\nSend the wallet address to enable:`,
    disable: `🔴 *Disable wallet*\n\nSend the wallet address to pause:`,
  };
  const keyboard = { inline_keyboard: [[{ text: "❌ Cancel", callback_data: "action:cancel" }]] };
  await editMessage(chatId, messageId, labels[action], { reply_markup: keyboard });
}

// ── Custom SOL range prompt ───────────────────────────────────
async function promptSolFilter(chatId, messageId) {
  pendingAction.set(chatId, "solfilter");
  const keyboard = { inline_keyboard: [[{ text: "❌ Cancel", callback_data: "action:cancel" }]] };
  await editMessage(chatId, messageId,
    `✏️ *Custom SOL range*\n\nSend your range in this format:\n\`min max\`\n\nExample: \`6.43 7.33\`\nExample: \`10 50\``,
    { reply_markup: keyboard }
  );
}

// ── Poll ──────────────────────────────────────────────────────
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

  if (data === "action:menu")      { pendingAction.delete(chatId); return showMainMenu(chatId, messageId); }
  if (data === "action:list")      return showWalletList(chatId, messageId);
  if (data === "action:chains")    return showChains(chatId, messageId);
  if (data === "action:solfilter") return showSolFilter(chatId, messageId);
  if (data === "action:cancel")    { pendingAction.delete(chatId); return showMainMenu(chatId, messageId); }
  if (data === "action:add")       return promptAddress(chatId, messageId, "add");
  if (data === "action:remove")    return promptAddress(chatId, messageId, "remove");
  if (data === "action:enable")    return promptAddress(chatId, messageId, "enable");
  if (data === "action:disable")   return promptAddress(chatId, messageId, "disable");

  // SOL filter presets
  if (data.startsWith("filter:")) {
    const parts = data.split(":");
    if (parts[1] === "custom") return promptSolFilter(chatId, messageId);
    const min = parseFloat(parts[1]);
    const max = parseFloat(parts[2]);
    setSolFilter(min, max);
    const label = max >= 999999 ? `> ${min} SOL` : `${min} — ${max} SOL`;
    await answerCallback(cb.id, `✅ Filter set: ${label}`);
    log.info("SOL filter updated", { min, max });
    return showSolFilter(chatId, messageId);
  }

  // Inline toggle
  if (data.startsWith("toggle:")) {
    const address = data.slice(7);
    setWalletActive(address, !isWalletActive(address));
    return showWalletList(chatId, messageId);
  }

  // Inline remove
  if (data.startsWith("remove:")) {
    const address = data.slice(7);
    _removeWallet(address);
    removeWalletStatus(address);
    return showWalletList(chatId, messageId);
  }
}

// ── Handle text messages ──────────────────────────────────────
async function handleMessage(msg) {
  if (!msg?.text) return;
  const chatId = msg.chat.id.toString();
  const text   = msg.text.trim();
  if (chatId !== CHAT_ID) { log.warn("Unauthorized chat", { chatId }); return; }

  if (text === "/start" || text === "/help") return showMainMenu(chatId);

  const action = pendingAction.get(chatId);
  if (action) {
    pendingAction.delete(chatId);
    if (action === "solfilter") await handleSolFilterInput(chatId, text);
    else await handleAddressInput(chatId, text, action);
    return;
  }

  await showMainMenu(chatId);
}

// ── Process address input ─────────────────────────────────────
async function handleAddressInput(chatId, address, action) {
  if (address.length < 32 || address.length > 44) {
    await send(chatId, `❌ Invalid address. Please try again.`);
    return showMainMenu(chatId);
  }
  if (action === "add") {
    const added = _addWallet(address);
    if (!added) await send(chatId, `⚠️ Already tracked: ${solscanLink(address)}`);
    else {
      setWalletActive(address, true);
      await _onWalletAdded(address);
      await send(chatId, `✅ *Wallet added* 🟢\n\n${solscanLink(address)}`);
    }
  } else if (action === "remove") {
    const removed = _removeWallet(address);
    if (!removed) await send(chatId, `⚠️ Not found: ${solscanLink(address)}`);
    else { removeWalletStatus(address); await send(chatId, `🗑 *Removed*\n\n${solscanLink(address)}`); }
  } else if (action === "enable") {
    if (!_getWatchedWallets().includes(address)) await send(chatId, `⚠️ Not tracked: ${solscanLink(address)}`);
    else { setWalletActive(address, true);  await send(chatId, `🟢 *Enabled*\n\n${solscanLink(address)}`); }
  } else if (action === "disable") {
    if (!_getWatchedWallets().includes(address)) await send(chatId, `⚠️ Not tracked: ${solscanLink(address)}`);
    else { setWalletActive(address, false); await send(chatId, `🔴 *Paused*\n\n${solscanLink(address)}`); }
  }
  await showMainMenu(chatId);
}

// ── Process SOL filter input ──────────────────────────────────
async function handleSolFilterInput(chatId, text) {
  const parts = text.trim().split(/\s+/);
  const min   = parseFloat(parts[0]);
  const max   = parseFloat(parts[1]);

  if (isNaN(min) || (parts[1] && isNaN(max))) {
    await send(chatId, `❌ Invalid format. Send like: \`6.43 7.33\` or just \`5\` for minimum only.`);
    return showMainMenu(chatId);
  }

  const finalMin = min;
  const finalMax = isNaN(max) ? 999999 : max;

  if (finalMax < finalMin) {
    await send(chatId, `❌ Max must be greater than min. Try again.`);
    return showMainMenu(chatId);
  }

  setSolFilter(finalMin, finalMax);
  const label = finalMax >= 999999 ? `> ${finalMin} SOL` : `${finalMin} — ${finalMax} SOL`;
  await send(chatId, `✅ *SOL filter updated*\n\n${label}`);
  log.info("SOL filter updated", { min: finalMin, max: finalMax });
  await showMainMenu(chatId);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }