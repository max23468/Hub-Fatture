import assert from "node:assert/strict";

import type { OrdersTestContext } from "./orders-test-support.test.ts";

function ebayEmailOrder(context: OrdersTestContext, suffix: string, email?: string) {
  const input = structuredClone(context.fixture[0]);
  input.provider = "EBAY";
  input.externalOrderId = `ebay-stale-email-${suffix}`;
  input.externalCustomerId = `ebay-stale-email-customer-${suffix}`;
  const day = suffix === "automatic" ? "27" : suffix === "manual" ? "28" : "29";
  input.createdAt = `2026-08-${day}T08:00:00Z`;
  input.updatedAt = `2026-08-${day}T09:00:00Z`;
  input.customer.taxIdentifiers[0].value = "RSSMRA80A01H501U";
  input.customer.email = email;
  input.sourceSnapshot = email
    ? { fulfillmentStartInstructions: [{ shippingStep: { shipTo: { email } } }] }
    : { fulfillmentStartInstructions: [{ shippingStep: { shipTo: {} } }] };
  return input;
}

async function makeCaseEmailStale(
  context: OrdersTestContext,
  externalOrderId: string,
  staleEmail: string,
  manuallyCorrected: boolean,
) {
  await context.database.getPool().query(
    `UPDATE billing_cases
     SET customer_snapshot_json = jsonb_set(
           jsonb_set(customer_snapshot_json, '{email}', to_jsonb($2::text)),
           '{canonicalProfile,email}', to_jsonb($2::text)),
         customer_corrected_at = CASE WHEN $3::boolean THEN now() ELSE NULL END
     WHERE id = (SELECT billing_case_id FROM orders WHERE external_order_id = $1)`,
    [externalOrderId, staleEmail, manuallyCorrected],
  );
  await context.database.getPool().query(
    `UPDATE documents
     SET recipient_snapshot_json = jsonb_set(
           recipient_snapshot_json, '{email}', to_jsonb($2::text))
     WHERE billing_case_id = (
       SELECT billing_case_id FROM orders WHERE external_order_id = $1
     ) AND kind = 'INVOICE' AND status = 'DRAFT'`,
    [externalOrderId, staleEmail],
  );
}

export async function runStaleEmailAlignmentScenario(context: OrdersTestContext) {
  const currentEmail = "corrente@example.invalid";
  const automatic = ebayEmailOrder(context, "automatic", currentEmail);
  await context.orders.importOrders([automatic], {
    id: 1,
    requestId: "test-ebay-stale-email-create",
  });
  assert.deepEqual(
    (
      await context.database.getPool().query(
        `SELECT billing_case_id IS NOT NULL AS grouped
           FROM orders WHERE external_order_id = $1`,
        [automatic.externalOrderId],
      )
    ).rows[0],
    { grouped: true },
  );
  await makeCaseEmailStale(context, automatic.externalOrderId, "vecchia@example.invalid", false);
  await context.orders.importOrders([automatic], {
    id: 1,
    requestId: "test-ebay-stale-email-replay",
  });
  assert.deepEqual(
    (
      await context.database.getPool().query(
        `SELECT billing_cases.customer_snapshot_json ->> 'email' AS case_email,
                (SELECT count(*)::integer FROM audit_events
                 WHERE entity_type = 'ORDER' AND entity_id = orders.id::text
                   AND action = 'ORDER_SOURCE_REVIEWED'
                   AND metadata_json ->> 'automaticAlignment' = 'EMAIL_ONLY') AS alignments
         FROM orders
         JOIN billing_cases ON billing_cases.id = orders.billing_case_id
         WHERE orders.external_order_id = $1`,
        [automatic.externalOrderId],
      )
    ).rows[0],
    { case_email: currentEmail, alignments: 1 },
  );

  const manual = ebayEmailOrder(context, "manual", currentEmail);
  await context.orders.importOrders([manual], {
    id: 1,
    requestId: "test-ebay-manual-email-create",
  });
  const manualEmail = "manuale@example.invalid";
  await makeCaseEmailStale(context, manual.externalOrderId, manualEmail, true);
  await context.orders.importOrders([manual], {
    id: 1,
    requestId: "test-ebay-manual-email-replay",
  });
  assert.deepEqual(
    (
      await context.database.getPool().query(
        `SELECT billing_cases.customer_snapshot_json ->> 'email' AS case_email,
                (SELECT count(*)::integer FROM audit_events
                 WHERE entity_type = 'ORDER' AND entity_id = orders.id::text
                   AND action = 'ORDER_SOURCE_REVIEWED'
                   AND metadata_json ->> 'automaticAlignment' = 'EMAIL_ONLY') AS alignments
         FROM orders
         JOIN billing_cases ON billing_cases.id = orders.billing_case_id
         WHERE orders.external_order_id = $1`,
        [manual.externalOrderId],
      )
    ).rows[0],
    { case_email: manualEmail, alignments: 0 },
  );

  const missing = ebayEmailOrder(context, "missing");
  await context.orders.importOrders([missing], {
    id: 1,
    requestId: "test-ebay-missing-email-create",
  });
  await context.database.getPool().query(
    `UPDATE billing_cases
     SET customer_snapshot_json = jsonb_set(
           customer_snapshot_json, '{canonicalProfile,email}', 'null'::jsonb, true)
     WHERE id = (SELECT billing_case_id FROM orders WHERE external_order_id = $1)`,
    [missing.externalOrderId],
  );
  await context.orders.importOrders([missing], {
    id: 1,
    requestId: "test-ebay-null-email-replay",
  });
  assert.deepEqual(
    (
      await context.database.getPool().query(
        `SELECT billing_cases.customer_snapshot_json -> 'canonicalProfile'
                  IS NOT DISTINCT FROM
                orders.normalized_snapshot_json #> '{customerSnapshot,canonicalProfile}'
                  AS profiles_equal,
                (SELECT count(*)::integer FROM audit_events
                 WHERE entity_type = 'ORDER' AND entity_id = orders.id::text
                   AND action = 'ORDER_SOURCE_REVIEWED'
                   AND metadata_json ->> 'automaticAlignment' = 'EMAIL_ONLY') AS alignments
         FROM orders
         JOIN billing_cases ON billing_cases.id = orders.billing_case_id
         WHERE orders.external_order_id = $1`,
        [missing.externalOrderId],
      )
    ).rows[0],
    { profiles_equal: true, alignments: 1 },
  );
}
