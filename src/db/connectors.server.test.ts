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
  process.env.CREDENTIALS_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64url");
  process.env.SHOPIFY_API_KEY = "shopify-key-sintetica";
  process.env.SHOPIFY_API_SECRET = "shopify-secret-sintetico";
  process.env.SHOPIFY_SHOP = "shop.example.invalid";

  try {
    await runMigrations({ connectionString: database.connectionString });
    const connectors = await import("./connectors.server.ts");
    await connectors.saveConnection({
      provider: "SHOPIFY",
      environment: "DEVELOPMENT",
      accountReference: "shop.example.invalid",
      credentials: { accessToken: "token-sintetico" },
    });
    assert.deepEqual(
      (await connectors.loadConnection<{ accessToken: string }>("SHOPIFY")).credentials,
      { accessToken: "token-sintetico" },
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
    await connectors.completeJob(recovered!);
    assert.equal(
      (await getPool().query("SELECT status FROM webhook_events")).rows[0].status,
      "PROCESSED",
    );

    const webhookBody = Buffer.from(JSON.stringify({ id: 123 }));
    const webhookRequest = (signature: string) =>
      new Request("http://localhost:8080/webhooks/shopify", {
        method: "POST",
        headers: {
          "X-Shopify-Hmac-Sha256": signature,
          "X-Shopify-API-Version": "2026-07",
          "X-Shopify-Shop-Domain": "shop.example.invalid",
          "X-Shopify-Topic": "orders/updated",
          "X-Shopify-Webhook-Id": "signed-event-1",
        },
      });
    await assert.rejects(
      processShopifyWebhook(webhookRequest("firma-errata"), webhookBody),
      (error) => error instanceof AppError && error.code === "WEBHOOK_SIGNATURE_INVALID",
    );
    await processShopifyWebhook(
      webhookRequest(
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

    await connectors.enqueueJob("ebay_sync_orders");
    const retryableJob = await connectors.claimJob("worker-retry");
    assert.ok(retryableJob);
    await connectors.failJob(retryableJob, "PROVIDER_RATE_LIMITED");
    assert.equal(
      (await getPool().query("SELECT status FROM jobs WHERE id = $1", [retryableJob.id])).rows[0]
        .status,
      "PENDING",
    );
    await getPool().query("UPDATE jobs SET run_at = now() WHERE id = $1", [retryableJob.id]);
    const terminalJob = await connectors.claimJob("worker-terminal");
    assert.ok(terminalJob);
    await connectors.failJob(terminalJob, "PROVIDER_RESPONSE_INVALID");
    assert.equal(
      (await getPool().query("SELECT status FROM jobs WHERE id = $1", [terminalJob.id])).rows[0]
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
    await getPool().query(
      `UPDATE billing_cases SET status = 'APPROVED'
       WHERE id = (SELECT billing_case_id FROM orders WHERE external_order_id = $1)`,
      ["gid://shopify/Order/1002"],
    );

    const redacted = await connectors.processShopifyPrivacyRecord({
      externalEventId: "privacy-1",
      topic: "CUSTOMERS_REDACT",
      payloadSha256: "b".repeat(64),
      customerIds: ["gid://shopify/Customer/2001"],
    });
    assert.equal(redacted.deletedOrders, 1);
    assert.equal(
      (
        await getPool().query("SELECT 1 FROM orders WHERE external_order_id = $1", [
          "gid://shopify/Order/1001",
        ])
      ).rowCount,
      0,
    );

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
  } finally {
    await closePool();
    await database.drop();
  }
});
