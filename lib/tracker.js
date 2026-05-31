import { createLogger } from "./logger.js";
const log = createLogger("tracker");

const PUMP_FUN = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const WSOL     = "So11111111111111111111111111111111111111112";
const LAMPORTS = 1_000_000_000;

export function parseNativeTransfers(tx) {
  if (!tx.nativeTransfers) return [];
  return tx.nativeTransfers
    .map(t => ({
      from:      t.fromUserAccount,
      to:        t.toUserAccount,
      solAmount: t.amount / LAMPORTS,
      signature: tx.signature,
      timestamp: tx.timestamp || Math.floor(Date.now() / 1000),
    }))
    .filter(t => t.solAmount > 0);
}

export function detectPumpFunLaunch(tx) {
  try {
    let found = false;
    outer:
    for (const ix of tx.instructions || []) {
      if (ix.programId === PUMP_FUN) { found = true; break; }
      for (const inner of ix.innerInstructions || []) {
        if (inner.programId === PUMP_FUN) { found = true; break outer; }
      }
    }
    if (!found) return null;

    let mint = null;
    for (const t of tx.tokenTransfers || []) {
      if (t.mint && t.mint !== WSOL) { mint = t.mint; break; }
    }
    if (!mint) {
      for (const acc of tx.accountData || []) {
        for (const c of acc.tokenBalanceChanges || []) {
          if (c.mint && c.mint !== WSOL) { mint = c.mint; break; }
        }
        if (mint) break;
      }
    }
    if (!mint) { log.warn("Pump.fun tx but no mint found", { sig: tx.signature }); return null; }

    return {
      mint,
      solAmount: (tx.nativeTransfers || []).reduce((s, t) => s + t.amount, 0) / LAMPORTS,
      signature: tx.signature,
      timestamp: tx.timestamp || Math.floor(Date.now() / 1000),
      feePayer:  tx.feePayer,
      dex:       "Pump.fun",
    };
  } catch (e) {
    log.error("detectPumpFunLaunch failed", { error: e.message });
    return null;
  }
}
