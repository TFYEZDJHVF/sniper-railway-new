import { createLogger } from "./logger.js";
const log = createLogger("helius");
const BASE = "https://api.helius.xyz/v0";

async function req(path, method = "GET", body = null) {
  const res = await fetch(`${BASE}${path}?api-key=${process.env.HELIUS_API_KEY}`, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) throw new Error(`Helius ${res.status}: ${await res.text()}`);
  return res.json();
}

export async function upsertWebhook(walletAddresses) {
  const id      = process.env.HELIUS_WEBHOOK_ID;
  const payload = {
    webhookURL:       process.env.HELIUS_WEBHOOK_URL,
    transactionTypes: ["TRANSFER", "SWAP"],
    accountAddresses: walletAddresses,
    webhookType:      "enhanced",
  };
  if (id) {
    log.info("Updating webhook", { id, wallets: walletAddresses.length });
    return req(`/webhooks/${id}`, "PUT", payload);
  }
  log.info("Creating webhook", { wallets: walletAddresses.length });
  const result = await req("/webhooks", "POST", payload);
  log.info("Webhook created — save as HELIUS_WEBHOOK_ID", { id: result.webhookID });
  return result;
}

export async function addWalletsToWebhook(newWallets) {
  const id = process.env.HELIUS_WEBHOOK_ID;
  if (!id) { log.warn("No HELIUS_WEBHOOK_ID, skipping"); return; }
  try {
    const current  = await req(`/webhooks/${id}`);
    const existing = new Set(current.accountAddresses || []);
    const toAdd    = newWallets.filter(w => !existing.has(w));
    if (!toAdd.length) return;
    await req(`/webhooks/${id}`, "PUT", { ...current, accountAddresses: [...existing, ...toAdd] });
    log.info("Wallets added to webhook", { count: toAdd.length });
  } catch (e) {
    log.error("addWalletsToWebhook failed", { error: e.message });
  }
}
