import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { closePool, getPool } from "./client.server.ts";
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
    assert.equal((await connectors.loadConnection("EBAY")).accountReference, "sandbox-sintetica");
    await connectors.markConnectionSynced("EBAY");
    await connectors.writeCursor("EBAY", "cursor-sintetico", "2026-08-01T00:00:00Z");
    await connectors.saveConnection(
      {
        provider: "EBAY",
        environment: "SANDBOX",
        accountReference: "sandbox-sintetica",
        credentials: { refreshToken: "token-sandbox-rinnovato" },
      },
      systemActor,
    );
    assert.equal((await connectors.readCursor("EBAY")).cursor, "cursor-sintetico");
    assert.ok(
      (
        await getPool().query(
          "SELECT last_synced_at FROM connections WHERE provider = 'EBAY' AND environment = 'SANDBOX'",
        )
      ).rows[0].last_synced_at,
    );
    await connectors.saveConnection(
      {
        provider: "EBAY",
        environment: "SANDBOX",
        accountReference: "sandbox-sostitutiva",
        credentials: { refreshToken: "token-sandbox-sostitutivo" },
      },
      systemActor,
    );
    assert.equal((await connectors.readCursor("EBAY")).cursor, null);
    assert.equal(
      (
        await getPool().query(
          "SELECT last_synced_at FROM connections WHERE provider = 'EBAY' AND environment = 'SANDBOX'",
        )
      ).rows[0].last_synced_at,
      null,
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
    assert.equal((await getPool().query("SELECT * FROM jobs")).rowCount, 1);

    const claimed = await connectors.claimJob("worker-1");
    assert.ok(claimed);
    await getPool().query(
      "UPDATE jobs SET lease_expires_at = now() - interval '1 second' WHERE id = $1",
      [claimed.id],
    );
    const recovered = await connectors.claimJob("worker-2");
    assert.equal(recovered?.id, claimed.id);
    assert.equal(recovered?.attempts, 2);
    assert.equal(await connectors.completeJob(claimed), false);
    assert.equal(await connectors.failJob(claimed, "PROVIDER_UNAVAILABLE"), null);
    assert.equal(await connectors.renewJobLease(recovered!), true);
    await connectors.completeJob(recovered!);
    assert.equal(
      (await getPool().query("SELECT status FROM webhook_events")).rows[0].status,
      "PROCESSED",
    );

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
    assert.equal(
      (
        await getPool().query(
          "SELECT count(*)::int AS total FROM webhook_events WHERE external_event_id = 'signed-event-1'",
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
    await connectors.enqueueEbayPreview();
    await connectors.enqueueEbayPreview();
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
    await connectors.completeJob(previewJob!, { count: 3, reviewRequired: 1 });
    assert.deepEqual(
      (({ id: _id, createdAt: _createdAt, completedAt: _completedAt, ...preview }) => preview)(
        (await connectors.latestEbayPreview())!,
      ),
      { status: "COMPLETED", count: 3, reviewRequired: 1, errorCode: null },
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
      JSON.stringify({ customer: { id: 2001 }, orders_requested: [1001] }),
    );
    await processShopifyWebhook(
      webhookRequest(
        "customers/data_request",
        "privacy-data-1",
        createHmac("sha256", process.env.SHOPIFY_API_SECRET)
          .update(dataRequestBody)
          .digest("base64"),
      ),
      dataRequestBody,
    );
    const pendingRequest = await getPool().query<{
      status: string;
      request_payload_json: { customerIds: string[]; orderIds: string[] };
    }>("SELECT status, request_payload_json FROM webhook_events WHERE external_event_id = $1", [
      "privacy-data-1",
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
          externalEventId: "privacy-data-1",
          customerIds: ["gid://shopify/Customer/2001"],
          orderIds: ["gid://shopify/Order/1001"],
        },
      ],
    );
    await connectors.completeShopifyDataRequest("privacy-data-1", {
      id: 1,
      requestId: "privacy-data-completed",
    });
    assert.deepEqual(await connectors.pendingShopifyDataRequests(), []);
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

    const redactBody = Buffer.from(JSON.stringify({ customer: { id: 2001 } }));
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
    await connectors.revokeConnection("SHOPIFY", {
      type: "SYSTEM",
      requestId: "shopify-uninstalled-test",
    });
    const providerAudit = await getPool().query<{ action: string; request_id: string }>(
      `SELECT action, request_id FROM audit_events
       WHERE action IN ('PROVIDER_CONNECTED', 'PROVIDER_REVOKED') ORDER BY id`,
    );
    assert.equal(
      providerAudit.rows.filter((event) => event.action === "PROVIDER_CONNECTED").length,
      5,
    );
    assert.equal(providerAudit.rows.at(-1)?.request_id, "shopify-uninstalled-test");
  } finally {
    await closePool();
    await database.drop();
  }
});
