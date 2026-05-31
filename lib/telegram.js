import { createLogger } from "./logger.js";
import { isWalletActive, setWalletActive, removeWalletStatus } from "./walletStatus.js";
import { getSolFilter, setSolFilter } from "./solFilter.js";
import { setWalletName, getWalletName, removeWalletName } from "./walletNames.js";
const log = createLogger("telegram");

const TOKEN   = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
let offset    = 0;

// pendingAction: "add" | "add_name" | "remove" | "enable" | "disable" | "solfilter"
// pendingData:   stores temp data between steps (ex: address while waiting for name)
const pendingAction = new Map();
const pendingData   = new Map();

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
  const filterLabel = maxSol >= 999999 ? `⚙️ SOL filter: > ${minSol}` : `⚙️ SOL filter: ${minSol} — ${maxSol}`;
  const text     = `🤖 *Solana Snipe Bot*\n\nWhat do you want to do?`;
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
      [{ text: filterLabel, callback_data: "action:solfilter" }],
    ],
  };
  if (messageId) await editMessage(chatId, messageId, text, { reply_markup: keyboard });
  else await send(chatId, text, { reply_markup: keyboard });
}

// ── Wallet list ───────────────────────────────────────────────
async function showWalletList(chatId, messageId = null) {
  const wallets  = _getWatchedWallets();
  const back     = { inline_keyboard: [[{ text: "⬅️ Back", callback_data: "action:menu" }]] };
  if (!wallets.length) {
    const text = `📭 *No wallets tracked yet.*\n\nUse ➕ Add wallet to get started.`;
    if (messageId) await editMessage(chatId, messageId, text, { reply_markup: back });
    else await send(chatId, text, { reply_markup: back });
    return;
  }

  const lines = wallets.map((w, i) => {
    const active = isWalletActive(w);
    const name   = getWalletName(w);
    const label  = name ? ` *${name}*` : "";
    return `${active ? "🟢" : "🔴"} ${i+1}.${label} ${solscanLink(w)}`;
  });

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
    const name = getWalletName(c.rootWallet);
    const hops = c.hops.map(h => `  • ${solscanLink(h.from)}→${solscanLink(h.to)} (${h.solAmount.toFixed(3)} SOL)`).join("\n");
    return `*Chain ${i+1}*${name ? ` — ${name}` : ""} — ${c.hops.length} hop(s) — ${age}min ago\nRoot: ${solscanLink(c.rootWallet)}\n${hops}`;
  }).join("\n\n");
  const text = `🔗 *Active chains (${chains.length})*\n\n${lines}`;
  if (messageId) await editMessage(chatId, messageId, text, { reply_markup: keyboard });
  else await send(chatId, text, { reply_markup: keyboard });
}

// ── SOL filter ────────────────────────────────────────────────
async function showSolFilter(chatId, messageId = null) {
  const { minSol, maxSol } = getSolFilter();
  const current  = maxSol >= 999999 ? `Current: *> ${minSol} SOL* (no max)` : `Current: *${minSol} — ${maxSol} SOL*`;
  const text     = `⚙️ *SOL Transfer Filter*\n\n${current}\n\nChoose a preset or set a custom range:`;
  const keyboard = {
    inline_keyboard: [
      [{ text: "1 — 5 SOL",    callback_data: "filter:1:5" },   { text: "5 — 10 SOL",   callback_data: "filter:5:10" }],
      [{ text: "10 — 50 SOL",  callback_data: "filter:10:50" }, { text: "50 — 100 SOL", callback_data: "filter:50:100" }],
      [{ text: "✏️ Custom range", callback_data: "filter:custom" }, { text: "♾ No limit", callback_data: "filter:0:999999" }],
      [{ text: "⬅️ Back", callback_data: "action:menu" }],
    ],
  };
  if (messageId) await editMessage(chatId, messageId, text, { reply_markup: keyboard });
  else await send(chatId, text, { reply_markup: keyboard });
}

// ── Prompts ───────────────────────────────────────────────────
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

async function promptName(chatId, address) {
  pendingAction.set(chatId, "add_name");
  pendingData.set(chatId, address);
  const keyboard = { inline_keyboard: [[{ text: "⏭ Skip", callback_data: "action:skip_name" }]] };
  await send(chatId,
    `✅ *Address saved*\n\n${solscanLink(address)}\n\n📋 *Name this wallet*\n\nEnter the exact name of your TradeWiz copy trade config:\n_(example: Whale1, Alpha, etc.)_`,
    { reply_markup: keyboard }
  );
}

