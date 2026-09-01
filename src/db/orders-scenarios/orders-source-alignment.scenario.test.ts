import assert from "node:assert/strict";

import type { OrdersTestContext } from "./orders-test-support.test.ts";
import { runStaleEmailAlignmentScenario } from "./orders-stale-email-alignment.scenario.test.ts";

export async function run(context: OrdersTestContext) {
  const { orders, database, fixture } = context;
  const ebayMapperCorrection = structuredClone(fixture[0]);
  ebayMapperCorrection.provider = "EBAY";
  ebayMapperCorrection.externalOrderId = "ebay-order-mapper-name-correction";
  ebayMapperCorrection.externalCustomerId = "ebay-customer-mapper-name-correction";
  ebayMapperCorrection.createdAt = "2026-08-24T08:00:00Z";
  ebayMapperCorrection.updatedAt = "2026-08-24T09:00:00Z";
  ebayMapperCorrection.sourceSnapshot = { immutableEbayPayload: "same" };
  ebayMapperCorrection.customer.taxIdentifiers[0].value = "RSSMRA80A01H502U";
  ebayMapperCorrection.customer.displayName = "Mario Rossi";
  delete ebayMapperCorrection.customer.firstName;
  delete ebayMapperCorrection.customer.lastName;
  await orders.importOrders([ebayMapperCorrection], {
    id: 1,
    requestId: "test-ebay-mapper-name-before",
  });
  const correctedEbayMapperOrder = structuredClone(ebayMapperCorrection);
  correctedEbayMapperOrder.customer.firstName = "Mario";
  correctedEbayMapperOrder.customer.lastName = "Rossi";
  await orders.importOrders([correctedEbayMapperOrder], {
    id: 1,
    requestId: "test-ebay-mapper-name-after",
  });
  assert.deepEqual(
    (
      await database.getPool().query(
        `SELECT billing_cases.status,
                billing_cases.customer_snapshot_json ->> 'reviewRequired' AS review_required,
                (SELECT count(*) FROM order_source_revisions
                 WHERE order_id = orders.id)::int AS revision_count,
                (SELECT metadata_json ->> 'provider' FROM audit_events
                 WHERE entity_type = 'BILLING_CASE'
                   AND entity_id = billing_cases.id::text
                   AND action = 'CUSTOMER_CORRECTED'
                 ORDER BY id DESC LIMIT 1) AS correction_provider
         FROM orders
         JOIN billing_cases ON billing_cases.id = orders.billing_case_id
         WHERE orders.external_order_id = $1`,
        [ebayMapperCorrection.externalOrderId],
      )
    ).rows[0],
    {
      status: "READY",
      review_required: "false",
      revision_count: 0,
      correction_provider: "EBAY",
    },
  );

  const ebayEmailUpdate = structuredClone(fixture[0]);
  ebayEmailUpdate.provider = "EBAY";
  ebayEmailUpdate.externalOrderId = "ebay-order-email-only";
  ebayEmailUpdate.externalCustomerId = "ebay-customer-email-only";
  ebayEmailUpdate.createdAt = "2026-08-25T08:00:00Z";
  ebayEmailUpdate.updatedAt = "2026-08-25T09:00:00Z";
  ebayEmailUpdate.customer.taxIdentifiers[0].value = "RSSMRA80A01H503U";
  ebayEmailUpdate.customer.email = "prima@example.invalid";
  ebayEmailUpdate.sourceSnapshot = {
    fulfillmentStartInstructions: [
      { shippingStep: { shipTo: { email: "prima@example.invalid" } } },
    ],
  };
  await orders.importOrders([ebayEmailUpdate], {
    id: 1,
    requestId: "test-ebay-email-before",
  });
  const alignedEbayEmail = structuredClone(ebayEmailUpdate);
  alignedEbayEmail.customer.email = "dopo@example.invalid";
  alignedEbayEmail.sourceSnapshot = {
    fulfillmentStartInstructions: [{ shippingStep: { shipTo: { email: "dopo@example.invalid" } } }],
  };
  await orders.importOrders([alignedEbayEmail], {
    id: 1,
    requestId: "test-ebay-email-after",
  });
  assert.deepEqual(
    (
      await database.getPool().query(
        `SELECT billing_cases.status,
                billing_cases.customer_snapshot_json ->> 'email' AS email,
                orders.trigger_status,
                (SELECT count(*) FROM order_source_revisions
                 WHERE order_id = orders.id)::int AS revision_count,
                (SELECT count(*) FROM audit_events
                 WHERE entity_type = 'ORDER' AND entity_id = orders.id::text
                   AND action = 'ORDER_SOURCE_REVIEWED'
                   AND metadata_json ->> 'automaticAlignment' = 'EMAIL_ONLY')::int
                  AS automatic_alignment_count
         FROM orders
         JOIN billing_cases ON billing_cases.id = orders.billing_case_id
         WHERE orders.external_order_id = $1`,
        [ebayEmailUpdate.externalOrderId],
      )
    ).rows[0],
    {
      status: "READY",
      email: "dopo@example.invalid",
      trigger_status: "GROUPED",
      revision_count: 0,
      automatic_alignment_count: 1,
    },
  );

  const existingEmailConflict = structuredClone(ebayEmailUpdate);
  existingEmailConflict.externalOrderId = "ebay-order-existing-email-conflict";
  existingEmailConflict.externalCustomerId = "ebay-customer-existing-email-conflict";
  existingEmailConflict.createdAt = "2026-08-26T08:00:00Z";
  existingEmailConflict.updatedAt = "2026-08-26T09:00:00Z";
  existingEmailConflict.customer.taxIdentifiers[0].value = "RSSMRA80A01H504U";
  existingEmailConflict.sourceSnapshot = {
    marker: "old",
    fulfillmentStartInstructions: [
      { shippingStep: { shipTo: { email: "prima@example.invalid" } } },
    ],
  };
  await orders.importOrders([existingEmailConflict], {
    id: 1,
    requestId: "test-ebay-existing-email-before",
  });
  const conflictedEmail = structuredClone(existingEmailConflict);
  conflictedEmail.customer.email = "dopo@example.invalid";
  conflictedEmail.sourceSnapshot = {
    marker: "new",
    fulfillmentStartInstructions: [{ shippingStep: { shipTo: { email: "dopo@example.invalid" } } }],
  };
  await orders.importOrders([conflictedEmail], {
    id: 1,
    requestId: "test-ebay-existing-email-conflict",
  });
  const existingEmailCaseId = (
    await database
      .getPool()
      .query("SELECT billing_case_id::text AS id FROM orders WHERE external_order_id = $1", [
        existingEmailConflict.externalOrderId,
      ])
  ).rows[0].id;
  await database.getPool().query(
    `UPDATE order_source_revisions
       SET previous_normalized_snapshot_json = jsonb_set(
             jsonb_set(previous_normalized_snapshot_json,
                       '{customerIdentity}', '"EXACT_PROFILE"'::jsonb),
             '{customerReviewRequired}', 'false'::jsonb),
           current_normalized_snapshot_json = jsonb_set(
             jsonb_set(
               jsonb_set(current_normalized_snapshot_json,
                         '{customerIdentity}', '"TAX_ID"'::jsonb),
               '{customerReviewRequired}', 'true'::jsonb),
             '{reviewFingerprint}', '"legacy-mapper-fingerprint"'::jsonb)
     WHERE billing_case_id = $1`,
    [existingEmailCaseId],
  );
  await database.getPool().query(
    `UPDATE billing_cases
       SET customer_corrected_at = now(),
           customer_snapshot_json = jsonb_set(
             customer_snapshot_json, '{displayName}', '"Destinatario manuale"'::jsonb)
     WHERE id = $1`,
    [existingEmailCaseId],
  );
  await orders.importOrders([conflictedEmail], {
    id: 1,
    requestId: "test-ebay-existing-email-replay",
  });
  assert.deepEqual(
    (
      await database.getPool().query(
        `SELECT billing_cases.status,
                billing_cases.customer_snapshot_json ->> 'displayName' AS display_name,
                orders.trigger_status,
                (SELECT count(*) FROM order_source_revisions
                 WHERE order_id = orders.id)::int AS revision_count,
                (SELECT count(*) FROM audit_events
                 WHERE entity_type = 'ORDER' AND entity_id = orders.id::text
                   AND action = 'ORDER_SOURCE_REVIEWED'
                   AND metadata_json ->> 'automaticAlignment' = 'EMAIL_AND_MAPPER')::int
                  AS automatic_alignment_count
         FROM orders
         JOIN billing_cases ON billing_cases.id = orders.billing_case_id
         WHERE orders.external_order_id = $1`,
        [existingEmailConflict.externalOrderId],
      )
    ).rows[0],
    {
      status: "READY",
      display_name: "Destinatario manuale",
      trigger_status: "GROUPED",
      revision_count: 1,
      automatic_alignment_count: 1,
    },
  );
  await runStaleEmailAlignmentScenario(context);
}
