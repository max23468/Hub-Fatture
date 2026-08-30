import assert from "node:assert/strict";
import test from "node:test";

import { temporaryDatabase } from "./database-fixture.ts";
import { runMigrations } from "./migrations.server.ts";

test("Dashboard e Attività espongono soltanto gli errori connettore ancora azionabili", async () => {
  const database = await temporaryDatabase("connector_errors");
  process.env.APP_ENV = "test";
  process.env.EBAY_ENVIRONMENT = "sandbox";
  process.env.APP_BASE_URL = "http://localhost:8080";
  process.env.ADMIN_BOOTSTRAP_TOKEN = "synthetic-bootstrap-token-for-tests";
  process.env.DATABASE_URL = database.connectionString;

  const client = await import("./client.server.ts");
  try {
    await runMigrations({ connectionString: database.connectionString });
    const connectors = {
      ...(await import("./connector-connections.server.ts")),
      ...(await import("./connector-jobs.server.ts")),
    };
    const orders = await import("./order-queries.server.ts");

    await client.getPool().query(
      `INSERT INTO connections
         (provider, environment, account_reference, encrypted_credentials, status, last_synced_at)
       VALUES
         ('SHOPIFY', 'DEVELOPMENT', 'shop.example.invalid', 'synthetic', 'CONNECTED',
          '2026-08-23T10:00:00Z'),
         ('EBAY', 'SANDBOX', 'ebay-synthetic', 'synthetic', 'CONNECTED',
          '2026-08-23T10:00:00Z')`,
    );
    const webhooks = await client.getPool().query<{ id: string; external_event_id: string }>(
      `INSERT INTO webhook_events
         (provider, external_event_id, topic, payload_sha256, status, error_code)
       VALUES
         ('SHOPIFY', 'historical-webhook', 'ORDERS_UPDATED', repeat('a', 64), 'FAILED',
          'PROVIDER_RESPONSE_INVALID'),
         ('SHOPIFY', 'current-webhook', 'ORDERS_UPDATED', repeat('b', 64), 'FAILED',
          'PROVIDER_RESPONSE_INVALID')
       RETURNING id, external_event_id`,
    );
    const historicalWebhookId = webhooks.rows.find(
      ({ external_event_id }) => external_event_id === "historical-webhook",
    )!.id;
    const currentWebhookId = webhooks.rows.find(
      ({ external_event_id }) => external_event_id === "current-webhook",
    )!.id;

    await client.getPool().query(
      `INSERT INTO jobs
         (type, payload_json, status, run_at, locked_at, attempts, last_error_code)
       VALUES
         ('shopify_process_webhook', jsonb_build_object('webhookEventId', $1::text), 'FAILED',
          '2026-08-23T09:00:00Z', '2026-08-23T09:00:00Z', 1,
          'PROVIDER_RESPONSE_INVALID'),
         ('shopify_process_webhook', jsonb_build_object('webhookEventId', $2::text), 'FAILED',
          '2026-08-23T11:00:00Z', '2026-08-23T11:00:00Z', 1,
          'PROVIDER_RESPONSE_INVALID'),
         ('ebay_sync_orders', '{}', 'FAILED', '2026-08-23T11:05:00Z',
          '2026-08-23T11:05:00Z', 1, 'PROVIDER_UNAVAILABLE'),
         ('send_customer_email', '{}', 'FAILED', '2026-08-23T11:10:00Z',
          '2026-08-23T11:10:00Z', 1, 'EMAIL_DELIVERY_TEMPORARY')`,
      [historicalWebhookId, currentWebhookId],
    );

    const actionable = await connectors.actionableConnectorFailures();
    assert.deepEqual(
      actionable.map(({ type }) => type),
      ["ebay_sync_orders", "shopify_process_webhook"],
    );
    assert.equal((await orders.dashboardSummary()).sync_errors, "2");

    await connectors.markConnectionSynced("SHOPIFY");
    assert.deepEqual(
      (await connectors.actionableConnectorFailures()).map(({ type }) => type),
      ["ebay_sync_orders"],
    );
    assert.equal((await orders.dashboardSummary()).sync_errors, "1");

    assert.equal(
      (
        await client
          .getPool()
          .query("SELECT count(*)::int AS total FROM jobs WHERE status = 'FAILED'")
      ).rows[0].total,
      4,
    );
    assert.equal(
      (
        await client
          .getPool()
          .query("SELECT count(*)::int AS total FROM webhook_events WHERE status = 'FAILED'")
      ).rows[0].total,
      2,
    );
  } finally {
    await client.closePool();
    await database.drop();
  }
});
