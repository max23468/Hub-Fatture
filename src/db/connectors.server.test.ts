import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { closePool, getPool, withTransaction } from "./client.server.ts";
import { temporaryDatabase } from "./database-fixture.ts";
import { runMigrations } from "./migrations.server.ts";
import { importOrders } from "./order-import.server.ts";
import { AppError } from "../errors.ts";
import { mapShopifyOrder, processShopifyWebhook } from "../integrations/shopify.server.ts";

test("connessioni cifrate, webhook duplicati e lease dei job restano idempotenti", async () => {
  const database = await temporaryDatabase("connectors");
  process.env.DATABASE_URL = database.connectionString;
  process.env.ADMIN_BOOTSTRAP_TOKEN = "x".repeat(32);
  process.env.APP_BASE_URL = "http://localhost:8080";
  process.env.APP_ENV = "test";
  process.env.EBAY_ENVIRONMENT = "sandbox";
  process.env.CREDENTIALS_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64url");
  process.env.SHOPIFY_API_KEY = "shopify-key-sintetica";
  process.env.SHOPIFY_API_SECRET = "shopify-secret-sintetico";
  process.env.SHOPIFY_SHOP = "shop.example.invalid";

  try {
    await runMigrations({ connectionString: database.connectionString });
    const connectors = await import("./connectors.server.ts");
    const systemActor = { type: "SYSTEM" as const, requestId: "connector-test" };
    await connectors.saveConnection(
      {
        provider: "SHOPIFY",
        environment: "DEVELOPMENT",
        accountReference: "shop.example.invalid",
        credentials: { accessToken: "token-sintetico" },
      },
      systemActor,
    );
    assert.deepEqual(
      (await connectors.loadConnection<{ accessToken: string }>("SHOPIFY")).credentials,
      { accessToken: "token-sintetico" },
    );
    assert.equal(await connectors.historyImportPending("SHOPIFY"), true);
    await connectors.scheduleDueSyncs();
    assert.equal(
      (
        await getPool().query(
          "SELECT count(*)::int AS total FROM jobs WHERE type = 'shopify_sync_orders'",
        )
      ).rows[0].total,
      0,
    );
    assert.deepEqual(
      await importOrders([], { type: "SYSTEM", requestId: "shopify-history-empty" }),
      { imported: 0, updated: 0, ignored: 0 },
    );
    await connectors.completeHistoryImport(
      "SHOPIFY",
      "shop.example.invalid",
      "2026-08-12T10:00:00Z",
      "2026-08-12T09:55:00Z",
    );
    assert.equal(await connectors.historyImportPending("SHOPIFY"), false);
    assert.equal(
      (await connectors.connectionSummaries()).find(({ provider }) => provider === "SHOPIFY")
        ?.historyImported,
      true,
    );
    await getPool().query(
      `UPDATE connections SET last_synced_at = now() - interval '11 minutes'
       WHERE provider = 'SHOPIFY' AND environment = 'DEVELOPMENT'`,
    );
    await connectors.scheduleDueSyncs();
    assert.equal(
      (
        await getPool().query(
          "SELECT count(*)::int AS total FROM jobs WHERE type = 'shopify_sync_orders'",
        )
      ).rows[0].total,
      1,
    );
    await getPool().query("DELETE FROM jobs WHERE type = 'shopify_sync_orders'");
    await connectors.saveConnection(
      {
        provider: "EBAY",
        environment: "PRODUCTION",
        accountReference: "produzione-sintetica",
        credentials: { refreshToken: "token-produzione-sintetico" },
      },
      systemActor,
    );
    await connectors.saveConnection(
      {
        provider: "EBAY",
        environment: "SANDBOX",
        accountReference: "sandbox-sintetica",
        credentials: { refreshToken: "token-sandbox-sintetico" },
      },
      systemActor,
    );
    await getPool().query(
      `UPDATE connections SET created_at = '2026-08-01T10:00:00Z'
       WHERE provider = 'EBAY' AND environment = 'SANDBOX'`,
    );
    await connectors.saveConnection(
      {
        provider: "EBAY",
        environment: "SANDBOX",
        accountReference: "sandbox-sintetica",
        credentials: { refreshToken: "token-sandbox-rinnovato" },
      },
      systemActor,
    );
    assert.equal(
      (await connectors.connectionSummaries()).find(({ provider }) => provider === "EBAY")
        ?.connectedAt,
      "2026-08-01T10:00:00.000Z",
    );
    assert.equal((await connectors.loadConnection("EBAY")).accountReference, "sandbox-sintetica");
    await connectors.markConnectionSynced("EBAY");
    await connectors.writeCursor("EBAY", "cursor-sintetico", "2026-08-01T00:00:00Z");
    assert.equal(await connectors.historyImportPending("EBAY"), true);
    await getPool().query(
      `UPDATE connections SET last_synced_at = now() - interval '11 minutes'
       WHERE provider = 'EBAY' AND environment = 'SANDBOX'`,
    );
    await connectors.scheduleDueSyncs();
    assert.equal(
      (
        await getPool().query(
          "SELECT count(*)::int AS total FROM jobs WHERE type = 'ebay_sync_orders'",
        )
      ).rows[0].total,
      0,
    );
    assert.deepEqual(await importOrders([], { type: "SYSTEM", requestId: "ebay-history-empty" }), {
      imported: 0,
      updated: 0,
      ignored: 0,
    });
    await connectors.completeHistoryImport(
      "EBAY",
      "sandbox-sintetica",
      "2026-08-12T10:00:00Z",
      "2026-08-12T09:55:00Z",
    );
    assert.equal(await connectors.historyImportPending("EBAY"), false);
    await getPool().query("DELETE FROM jobs WHERE type = 'shopify_sync_orders'");
    await connectors.saveConnection(
      {
        provider: "EBAY",
        environment: "SANDBOX",
        accountReference: "sandbox-sintetica",
        credentials: { refreshToken: "token-sandbox-rinnovato" },
      },
      systemActor,
    );
    assert.equal((await connectors.readCursor("EBAY")).cursor, "2026-08-12T10:00:00Z");
    assert.ok(
      (
        await getPool().query(
          "SELECT last_synced_at FROM connections WHERE provider = 'EBAY' AND environment = 'SANDBOX'",
        )
      ).rows[0].last_synced_at,
    );
    await connectors.enqueueJob("ebay_sync_orders");
    const obsoleteSyncJob = await connectors.claimJob("worker-obsolete-account");
    assert.equal(obsoleteSyncJob?.type, "ebay_sync_orders");
    await connectors.saveConnection(
      {
        provider: "EBAY",
        environment: "SANDBOX",
        accountReference: "sandbox-sostitutiva",
        credentials: { refreshToken: "token-sandbox-sostitutivo" },
      },
      systemActor,
    );
    assert.deepEqual(
      (
        await getPool().query("SELECT status, result_json FROM jobs WHERE id = $1", [
          obsoleteSyncJob!.id,
        ])
      ).rows[0],
      { status: "COMPLETED", result_json: { obsoleteAccount: true } },
    );
    assert.equal(await connectors.failJob(obsoleteSyncJob!, "CONFLICT_REVISION"), null);
    assert.equal(
      (
        await getPool().query(
          "SELECT status FROM connections WHERE provider = 'EBAY' AND environment = 'SANDBOX'",
        )
      ).rows[0].status,
      "CONNECTED",
    );
    await getPool().query("DELETE FROM jobs WHERE id = $1", [obsoleteSyncJob!.id]);
    assert.notEqual(
      (await connectors.connectionSummaries()).find(({ provider }) => provider === "EBAY")
        ?.connectedAt,
      "2026-08-01T10:00:00.000Z",
    );
    assert.equal((await connectors.readCursor("EBAY")).cursor, null);
    assert.equal(await connectors.historyImportPending("EBAY"), true);
    await assert.rejects(
      connectors.completeHistoryImport(
        "EBAY",
        "sandbox-sintetica",
        "2026-08-12T11:00:00Z",
        "2026-08-12T10:55:00Z",
      ),
      (error: unknown) => error instanceof AppError && error.code === "CONFLICT_REVISION",
    );
    assert.equal(await connectors.historyImportPending("EBAY"), true);
    assert.equal(
      (
        await getPool().query(
          "SELECT last_synced_at FROM connections WHERE provider = 'EBAY' AND environment = 'SANDBOX'",
        )
      ).rows[0].last_synced_at,
      null,
    );
    await assert.rejects(
      importOrders([], { type: "SYSTEM", requestId: "ebay-history-obsolete-account" }, undefined, {
        provider: "EBAY",
        accountReference: "sandbox-sintetica",
        cursor: "2026-08-12T11:00:00Z",
        overlapFrom: "2026-08-12T10:55:00Z",
        count: 0,
        reviewRequired: 0,
      }),
      (error: unknown) => error instanceof AppError && error.code === "CONFLICT_REVISION",
    );
    await connectors.enqueueEbayHistory("2026-08-05", "IMPORT");
    const staleHistoryJob = await connectors.claimJob("worker-history-stale");
    assert.deepEqual(staleHistoryJob?.payload, {
      startDate: "2026-08-05",
      mode: "IMPORT",
      accountReference: "sandbox-sostitutiva",
    });
    await getPool().query(
      `UPDATE connections SET account_reference = 'sandbox-risultante'
       WHERE provider = 'EBAY' AND environment = 'SANDBOX'`,
    );
    const { importEbayHistory } = await import("../integrations/ebay.server.ts");
    assert.deepEqual(
      await importEbayHistory(
        "2026-08-05",
        { type: "SYSTEM", requestId: `ebay-history:${staleHistoryJob!.id}` },
        staleHistoryJob!,
      ),
      { count: 0, reviewRequired: 0, imported: 0, updated: 0, ignored: 0 },
    );
    assert.equal(await connectors.historyImportPending("EBAY"), true);
    assert.equal(await connectors.completeJob(staleHistoryJob!), true);
    await getPool().query("DELETE FROM jobs WHERE id = $1", [staleHistoryJob!.id]);
    await connectors.enqueueEbayHistory("2026-08-05", "IMPORT");
    const historyJob = await connectors.claimJob("worker-history-import");
    assert.equal(historyJob?.type, "ebay_preview_history");
    assert.equal(historyJob?.payload.accountReference, "sandbox-risultante");
    assert.deepEqual(
      await importOrders(
        [],
        { type: "SYSTEM", requestId: `ebay-history:${historyJob!.id}` },
        historyJob!,
        {
          provider: "EBAY",
          accountReference: "sandbox-risultante",
          cursor: "2026-08-12T11:00:00Z",
          overlapFrom: "2026-08-12T10:55:00Z",
          count: 0,
          reviewRequired: 0,
        },
      ),
      { imported: 0, updated: 0, ignored: 0 },
    );
    await getPool().query(
      "UPDATE jobs SET lease_expires_at = now() - interval '1 second' WHERE id = $1",
      [historyJob!.id],
    );
    const resumedHistoryJob = await connectors.claimJob("worker-history-resume");
    assert.equal(resumedHistoryJob?.id, historyJob!.id);
    assert.deepEqual(await connectors.completedHistoryImportResult("EBAY", resumedHistoryJob!), {
      count: 0,
      reviewRequired: 0,
      imported: 0,
      updated: 0,
      ignored: 0,
    });
    assert.equal(await connectors.completeJob(resumedHistoryJob!), true);
    const completedHistoryJobs = (
      await getPool().query(
        "SELECT count(*)::int AS total FROM jobs WHERE type = 'ebay_preview_history'",
      )
    ).rows[0].total;
    await connectors.enqueueEbayHistory("2026-08-05", "IMPORT");
    assert.equal(
      (
        await getPool().query(
          "SELECT count(*)::int AS total FROM jobs WHERE type = 'ebay_preview_history'",
        )
      ).rows[0].total,
      completedHistoryJobs,
    );
    await getPool().query("DELETE FROM jobs WHERE id = $1", [historyJob!.id]);
    await getPool().query("DELETE FROM sync_cursors WHERE provider = 'EBAY'");
    await getPool().query(
      `UPDATE connections SET last_synced_at = NULL
       WHERE provider = 'EBAY' AND environment = 'SANDBOX'`,
    );
    const stored = await getPool().query<{ encrypted_credentials: string }>(
      "SELECT encrypted_credentials FROM connections",
    );
    assert.equal(stored.rows[0]!.encrypted_credentials.includes("token-sintetico"), false);

    const first = await connectors.ingestShopifyWebhook({
      externalEventId: "event-1",
      topic: "ORDERS_UPDATED",
      payloadSha256: "a".repeat(64),
      orderId: "gid://shopify/Order/1",
    });
    const duplicate = await connectors.ingestShopifyWebhook({
      externalEventId: "event-1",
      topic: "ORDERS_UPDATED",
      payloadSha256: "a".repeat(64),
      orderId: "gid://shopify/Order/1",
    });
    assert.equal(first.duplicate, false);
    assert.equal(duplicate.duplicate, true);
    await assert.rejects(
      connectors.ingestShopifyWebhook({
        externalEventId: "event-1",
        topic: "ORDERS_UPDATED",
        payloadSha256: "b".repeat(64),
        orderId: "gid://shopify/Order/1",
      }),
      (error) => error instanceof AppError && error.code === "PROVIDER_RESPONSE_INVALID",
    );
    assert.equal((await getPool().query("SELECT * FROM jobs")).rowCount, 1);

    const claimed = await connectors.claimJob("worker-1");
    assert.ok(claimed);
    await withTransaction(async (client) => {
      await connectors.assertJobLease(client, claimed);
      await client.query(
        "UPDATE jobs SET lease_expires_at = now() - interval '1 second' WHERE id = $1",
        [claimed.id],
      );
      await client.query("SELECT pg_sleep(0.02)");
      await connectors.renewLockedJobLease(client, claimed);
      const renewed = await client.query<{ current_at_commit: boolean }>(
        `SELECT lease_expires_at > now() + interval '2 minutes' AS current_at_commit
         FROM jobs WHERE id = $1`,
        [claimed.id],
      );
      assert.equal(renewed.rows[0]?.current_at_commit, true);
    });
    assert.equal(await connectors.jobLeaseCurrent(claimed), true);
    await getPool().query(
      "UPDATE jobs SET lease_expires_at = now() - interval '1 second' WHERE id = $1",
      [claimed.id],
    );
    const recovered = await connectors.claimJob("worker-2");
    assert.equal(recovered?.id, claimed.id);
    assert.equal(recovered?.attempts, 2);
    assert.equal(await connectors.jobLeaseCurrent(claimed), false);
    assert.equal(await connectors.jobLeaseCurrent(recovered!), true);
    await assert.rejects(
      connectors.writeCursor("SHOPIFY", "obsoleto", "2026-08-01T00:00:00Z", claimed),
      (error) => error instanceof AppError && error.code === "CONFLICT_REVISION",
    );
    await assert.rejects(
      connectors.markConnectionSynced("SHOPIFY", claimed),
      (error) => error instanceof AppError && error.code === "CONFLICT_REVISION",
    );
    assert.equal(await connectors.completeJob(claimed), false);
    assert.equal(await connectors.failJob(claimed, "PROVIDER_UNAVAILABLE"), null);
    assert.equal(await connectors.renewJobLease(recovered!), true);
    await connectors.completeJob(recovered!);
    assert.equal(
      (await getPool().query("SELECT status FROM webhook_events")).rows[0].status,
      "PROCESSED",
    );
    await connectors.ingestShopifyWebhook({
      externalEventId: "event-account-obsoleto",
      topic: "ORDERS_UPDATED",
      payloadSha256: "e".repeat(64),
      orderId: "gid://shopify/Order/2",
    });
    const obsoleteWebhookJob = await connectors.claimJob("worker-obsolete-webhook");
    assert.equal(obsoleteWebhookJob?.type, "shopify_process_webhook");
    await connectors.saveConnection(
      {
        provider: "SHOPIFY",
        environment: "DEVELOPMENT",
        accountReference: "shop-sostitutivo.example.invalid",
        credentials: { accessToken: "token-shopify-sostitutivo" },
      },
      systemActor,
    );
    assert.deepEqual(
      (
        await getPool().query(
          `SELECT jobs.status, jobs.result_json, webhook_events.status AS event_status
           FROM jobs JOIN webhook_events
             ON webhook_events.id = (jobs.payload_json ->> 'webhookEventId')::bigint
           WHERE jobs.id = $1`,
          [obsoleteWebhookJob!.id],
        )
      ).rows[0],
      {
        status: "COMPLETED",
        result_json: { obsoleteAccount: true },
        event_status: "PROCESSED",
      },
    );
    assert.equal(await connectors.failJob(obsoleteWebhookJob!, "CONFLICT_REVISION"), null);

    const webhookBody = Buffer.from(JSON.stringify({ id: 123 }));
    const webhookRequest = (topic: string, eventId: string, signature: string) =>
      new Request("http://localhost:8080/webhooks/shopify", {
        method: "POST",
        headers: {
          "X-Shopify-Hmac-Sha256": signature,
          "X-Shopify-API-Version": "2026-07",
          "X-Shopify-Shop-Domain": "shop.example.invalid",
          "X-Shopify-Topic": topic,
          "X-Shopify-Webhook-Id": eventId,
        },
      });
    await assert.rejects(
      processShopifyWebhook(
        webhookRequest("orders/updated", "signed-event-1", "firma-errata"),
        webhookBody,
      ),
      (error) => error instanceof AppError && error.code === "WEBHOOK_SIGNATURE_INVALID",
    );
    await processShopifyWebhook(
      webhookRequest(
        "orders/updated",
        "signed-event-1",
        createHmac("sha256", process.env.SHOPIFY_API_SECRET).update(webhookBody).digest("base64"),
      ),
      webhookBody,
    );
    await processShopifyWebhook(
      webhookRequest(
        "orders/updated",
        "signed-event-ripetuto",
        createHmac("sha256", process.env.SHOPIFY_API_SECRET).update(webhookBody).digest("base64"),
      ),
      webhookBody,
    );
    await assert.rejects(
      processShopifyWebhook(
        webhookRequest(
          "customers/redact",
          "signed-event-manomesso",
          createHmac("sha256", process.env.SHOPIFY_API_SECRET).update(webhookBody).digest("base64"),
        ),
        webhookBody,
      ),
      (error) => error instanceof AppError && error.code === "WEBHOOK_SIGNATURE_INVALID",
    );
    await assert.rejects(
      processShopifyWebhook(
        new Request("http://localhost:8080/webhooks/shopify", {
          method: "POST",
          headers: {
            "X-Shopify-Hmac-Sha256": createHmac("sha256", process.env.SHOPIFY_API_SECRET)
              .update(webhookBody)
              .digest("base64"),
            "X-Shopify-API-Version": "2026-07",
            "X-Shopify-Shop-Domain": "altro-shop.example.invalid",
            "X-Shopify-Topic": "orders/updated",
            "X-Shopify-Webhook-Id": "signed-event-shop-errato",
          },
        }),
        webhookBody,
      ),
      (error) => error instanceof AppError && error.code === "WEBHOOK_SIGNATURE_INVALID",
    );
    const signedEventId = createHash("sha256").update(webhookBody).digest("hex");
    assert.equal(
      (
        await getPool().query(
          "SELECT count(*)::int AS total FROM webhook_events WHERE external_event_id = $1",
          [signedEventId],
        )
      ).rows[0].total,
      1,
    );

    await getPool().query(
      "UPDATE jobs SET status = 'COMPLETED' WHERE type = 'shopify_process_webhook'",
    );
    await connectors.enqueueJob("ebay_sync_orders");
    const retryableJob = await connectors.claimJob("worker-retry");
    assert.ok(retryableJob);
    await connectors.failJob(retryableJob, "PROVIDER_RATE_LIMITED");
    assert.equal(
      (await getPool().query("SELECT status FROM jobs WHERE id = $1", [retryableJob.id])).rows[0]
        .status,
      "PENDING",
    );
    const retryDelay = Number(
      (
        await getPool().query(
          "SELECT extract(epoch FROM (run_at - now())) AS seconds FROM jobs WHERE id = $1",
          [retryableJob.id],
        )
      ).rows[0].seconds,
    );
    assert.ok(retryDelay > 5 && retryDelay <= 15);
    await getPool().query("UPDATE jobs SET run_at = now() WHERE id = $1", [retryableJob.id]);
    const terminalJob = await connectors.claimJob("worker-terminal");
    assert.ok(terminalJob);
    terminalJob.maxAttempts = terminalJob.attempts;
    const terminal = await connectors.failJob(terminalJob, "PROVIDER_UNAVAILABLE");
    assert.equal(terminal, true);
    await connectors.markConnectionError("EBAY", "PROVIDER_UNAVAILABLE", terminal!);
    assert.equal(
      (await getPool().query("SELECT status FROM jobs WHERE id = $1", [terminalJob.id])).rows[0]
        .status,
      "FAILED",
    );
    assert.equal(
      (
        await getPool().query(
          "SELECT status FROM connections WHERE provider = 'EBAY' AND environment = 'SANDBOX'",
        )
      ).rows[0].status,
      "ERROR",
    );
    assert.equal((await connectors.failedConnectorJobs())[0]?.id, terminalJob.id);
    await connectors.retryFailedJob(terminalJob.id, {
      type: "ADMIN",
      id: 1,
      requestId: "manual-retry",
    });
    assert.equal(
      (await getPool().query("SELECT status FROM jobs WHERE id = $1", [terminalJob.id])).rows[0]
        .status,
      "PENDING",
    );
    assert.equal(
      (
        await getPool().query(
          "SELECT count(*) FROM audit_events WHERE action = 'CONNECTOR_JOB_RETRIED' AND request_id = 'manual-retry'",
        )
      ).rows[0].count,
      "1",
    );
    const protectedEmailJob = await getPool().query<{ id: string }>(
      `INSERT INTO jobs
        (type, payload_json, status, attempts, max_attempts, last_error_code)
       VALUES ('send_customer_email', '{"deliveryId":"1"}', 'FAILED', 1, 5,
         'EMAIL_DELIVERY_UNCERTAIN')
       RETURNING id`,
    );
    await assert.rejects(
      connectors.retryFailedJob(protectedEmailJob.rows[0]!.id, {
        type: "ADMIN",
        id: 1,
        requestId: "email-manual-retry-forbidden",
      }),
      (error) => error instanceof AppError && error.code === "CONFLICT_REVISION",
    );
    assert.equal(
      (
        await getPool().query("SELECT status FROM jobs WHERE id = $1", [
          protectedEmailJob.rows[0]!.id,
        ])
      ).rows[0].status,
      "FAILED",
    );
    await getPool().query("UPDATE jobs SET status = 'FAILED' WHERE id = $1", [terminalJob.id]);
    const jobsBeforeReschedule = (
      await getPool().query(
        "SELECT count(*)::int AS total FROM jobs WHERE type = 'ebay_sync_orders'",
      )
    ).rows[0].total;
    await connectors.scheduleDueSyncs();
    assert.equal(
      (
        await getPool().query(
          "SELECT count(*)::int AS total FROM jobs WHERE type = 'ebay_sync_orders'",
        )
      ).rows[0].total,
      jobsBeforeReschedule,
    );
    await getPool().query("UPDATE jobs SET status = 'COMPLETED' WHERE status = 'PENDING'");
    await connectors.enqueueEbayHistory("2026-08-05", "IMPORT");
    await connectors.enqueueEbayHistory("2026-08-05", "IMPORT");
    await assert.rejects(
      connectors.enqueueEbayHistory("2026-08-05", "PREVIEW"),
      (error: unknown) => error instanceof AppError && error.code === "CONFLICT_REVISION",
    );
    assert.equal(
      (
        await getPool().query(
          "SELECT count(*)::int AS total FROM jobs WHERE type = 'ebay_preview_history' AND status = 'PENDING'",
        )
      ).rows[0].total,
      1,
    );
    const previewJob = await connectors.claimJob("worker-preview");
    assert.equal(previewJob?.type, "ebay_preview_history");
    assert.deepEqual(previewJob?.payload, {
      startDate: "2026-08-05",
      mode: "IMPORT",
      accountReference: "sandbox-risultante",
    });
    await connectors.completeJob(previewJob!, {
      count: 3,
      reviewRequired: 1,
      imported: 2,
      updated: 1,
      ignored: 0,
    });
    assert.deepEqual(
      (({ id: _id, createdAt: _createdAt, completedAt: _completedAt, ...preview }) => preview)(
        (await connectors.latestEbayHistory())!,
      ),
      {
        status: "COMPLETED",
        mode: "IMPORT",
        startDate: "2026-08-05",
        count: 3,
        reviewRequired: 1,
        imported: 2,
        updated: 1,
        ignored: 0,
        errorCode: null,
      },
    );
    await getPool().query("UPDATE jobs SET status = 'FAILED' WHERE id = $1", [previewJob!.id]);
    await connectors.enqueueEbayHistory("2026-08-05", "PREVIEW");
    await assert.rejects(
      connectors.retryFailedJob(previewJob!.id, {
        type: "ADMIN",
        id: 1,
        requestId: "preview-retry-conflict",
      }),
      (error) => error instanceof AppError && error.code === "CONFLICT_REVISION",
    );
    assert.equal(
      (
        await getPool().query(
          "SELECT count(*)::int AS total FROM jobs WHERE type = 'ebay_preview_history' AND status IN ('PENDING', 'RUNNING')",
        )
      ).rows[0].total,
      1,
    );
    assert.equal(
      (await getPool().query("SELECT status FROM jobs WHERE id = $1", [previewJob!.id])).rows[0]
        .status,
      "FAILED",
    );

    const payloads = JSON.parse(
      await readFile(
        new URL("../../tests/fixtures/connectors/shopify-orders.json", import.meta.url),
        "utf8",
      ),
    ) as unknown[];
    const mappedOrders = payloads.map((payload) =>
      mapShopifyOrder(payload, "shop.example.invalid"),
    );
    await assert.rejects(
      importOrders(mappedOrders, { type: "SYSTEM", requestId: "lease-obsoleta" }, claimed!),
      (error) => error instanceof AppError && error.code === "CONFLICT_REVISION",
    );
    await importOrders(mappedOrders, { type: "SYSTEM", requestId: "privacy-fixture" });
    const rawOnlyRefundChange = structuredClone(mappedOrders[1]!);
    rawOnlyRefundChange.updatedAt = "2026-08-02T10:01:00Z";
    rawOnlyRefundChange.refunds[0]!.raw = {
      providerMetadata: "ignorata",
      ...rawOnlyRefundChange.refunds[0]!.raw,
    };
    await importOrders([rawOnlyRefundChange], {
      type: "SYSTEM",
      requestId: "refund-raw-only",
    });
    assert.equal((await getPool().query("SELECT * FROM order_source_revisions")).rowCount, 0);
    const revisedOrder = structuredClone(mappedOrders[0]!);
    revisedOrder.updatedAt = "2026-08-01T10:00:00Z";
    revisedOrder.lines[0]!.description = "Oggetto sintetico aggiornato";
    await importOrders([revisedOrder], { type: "SYSTEM", requestId: "privacy-revision" });
    assert.equal((await getPool().query("SELECT * FROM order_source_revisions")).rowCount, 1);

    const dataRequestBody = Buffer.from(
      JSON.stringify({
        shop_domain: "shop.example.invalid",
        customer: { id: 2001 },
        orders_requested: [1001],
      }),
    );
    const dataRequestId = createHash("sha256").update(dataRequestBody).digest("hex");
    const dataRequestSignature = createHmac("sha256", process.env.SHOPIFY_API_SECRET)
      .update(dataRequestBody)
      .digest("base64");
    for (const topic of ["customers/redact", "shop/redact"]) {
      await assert.rejects(
        processShopifyWebhook(
          webhookRequest(topic, `privacy-topic-${topic}`, dataRequestSignature),
          dataRequestBody,
        ),
        (error) => error instanceof AppError && error.code === "PROVIDER_RESPONSE_INVALID",
      );
    }
    await processShopifyWebhook(
      webhookRequest("customers/data_request", "privacy-data-1", dataRequestSignature),
      dataRequestBody,
    );
    const pendingRequest = await getPool().query<{
      status: string;
      request_payload_json: { customerIds: string[]; orderIds: string[] };
    }>("SELECT status, request_payload_json FROM webhook_events WHERE external_event_id = $1", [
      dataRequestId,
    ]);
    assert.equal(pendingRequest.rows[0]!.status, "PENDING");
    assert.deepEqual(pendingRequest.rows[0]!.request_payload_json, {
      customerIds: ["gid://shopify/Customer/2001"],
      orderIds: ["gid://shopify/Order/1001"],
    });
    assert.deepEqual(
      (await connectors.pendingShopifyDataRequests()).map(
        ({ receivedAt: _receivedAt, ...request }) => request,
      ),
      [
        {
          externalEventId: dataRequestId,
          customerIds: ["gid://shopify/Customer/2001"],
          orderIds: ["gid://shopify/Order/1001"],
        },
      ],
    );
    await connectors.completeShopifyDataRequest(dataRequestId, {
      id: 1,
      requestId: "privacy-data-completed",
    });
    assert.deepEqual(await connectors.pendingShopifyDataRequests(), []);
    assert.deepEqual(
      (
        await getPool().query<{ request_payload_json: Record<string, unknown> }>(
          "SELECT request_payload_json FROM webhook_events WHERE external_event_id = $1",
          [dataRequestId],
        )
      ).rows[0]!.request_payload_json,
      {},
    );
    assert.equal(
      (
        await getPool().query(
          "SELECT count(*) FROM audit_events WHERE action = 'SHOPIFY_DATA_REQUEST_COMPLETED' AND request_id = 'privacy-data-completed'",
        )
      ).rows[0].count,
      "1",
    );
    await getPool().query(
      `UPDATE billing_cases SET status = 'APPROVED'
       WHERE id = (SELECT billing_case_id FROM orders WHERE external_order_id = $1)`,
      ["gid://shopify/Order/1002"],
    );

    const redactBody = Buffer.from(
      JSON.stringify({
        shop_domain: "shop.example.invalid",
        customer: { id: 2001 },
        orders_to_redact: [1001],
      }),
    );
    await processShopifyWebhook(
      webhookRequest(
        "customers/redact",
        "privacy-1",
        createHmac("sha256", process.env.SHOPIFY_API_SECRET).update(redactBody).digest("base64"),
      ),
      redactBody,
    );
    assert.equal(
      (
        await getPool().query("SELECT 1 FROM orders WHERE external_order_id = $1", [
          "gid://shopify/Order/1001",
        ])
      ).rowCount,
      0,
    );
    assert.equal((await getPool().query("SELECT * FROM order_source_revisions")).rowCount, 0);

    await connectors.processShopifyPrivacyRecord({
      externalEventId: "privacy-2",
      topic: "CUSTOMERS_REDACT",
      payloadSha256: "c".repeat(64),
      customerIds: ["gid://shopify/Customer/2002"],
    });
    assert.equal(
      (
        await getPool().query("SELECT 1 FROM orders WHERE external_order_id = $1", [
          "gid://shopify/Order/1002",
        ])
      ).rowCount,
      1,
    );
    assert.equal(
      (
        await connectors.processShopifyPrivacyRecord({
          externalEventId: "privacy-2",
          topic: "CUSTOMERS_REDACT",
          payloadSha256: "c".repeat(64),
          customerIds: ["gid://shopify/Customer/2002"],
        })
      ).duplicate,
      true,
    );
    await assert.rejects(
      connectors.processShopifyPrivacyRecord({
        externalEventId: "privacy-2",
        topic: "SHOP_REDACT",
        payloadSha256: "d".repeat(64),
      }),
      (error) => error instanceof AppError && error.code === "PROVIDER_RESPONSE_INVALID",
    );
    const uninstallBody = Buffer.from(JSON.stringify({ domain: "shop.example.invalid" }));
    const uninstallSignature = createHmac("sha256", process.env.SHOPIFY_API_SECRET)
      .update(uninstallBody)
      .digest("base64");
    await processShopifyWebhook(
      webhookRequest("app/uninstalled", "shopify-uninstalled-test", uninstallSignature),
      uninstallBody,
    );
    await processShopifyWebhook(
      webhookRequest("app/uninstalled", "shopify-uninstalled-replay", uninstallSignature),
      uninstallBody,
    );
    const providerAudit = await getPool().query<{ action: string; request_id: string }>(
      `SELECT action, request_id FROM audit_events
       WHERE action IN ('PROVIDER_CONNECTED', 'PROVIDER_REVOKED') ORDER BY id`,
    );
    assert.equal(
      providerAudit.rows.filter((event) => event.action === "PROVIDER_CONNECTED").length,
      7,
    );
    assert.equal(
      providerAudit.rows.at(-1)?.request_id,
      `shopify-webhook:${createHash("sha256").update(uninstallBody).digest("hex")}`,
    );
    assert.equal(
      providerAudit.rows.filter((event) => event.action === "PROVIDER_REVOKED").length,
      1,
    );
  } finally {
    await closePool();
    await database.drop();
  }
});
