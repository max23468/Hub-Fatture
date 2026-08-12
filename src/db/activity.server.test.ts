import assert from "node:assert/strict";
import test from "node:test";

import { PAGE_SIZE } from "../orders.ts";
import { temporaryDatabase } from "./database-fixture.ts";
import { runMigrations } from "./migrations.server.ts";

test("le attività espongono i dati operativi e paginano molte righe", async () => {
  const clean = await temporaryDatabase("activities");
  try {
    await runMigrations({ connectionString: clean.connectionString });
    process.env.APP_ENV = "test";
    process.env.APP_BASE_URL = "http://localhost:8080";
    process.env.ADMIN_BOOTSTRAP_TOKEN = "synthetic-bootstrap-token-for-tests";
    process.env.DATABASE_URL = clean.connectionString;

    const orders = await import("./orders.server.ts");
    const database = await import("./client.server.ts");
    const billingCase = await database.getPool().query<{ id: string }>(
      `WITH customer AS (
         INSERT INTO customers
           (kind, match_key, display_name, billing_address_json,
            source_confidence, review_required)
         VALUES ('PRIVATE_IT', 'activity-customer', 'Cliente attività', '{}', 'TAX_ID', false)
         RETURNING id
       ), billing_case AS (
         INSERT INTO billing_cases
           (customer_id, local_order_date, currency, status, customer_snapshot_json)
         SELECT id, '2026-07-01', 'EUR', 'NEEDS_REVIEW',
                '{"displayName":"Cliente attività"}'::jsonb
         FROM customer
         RETURNING id, customer_id
       ), inserted_orders AS (
         INSERT INTO orders
           (provider, external_account_id, external_order_id, display_number,
            created_at_source, updated_at_source, local_order_date, currency, gross_amount,
            payment_status, fulfillment_status, trigger_status, customer_id,
            raw_snapshot_json, normalized_snapshot_json)
         SELECT 'SHOPIFY', 'activity-pagination', 'shop-order-activity-' || series,
                '#ACT-' || lpad(series::text, 2, '0'),
                '2026-07-01T08:00:00Z'::timestamptz + series * interval '1 minute',
                '2026-07-01T09:00:00Z'::timestamptz + series * interval '1 minute',
                '2026-07-01'::date + ((series - 1) % 28), 'EUR', 1000,
                'PAID', 'FULFILLED', 'NEEDS_REVIEW', billing_case.customer_id, '{}',
                jsonb_build_object(
                  'customerSnapshot',
                  jsonb_build_object('displayName', 'Cliente attività ' || series)
                )
         FROM billing_case
         CROSS JOIN generate_series(1, $1::integer) AS series
       )
       SELECT id FROM billing_case`,
      [PAGE_SIZE + 5],
    );

    const firstPage = await orders.listOpenActivities();
    const secondPage = await orders.listOpenActivities(2);
    const caseActivity = [...firstPage.rows, ...secondPage.rows].find(
      (activity) => activity.href === `/ordini/preparazione/${billingCase.rows[0]!.id}`,
    );

    assert.equal(firstPage.rows.length, PAGE_SIZE);
    assert.equal(firstPage.hasNext, true);
    assert.equal(firstPage.total, PAGE_SIZE + 6);
    assert.equal(secondPage.rows.length, 6);
    assert.equal(secondPage.hasNext, false);
    assert.equal(
      firstPage.rows.some((activity) =>
        secondPage.rows.some((other) => other.kind === activity.kind && other.id === activity.id),
      ),
      false,
    );
    assert.equal(caseActivity?.reason, "BILLING_CASE_REVIEW");
    assert.match(caseActivity?.case_number ?? "", /^\d{6}$/);
    assert.equal(caseActivity?.customer_name, "Cliente attività");
    assert.equal(caseActivity?.order_date, "2026-07-01");

    await database.closePool();
  } finally {
    await import("./client.server.ts").then(({ closePool }) => closePool());
    await clean.drop();
  }
});
