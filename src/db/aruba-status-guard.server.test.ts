import assert from "node:assert/strict";
import test from "node:test";

import { temporaryDatabase } from "./database-fixture.ts";
import { runMigrations } from "./migrations.server.ts";

test("una pagina Aruba con troppi stati sconosciuti viene rifiutata prima dell’ingest", async () => {
  const fixture = await temporaryDatabase("aruba_status_guard");
  let database: typeof import("./client.server.ts") | undefined;
  try {
    await runMigrations({ connectionString: fixture.connectionString });
    process.env.APP_ENV = "test";
    process.env.APP_BASE_URL = "http://localhost:8080";
    process.env.ADMIN_BOOTSTRAP_TOKEN = "synthetic-bootstrap-token-for-tests";
    process.env.DATABASE_URL = fixture.connectionString;

    database = await import("./client.server.ts");
    const inbound = await import("./aruba-inbound.server.ts");
    const user = await database
      .getPool()
      .query<{ id: string }>(
        "INSERT INTO users (username, password_hash, can_approve) VALUES ('Massimo', 'synthetic', true) RETURNING id",
      );
    const session = await inbound.issueArubaReadSession("synthetic-device-status-guard", {
      id: Number(user.rows[0]!.id),
      canApprove: true,
      requestId: "aruba-status-guard-test",
    });
    assert.deepEqual(await inbound.verifyArubaInventoryAccount(session.token, { documents: [] }), {
      verified: true,
      initialPairing: true,
    });

    await assert.rejects(
      inbound.ingestArubaInventoryPage(session.token, {
        stream: "invoices:2026",
        scanOrdinal: 1,
        pageOrdinal: 1,
        cursor: "unknown-statuses",
        terminal: true,
        fullScan: true,
        documents: Array.from({ length: 10 }, (_, index) => ({
          remoteId: `REMOTE-UNKNOWN-${index + 1}`,
          documentType: "TD01" as const,
          fiscalYear: 2026,
          series: "FPR",
          fiscalNumber: String(index + 1),
          documentDate: "2026-08-10",
          recipientName: "Cliente sintetico",
          recipientTaxId: null,
          recipientTaxIdentifiers: [],
          recipientCountryCode: null,
          recipientAddress: null,
          totalAmount: 1000,
          currency: "EUR" as const,
          status: "UNKNOWN" as const,
          providerStatusLabel: "Nuovo stato Aruba",
          providerObservedAt: null,
          xmlSha256: null,
          orderReferences: [],
        })),
      }),
      (error: unknown) =>
        error instanceof Error &&
        "code" in error &&
        error.code === "ARUBA_REMOTE_STATUS_UNRECOGNIZED",
    );
    assert.equal(
      (await database.getPool().query("SELECT count(*) FROM aruba_remote_documents")).rows[0].count,
      "0",
    );
  } finally {
    await database?.closePool();
    await fixture.drop();
  }
});
