/**
 * lib/solFilter.js
 * SOL transfer range filter — user configurable via Telegram
 * Only transfers between MIN and MAX SOL trigger chain tracking
 */

let minSol = parseFloat(process.env.MIN_SOL_THRESHOLD || "0.1");
let maxSol = parseFloat(process.env.MAX_SOL_THRESHOLD || "999999");

export function getSolFilter() { return { minSol, maxSol }; }

export function setSolFilter(min, max) {
  minSol = min;
  maxSol = max;
}

export function passesFilter(solAmount) {
  return solAmount >= minSol && solAmount <= maxSol;
}