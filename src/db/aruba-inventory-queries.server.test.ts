import assert from "node:assert/strict";
import test from "node:test";

import { PAGE_SIZE } from "../orders.ts";
import { temporaryDatabase } from "./database-fixture.ts";
import { runMigrations } from "./migrations.server.ts";

test("i documenti Aruba da collegare sono ricercabili e paginati senza il limite di 200", async () => {
  const clean = await temporaryDatabase("aruba_documents_search");
  process.env.APP_ENV = "test";
  process.env.APP_BASE_URL = "http://localhost:8080";
  process.env.ADMIN_BOOTSTRAP_TOKEN = "synthetic-bootstrap-token-for-tests";
  process.env.DATABASE_URL = clean.connectionString;

  const database = await import("./client.server.ts");
  try {
    await runMigrations({ connectionString: clean.connectionString });
    await database.getPool().query(
      `INSERT INTO aruba_remote_documents
        (environment, account_reference, remote_id, document_type, fiscal_year, series,
         fiscal_number, document_date, total_amount, remote_status,
         remote_status_observed_at, origin, metadata_digest, last_observed_at)
       SELECT 'MOCK', 'synthetic-aruba-account',
              'documento-remoto-' || lpad(series::text, 3, '0'), 'TD01', 2026,
              'RMT', lpad(series::text, 3, '0'), '2026-08-01', 1000 + series,
              'DELIVERED', now(), 'ARUBA_EXTERNAL', md5(series::text) || md5(series::text),
              now() + series * interval '1 minute'
       FROM generate_series(1, $1::integer) AS series`,
      [PAGE_SIZE + 7],
    );
    await database.getPool().query(
      `INSERT INTO aruba_document_matches
        (remote_document_id, status, method, matcher_version)
       SELECT id, 'UNMATCHED', 'NONE', 1 FROM aruba_remote_documents`,
    );

    const inventory = await import("./aruba-inventory-queries.server.ts");
    const firstPage = await inventory.listRemoteDocumentsPage({ attentionOnly: true });
    const secondPage = await inventory.listRemoteDocumentsPage({ attentionOnly: true, page: 2 });
    assert.equal(firstPage.rows.length, PAGE_SIZE);
    assert.equal(firstPage.hasNext, true);
    assert.equal(firstPage.total, PAGE_SIZE + 7);
    assert.equal(secondPage.rows.length, 7);
    assert.equal(secondPage.hasNext, false);
    assert.equal(
      firstPage.rows.some((row) => secondPage.rows.some((other) => other.id === row.id)),
      false,
    );

    const byRemoteId = await inventory.listRemoteDocumentsPage({
      attentionOnly: true,
      query: "documento-remoto-057",
    });
    assert.equal(byRemoteId.total, 1);
    assert.equal(byRemoteId.rows[0]?.remote_id, "documento-remoto-057");
    assert.deepEqual(
      await inventory.listRemoteDocumentsPage({ attentionOnly: true, query: "%_" }),
      { rows: [], hasNext: false, total: 0 },
    );
  } finally {
    await database.closePool();
    await clean.drop();
  }
});
