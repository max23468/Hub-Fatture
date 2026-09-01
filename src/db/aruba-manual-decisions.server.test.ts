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
    await getPool().query(
      `INSERT INTO aruba_document_matches
        (remote_document_id, status, method, matcher_version, candidates_json)
       VALUES ($1, 'UNMATCHED', 'NONE', 1,
         '[{"candidateId":"987654","orderIds":["987654"],"potential":true,"reviewable":true}]')`,
      [remote.id],
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
        rejected_order_ids: ["987654"],
      },
    );
  } finally {
    await closePool();
    await database.drop();
  }
});
