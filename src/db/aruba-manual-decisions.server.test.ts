import assert from "node:assert/strict";
import test from "node:test";

import { AppError } from "../errors.ts";
import { closePool, getPool } from "./client.server.ts";
import { temporaryDatabase } from "./database-fixture.ts";
import { runMigrations } from "./migrations.server.ts";

test("un candidato Aruba può essere escluso solo dopo la conferma esplicita", async () => {
  const database = await temporaryDatabase("aruba_manual_decisions");
  process.env.APP_ENV = "test";
  process.env.APP_BASE_URL = "http://localhost:8080";
  process.env.ADMIN_BOOTSTRAP_TOKEN = "synthetic-bootstrap-token-for-tests";
  process.env.ARUBA_ACCOUNT_REFERENCE = "synthetic-aruba-account";
  process.env.DATABASE_URL = database.connectionString;
  try {
    await runMigrations({ connectionString: database.connectionString });
    const actor = (
      await getPool().query<{ id: number }>(
        `INSERT INTO users (username, password_hash, can_approve)
         VALUES ('Massimo', 'hash-sintetico', true) RETURNING id`,
      )
    ).rows[0]!;
    const remote = (
      await getPool().query<{ id: string }>(
        `INSERT INTO aruba_remote_documents
          (environment, account_reference, remote_id, document_type, fiscal_year,
           document_date, total_amount, remote_status, remote_status_observed_at,
           metadata_digest)
         VALUES ('MOCK', 'synthetic-aruba-account', 'manual-decision', 'TD01', 2026,
           '2026-08-28', 1000, 'DELIVERED', now(), repeat('1', 64))
         RETURNING id`,
      )
    ).rows[0]!;
    const storage = (
      await getPool().query<{ id: string }>(
        `INSERT INTO storage_objects (kind, relative_path, sha256, size_bytes, content_type)
         VALUES ('ARUBA_XML', 'synthetic/manual-decision.xml', repeat('2', 64), 10,
                 'application/xml') RETURNING id`,
      )
    ).rows[0]!;
    await getPool().query(
      `INSERT INTO aruba_files (remote_document_id, storage_object_id, kind)
       VALUES ($1, $2, 'ARUBA_XML')`,
      [remote.id, storage.id],
    );
    const customer = (
      await getPool().query<{ id: string }>(
        `INSERT INTO customers
          (kind, match_key, display_name, billing_address_json, source_confidence,
           review_required)
         VALUES ('PRIVATE_IT', 'manual-amount-mismatch', 'Cliente sintetico', '{}',
                 'TAX_ID', false)
         RETURNING id::text`,
      )
    ).rows[0]!;
    const billingCase = (
      await getPool().query<{ id: string }>(
        `INSERT INTO billing_cases
          (customer_id, local_order_date, currency, status, customer_snapshot_json)
         VALUES ($1, '2026-08-28', 'EUR', 'NEEDS_REVIEW',
                 '{"reviewRequired":false,"canonicalProfile":{}}')
         RETURNING id::text`,
        [customer.id],
      )
    ).rows[0]!;
    const order = (
      await getPool().query<{ id: string }>(
        `INSERT INTO orders
          (provider, external_account_id, external_order_id, display_number,
           created_at_source, updated_at_source, local_order_date, currency, gross_amount,
           payment_status, fulfillment_status, trigger_status, customer_id, billing_case_id,
           raw_snapshot_json, normalized_snapshot_json)
         VALUES ('SHOPIFY', 'manual-decisions', 'amount-mismatch', '#MISMATCH', now(), now(),
                 '2026-08-28', 'EUR', 1100, 'PAID', 'FULFILLED', 'GROUPED', $1, $2, '{}',
                 '{"orderReviewRequired":false,"deferredReviewRequired":false,
                   "customerSnapshot":{"canonicalProfile":{}}}')
         RETURNING id::text`,
        [customer.id, billingCase.id],
      )
    ).rows[0]!;
    await getPool().query(
      `INSERT INTO aruba_document_matches
        (remote_document_id, status, method, matcher_version, candidates_json)
       VALUES ($1, 'UNMATCHED', 'NONE', 1,
         jsonb_build_array(jsonb_build_object(
           'candidateId', $2::text, 'orderIds', jsonb_build_array($2::text),
           'potential', false, 'compatible', false, 'reviewable', false,
           'signals', jsonb_build_object(
             'provider', true, 'nearDate', true, 'recipient', true, 'total', false))))`,
      [remote.id, order.id],
    );
    const decisions = await import("./aruba-manual-decisions.server.ts");
    const owner = { id: actor.id, canApprove: true, requestId: "manual-decision-test" };
    await assert.rejects(
      decisions.confirmArubaDocumentOutOfScope(
        remote.id,
        "Documento sintetico verificato fuori perimetro",
        null,
        owner,
      ),
      (error) => error instanceof AppError && error.code === "ARUBA_PROFILE_CONFLICT",
    );
    assert.equal(
      (await getPool().query("SELECT method FROM aruba_document_matches")).rows[0].method,
      "NONE",
    );

    await decisions.confirmArubaDocumentOutOfScope(
      remote.id,
      "Documento sintetico verificato fuori perimetro",
      "confirmed",
      owner,
    );
    assert.deepEqual(
      (
        await getPool().query(
          `SELECT matches.status, matches.method, remote.origin,
                  audit.before_json ->> 'actionableCandidateCount' AS candidate_count,
                  audit.before_json -> 'rejectedOrderIds' AS rejected_order_ids
           FROM aruba_document_matches matches
           JOIN aruba_remote_documents remote ON remote.id = matches.remote_document_id
           JOIN audit_events audit ON audit.entity_id = remote.id::text
             AND audit.action = 'ARUBA_DOCUMENT_CONFIRMED_OUT_OF_SCOPE'`,
        )
      ).rows[0],
      {
        status: "UNMATCHED",
        method: "MANUAL",
        origin: "ARUBA_EXTERNAL",
        candidate_count: "1",
        rejected_order_ids: [order.id],
      },
    );
    assert.equal(
      (await getPool().query("SELECT status FROM billing_cases WHERE id = $1", [billingCase.id]))
        .rows[0].status,
      "READY",
    );
  } finally {
    await closePool();
    await database.drop();
  }
});
