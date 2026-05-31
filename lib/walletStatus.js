const statusMap = new Map(); // address → true (active) | false (paused)

export function setWalletActive(address, active) { statusMap.set(address, active); }
export function isWalletActive(address) {
  if (!statusMap.has(address)) return true; // active by default
  return statusMap.get(address);
}
export function removeWalletStatus(address) { statusMap.delete(address); }
