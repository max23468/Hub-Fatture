import { randomUUID } from "node:crypto";

import { closePool } from "./db/client.server.ts";
import { importOrders } from "./db/order-import.server.ts";
import { AppError } from "./errors.ts";
import {
  claimJob,
  completeJob,
  failJob,
  markConnectionError,
  renewJobLease,
  scheduleDueSyncs,
} from "./db/connectors.server.ts";
import { previewEbayHistory, syncEbayOrders } from "./integrations/ebay.server.ts";
import { fetchShopifyOrder, syncShopifyOrders } from "./integrations/shopify.server.ts";

const workerId = randomUUID();
let stopping = false;

process.once("SIGTERM", () => (stopping = true));
process.once("SIGINT", () => (stopping = true));

async function runJob() {
  const job = await claimJob(workerId);
  if (!job) return false;
  const heartbeat = setInterval(() => {
    void renewJobLease(job).catch(() => undefined);
  }, 60_000);
  heartbeat.unref();
  try {
    if (job.type === "shopify_sync_orders") await syncShopifyOrders();
    if (job.type === "ebay_sync_orders") await syncEbayOrders();
    let result: Record<string, unknown> = {};
    if (job.type === "ebay_preview_history") result = await previewEbayHistory();
    if (job.type === "shopify_process_webhook") {
      const orderId = String(job.payload.orderId ?? "");
      if (!orderId) throw new AppError("PROVIDER_RESPONSE_INVALID", 422);
      await importOrders([await fetchShopifyOrder(orderId)], {
        type: "SYSTEM",
        requestId: `shopify-webhook:${job.id}`,
      });
    }
    await completeJob(job, result);
  } catch (error) {
    const appError = error instanceof AppError ? error : new AppError("PROVIDER_UNAVAILABLE", 503);
    const provider = job.type.startsWith("shopify") ? "SHOPIFY" : "EBAY";
    const terminal = await failJob(job, appError.code);
    if (terminal !== null) await markConnectionError(provider, appError.code, terminal);
    console.error(
      JSON.stringify({ event: "connector_job_failed", jobId: job.id, code: appError.code }),
    );
  } finally {
    clearInterval(heartbeat);
  }
  return true;
}

while (!stopping) {
  await scheduleDueSyncs();
  if (!(await runJob())) await new Promise((resolve) => setTimeout(resolve, 5_000));
}

await closePool();
