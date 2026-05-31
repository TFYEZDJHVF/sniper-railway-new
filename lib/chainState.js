import { createLogger } from "./logger.js";
const log = createLogger("chainState");

const chains = new Map();
const index  = new Map();
let watched  = new Set();

export function initWatchedWallets(arr) {
  watched = new Set(arr.map(w => w.trim()).filter(Boolean));
  log.info(`Watching ${watched.size} wallet(s)`);
}

export function getWatchedWallets() { return [...watched]; }

export function addWallet(address) {
  if (watched.has(address)) return false;
  watched.add(address);
  log.info("Wallet added", { address: address.slice(0,8) });
  return true;
}

export function removeWallet(address) {
  if (!watched.has(address)) return false;
  watched.delete(address);
  const root = index.get(address);
  if (root) {
    const chain = chains.get(root);
    if (chain) { for (const w of chain.wallets) index.delete(w); chains.delete(root); }
  }
  log.info("Wallet removed", { address: address.slice(0,8) });
  return true;
}

export function getActiveChains() { return [...chains.values()]; }

export function isInChain(address) { return index.has(address); }

export function registerTransfer({ from, to, solAmount, signature, timestamp }) {
  let root = index.get(from);
  if (!root && watched.has(from)) {
    root = from;
    chains.set(root, { rootWallet: root, startedAt: timestamp, hops: [], wallets: new Set([from]), sniped: false });
    index.set(from, root);
    log.info("New chain started", { root: root.slice(0,8) });
  }
  if (!root) return null;
  const chain = chains.get(root);
  if (!chain || chain.sniped) return null;
  chain.hops.push({ from, to, solAmount, signature, timestamp });
  chain.wallets.add(to);
  index.set(to, root);
  log.info("Chain extended", { root: root.slice(0,8), hops: chain.hops.length, to: to.slice(0,8), sol: solAmount.toFixed(3) });
  return chain;
}

export function getChainForWallet(addr) {
  const root = index.get(addr);
  return root ? (chains.get(root) || null) : null;
}

export function markChainSniped(rootWallet) {
  const chain = chains.get(rootWallet);
  if (!chain) return;
  chain.sniped = true;
  for (const w of chain.wallets) index.delete(w);
  chains.delete(rootWallet);
  log.info("Chain sniped & cleared", { root: rootWallet.slice(0,8) });
}

// Purge chains older than 30min
setInterval(() => {
  const now = Date.now() / 1000;
  let n = 0;
  for (const [root, chain] of chains) {
    if ((now - chain.startedAt) > 1800) {
      for (const w of chain.wallets) index.delete(w);
      chains.delete(root);
      n++;
    }
  }
  if (n > 0) log.info(`Purged ${n} stale chain(s)`);
}, 600_000);
