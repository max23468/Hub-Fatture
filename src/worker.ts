import { randomUUID } from "node:crypto";

import { closePool } from "./db/client.server.ts";
import { importOrders } from "./db/order-import.server.ts";
import { AppError } from "./errors.ts";
import {
  claimJob,
  completeJob,
  failJob,
  jobLeaseCurrent,
  renewJobLease,
  scheduleDueSyncs,
  scheduleRetention,
  yieldJob,
} from "./db/connector-jobs.server.ts";
import { historyImportPending, markConnectionError } from "./db/connector-connections.server.ts";
import {
  importEbayHistory,
  previewEbayHistory,
  syncEbayOrders,
} from "./integrations/ebay.server.ts";
import { fetchShopifyOrder, syncShopifyOrders } from "./integrations/shopify.server.ts";
import { processRefund } from "./db/refunds.server.ts";
import { sendCustomerEmail } from "./db/email.server.ts";
import {
  markArubaApiConnectionError,
  runArubaApiInboundJob,
} from "./db/aruba-api-inbound.server.ts";
import { runArubaApiOutboundJob } from "./db/aruba-api-outbound.server.ts";
import { runArubaApiReadbackJob } from "./db/aruba-api-readback.server.ts";
import { refreshOperationalControls } from "./db/operational-controls.server.ts";
import { applyRetentionPolicy } from "./db/retention.server.ts";

const workerId = randomUUID();
let stopping = false;
let controlsRefreshRequested = false;
let controlsRefreshPromise: Promise<void> | null = null;

process.once("SIGTERM", () => (stopping = true));
process.once("SIGINT", () => (stopping = true));

async function refreshOperationalControlsUntilCurrent() {
  controlsRefreshRequested = false;
  await refreshOperationalControls();
  if (controlsRefreshRequested) await refreshOperationalControlsUntilCurrent();
}

function scheduleOperationalControlsRefresh() {
  controlsRefreshRequested = true;
  if (controlsRefreshPromise) return;
  controlsRefreshPromise = refreshOperationalControlsUntilCurrent()
    .catch(() => {
      console.error(JSON.stringify({ event: "operational_controls_refresh_failed" }));
    })
    .finally(() => {
      controlsRefreshPromise = null;
      if (controlsRefreshRequested) scheduleOperationalControlsRefresh();
    });
}

async function waitForOperationalControlsRefresh() {
  const currentRefresh = controlsRefreshPromise;
  if (!currentRefresh) return;
  await currentRefresh;
  if (controlsRefreshPromise) await waitForOperationalControlsRefresh();
}

async function runJob() {
  const job = await claimJob(workerId);
  if (!job) return false;
  const heartbeat = setInterval(() => {
    void renewJobLease(job).catch(() => {
      console.error(JSON.stringify({ event: "connector_job_heartbeat_failed", jobId: job.id }));
    });
  }, 60_000);
  heartbeat.unref();
  const assertLease = async () => {
    if (!(await jobLeaseCurrent(job))) {
      throw new AppError("CONFLICT_REVISION", 409);
    }
  };
  try {
    await assertLease();
    if (job.type === "shopify_sync_orders") await syncShopifyOrders(job);
    if (job.type === "ebay_sync_orders") await syncEbayOrders(job);
    let result: Record<string, unknown> = {};
    if (job.type === "ebay_preview_history") {
      result =
        job.payload.mode === "IMPORT"
          ? await importEbayHistory(
              job.payload.startDate,
              { type: "SYSTEM", requestId: `ebay-history:${job.id}` },
              job,
            )
          : await previewEbayHistory(job.payload.startDate);
    }
    if (job.type === "process_refund") {
      await processRefund(String(job.payload.refundId ?? ""), job);
    }
    if (job.type === "maintenance_retention") {
      try {
        result = await applyRetentionPolicy();
      } catch {
        throw new AppError("RETENTION_FAILED", 503);
      }
    }
    if (job.type === "send_customer_email") await sendCustomerEmail(job);
    if (job.type === "aruba_readback_submission") {
      result = await runArubaApiReadbackJob(job);
    } else if (job.type === "aruba_dry_run_submission" || job.type === "aruba_send_submission") {
      result = await runArubaApiOutboundJob(job);
    } else if (job.type.startsWith("aruba_")) {
      result = await runArubaApiInboundJob(job);
    }
    if (job.type === "shopify_process_webhook") {
      const orderId = String(job.payload.orderId ?? "");
      if (!orderId) throw new AppError("PROVIDER_RESPONSE_INVALID", 422);
      const order = await fetchShopifyOrder(orderId);
      if (job.payload.historical !== false || (await historyImportPending("SHOPIFY"))) {
        order.historical = true;
      }
      await assertLease();
      await importOrders(
        [order],
        {
          type: "SYSTEM",
          requestId: `shopify-webhook:${job.id}`,
        },
        job,
      );
    }
    await assertLease();
    if (result.continuationPending === true) {
      const delayMs =
        typeof result.continuationDelayMs === "number" ? result.continuationDelayMs : 1_000;
      if (!(await yieldJob(job, result, delayMs))) throw new AppError("CONFLICT_REVISION", 409);
      return true;
    }
    if (!(await completeJob(job, result))) throw new AppError("CONFLICT_REVISION", 409);
  } catch (error) {
    const appError = error instanceof AppError ? error : new AppError("PROVIDER_UNAVAILABLE", 503);
    const terminal = await failJob(job, appError.code);
    const provider = job.type.startsWith("shopify")
      ? "SHOPIFY"
      : job.type.startsWith("ebay")
        ? "EBAY"
        : job.type.startsWith("aruba_")
          ? "ARUBA"
          : null;
    if ((provider === "SHOPIFY" || provider === "EBAY") && terminal !== null) {
      await markConnectionError(provider, appError.code, terminal);
    }
    if (provider === "ARUBA" && terminal !== null) {
      await markArubaApiConnectionError(appError.code, terminal);
    }
    console.error(
      JSON.stringify({ event: "connector_job_failed", jobId: job.id, code: appError.code }),
    );
  } finally {
    clearInterval(heartbeat);
    scheduleOperationalControlsRefresh();
  }
  return true;
}

while (!stopping) {
  await Promise.all([scheduleDueSyncs(), scheduleRetention()]);
  if (!(await runJob())) await new Promise((resolve) => setTimeout(resolve, 5_000));
}

await waitForOperationalControlsRefresh();
await closePool();
