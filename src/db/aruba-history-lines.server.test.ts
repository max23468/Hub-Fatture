import assert from "node:assert/strict";
import test from "node:test";

import { temporaryDatabase } from "./database-fixture.ts";
import { runMigrations } from "./migrations.server.ts";

test("i documenti Aruba storici materializzano righe immutabili", async () => {
  const fixture = await temporaryDatabase("aruba_history_lines");
  try {
    await runMigrations({ connectionString: fixture.connectionString });
    process.env.APP_ENV = "test";
    process.env.APP_BASE_URL = "http://localhost:8080";
    process.env.ADMIN_BOOTSTRAP_TOKEN = "synthetic-bootstrap-token-for-tests";
    process.env.DATABASE_URL = fixture.connectionString;

    const database = await import("./client.server.ts");
    const customer = await database.getPool().query<{ id: string }>(
      `INSERT INTO customers
        (kind, match_key, display_name, billing_address_json, source_confidence, review_required)
       VALUES ('PRIVATE_IT', 'history-lines-customer', 'Cliente sintetico', '{}', 'TAX_ID', false)
       RETURNING id`,
    );
    const billingCase = await database.getPool().query<{ id: string }>(
      `INSERT INTO billing_cases
        (customer_id, local_order_date, currency, status, customer_snapshot_json)
       VALUES ($1, '2026-08-16', 'EUR', 'CLOSED', '{}') RETURNING id`,
      [customer.rows[0]!.id],
    );
    await database.getPool().query(
      `INSERT INTO fiscal_profiles (version, status, profile_json)
       VALUES (1, 'MOCK', '{"payment":{"invoiceMethod":"MP08","creditNoteMethod":"MP05"}}')`,
    );
    const storage = await database.getPool().query<{ id: string }>(
      `INSERT INTO storage_objects
        (kind, relative_path, sha256, size_bytes, content_type)
       VALUES ('ARUBA_XML', 'aruba/history-lines.xml', repeat('d', 64), 10, 'application/xml')
       RETURNING id`,
    );
    const document = await database.getPool().query<{ id: string }>(
      `INSERT INTO documents
        (billing_case_id, kind, status, document_type, series, fiscal_year, fiscal_number,
         document_date, fiscal_profile_version, currency, total_amount, source_total_amount,
         difference_amount, draft_version, projection_sha256, approved_at, xml_sha256,
         immutable_snapshot_json, fiscal_profile_snapshot_json, storage_object_id,
         recipient_snapshot_json, origin)
       VALUES ($1, 'INVOICE', 'APPROVED', 'TD01', 'FPR', 2026, 99, '2026-08-16', 1,
         'EUR', 2500, 2500, 0, 1, repeat('e', 64), now(), repeat('f', 64),
         '{"recipient":{},"lines":[{"description":"Linea esterna","quantity":1,"unitAmount":2500}],"paymentStatus":"PAID","paymentMethod":"MP08"}',
         '{}', $2, '{}', 'ARUBA_HISTORY')
       RETURNING id`,
      [billingCase.rows[0]!.id, storage.rows[0]!.id],
    );

    const lines = await database.getPool().query<{
      line_number: number;
      description: string;
      quantity: number;
      unit_amount: number;
      total_amount: number;
      order_id: string | null;
    }>(
      `SELECT line_number, description, quantity, unit_amount, total_amount, order_id
       FROM document_lines WHERE document_id = $1 ORDER BY line_number`,
      [document.rows[0]!.id],
    );
    assert.deepEqual(lines.rows, [
      {
        line_number: 1,
        description: "Linea esterna",
        quantity: 1,
        unit_amount: 2500,
        total_amount: 2500,
        order_id: null,
      },
    ]);

    await assert.rejects(() =>
      database.getPool().query(
        `INSERT INTO document_lines
          (document_id, line_number, description, quantity, unit_amount, total_amount, tax_nature)
         VALUES ($1, 2, 'Mutazione vietata', 1, 1, 1, 'N5')`,
        [document.rows[0]!.id],
      ),
    );
  } finally {
    await import("./client.server.ts").then(({ closePool }) => closePool());
    await fixture.drop();
  }
});