async function promptSolFilter(chatId, messageId) {
  pendingAction.set(chatId, "solfilter");
  const keyboard = { inline_keyboard: [[{ text: "❌ Cancel", callback_data: "action:cancel" }]] };
  await editMessage(chatId, messageId,
    `✏️ *Custom SOL range*\n\nSend your range:\n\`min max\`\n\nExamples:\n\`6.43 7.33\`\n\`10 50\`\n\`5\` _(min only, no max)_`,
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

  if (data === "action:menu")      { pendingAction.delete(chatId); pendingData.delete(chatId); return showMainMenu(chatId, messageId); }
  if (data === "action:list")      return showWalletList(chatId, messageId);
  if (data === "action:chains")    return showChains(chatId, messageId);
  if (data === "action:solfilter") return showSolFilter(chatId, messageId);
  if (data === "action:cancel")    { pendingAction.delete(chatId); pendingData.delete(chatId); return showMainMenu(chatId, messageId); }
  if (data === "action:add")       return promptAddress(chatId, messageId, "add");
  if (data === "action:remove")    return promptAddress(chatId, messageId, "remove");
  if (data === "action:enable")    return promptAddress(chatId, messageId, "enable");
  if (data === "action:disable")   return promptAddress(chatId, messageId, "disable");

  // Skip name
  if (data === "action:skip_name") {
    const address = pendingData.get(chatId);
    pendingAction.delete(chatId);
    pendingData.delete(chatId);
    if (address) {
      setWalletActive(address, true);
      await _onWalletAdded(address);
      await send(chatId, `✅ *Wallet added* 🟢\n\n${solscanLink(address)}\n\n_No copy trade linked._`);
    }
    return showMainMenu(chatId);
  }

  // SOL filter presets
  if (data.startsWith("filter:")) {
    const parts = data.split(":");
    if (parts[1] === "custom") return promptSolFilter(chatId, messageId);
    const min = parseFloat(parts[1]);
    const max = parseFloat(parts[2]);
    setSolFilter(min, max);
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
    removeWalletName(address);
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
    if (action === "solfilter")  await handleSolFilterInput(chatId, text);
    else if (action === "add_name") await handleNameInput(chatId, text);
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
    if (!added) {
      await send(chatId, `⚠️ Already tracked: ${solscanLink(address)}`);
      return showMainMenu(chatId);
    }
    // Ask for copy trade name before finishing
    return promptName(chatId, address);
  }

  if (action === "remove") {
    const removed = _removeWallet(address);
    if (!removed) await send(chatId, `⚠️ Not found: ${solscanLink(address)}`);
    else { removeWalletStatus(address); removeWalletName(address); await send(chatId, `🗑 *Removed*\n\n${solscanLink(address)}`); }
  } else if (action === "enable") {
    if (!_getWatchedWallets().includes(address)) await send(chatId, `⚠️ Not tracked: ${solscanLink(address)}`);
    else { setWalletActive(address, true);  await send(chatId, `🟢 *Enabled*\n\n${solscanLink(address)}`); }
  } else if (action === "disable") {
    if (!_getWatchedWallets().includes(address)) await send(chatId, `⚠️ Not tracked: ${solscanLink(address)}`);
    else { setWalletActive(address, false); await send(chatId, `🔴 *Paused*\n\n${solscanLink(address)}`); }
  }

  await showMainMenu(chatId);
}

// ── Process copy trade name input ─────────────────────────────
async function handleNameInput(chatId, name) {
  const address = pendingData.get(chatId);
  pendingData.delete(chatId);

  if (!address) return showMainMenu(chatId);

  setWalletName(address, name);
  setWalletActive(address, true);
  await _onWalletAdded(address);

  await send(chatId, [
    `✅ *Wallet added* 🟢`,
    ``,
    `${solscanLink(address)}`,
    `📋 *Copy trade:* \`${name}\``,
    ``,
    `When this wallet triggers a launch, TradeWiz will use the *${name}* config.`,
  ].join("\n"));

  await showMainMenu(chatId);
}

// ── Process SOL filter input ──────────────────────────────────
async function handleSolFilterInput(chatId, text) {
  const parts    = text.trim().split(/\s+/);
  const min      = parseFloat(parts[0]);
  const max      = parseFloat(parts[1]);
  if (isNaN(min)) {
    await send(chatId, `❌ Invalid format. Example: \`6.43 7.33\` or \`5\``);
    return showMainMenu(chatId);
  }
  const finalMax = isNaN(max) ? 999999 : max;
  if (finalMax < min) {
    await send(chatId, `❌ Max must be greater than min.`);
    return showMainMenu(chatId);
  }
  setSolFilter(min, finalMax);
  const label = finalMax >= 999999 ? `> ${min} SOL` : `${min} — ${finalMax} SOL`;
  await send(chatId, `✅ *SOL filter updated*\n\n${label}`);
  log.info("SOL filter updated", { min, max: finalMax });
  await showMainMenu(chatId);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }