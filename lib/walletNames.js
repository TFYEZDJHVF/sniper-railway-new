/**
 * lib/walletNames.js
 * Maps wallet addresses to user-defined names
 * Name = TradeWiz copy trade name
 */

const names = new Map(); // address → name

export function setWalletName(address, name) {
  names.set(address, name.trim());
}

export function getWalletName(address) {
  return names.get(address) || null;
}

export function removeWalletName(address) {
  names.delete(address);
}

export function getAllNames() {
  return Object.fromEntries(names);
}