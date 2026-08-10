import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import pg from "pg";

import { documentInputSchema } from "../documents.ts";
import { runMigrations } from "./migrations.server.ts";

import { temporaryDatabase, withClient } from "./database-fixture.ts";

const BASELINE = "001_baseline.sql";
const CONNECTORS = "002_connectors.sql";
const CONNECTOR_PRIVACY = "003_connector_privacy.sql";
const CONNECTOR_OPERATIONS = "004_connector_operations.sql";
const DOCUMENTS = "005_documents.sql";
const M4_COMPLETION = "006_m4_completion.sql";
const M4_LEGACY_DOCUMENTS = "007_m4_legacy_documents.sql";
const DOCUMENT_DEPLOY_COMPATIBILITY = "008_document_deploy_compatibility.sql";
const APPROVED_PAYMENT_HISTORY = "009_approved_payment_history.sql";
const DRAFT_RECIPIENT_SNAPSHOT = "010_draft_recipient_snapshot.sql";

test("la migrazione privacy aggiorna un database con i connettori già applicati", async () => {
  const database = await temporaryDatabase("connector_upgrade");
  const firstTwo = await mkdtemp(path.join(os.tmpdir(), "hub-fatture-first-two-"));
  try {
    await cp("migrations", firstTwo, { recursive: true });
    await rm(path.join(firstTwo, CONNECTOR_PRIVACY));
    await rm(path.join(firstTwo, CONNECTOR_OPERATIONS));
    await rm(path.join(firstTwo, DOCUMENTS));
    await rm(path.join(firstTwo, M4_COMPLETION));
    await rm(path.join(firstTwo, M4_LEGACY_DOCUMENTS));
    await rm(path.join(firstTwo, DOCUMENT_DEPLOY_COMPATIBILITY));
    await rm(path.join(firstTwo, APPROVED_PAYMENT_HISTORY));
    await rm(path.join(firstTwo, DRAFT_RECIPIENT_SNAPSHOT));
    assert.deepEqual(
      await runMigrations({ connectionString: database.connectionString, directory: firstTwo }),
      [BASELINE, CONNECTORS],
    );
    assert.deepEqual(await runMigrations({ connectionString: database.connectionString }), [
      CONNECTOR_PRIVACY,
      CONNECTOR_OPERATIONS,
      DOCUMENTS,
      M4_COMPLETION,
      M4_LEGACY_DOCUMENTS,
      DOCUMENT_DEPLOY_COMPATIBILITY,
      APPROVED_PAYMENT_HISTORY,
      DRAFT_RECIPIENT_SNAPSHOT,
    ]);
  } finally {
    await rm(firstTwo, { recursive: true, force: true });
    await database.drop();
  }
});

test("installazione vuota, checksum e guardie sull'ordine", { timeout: 30_000 }, async () => {
  const clean = await temporaryDatabase("clean");
  try {
    assert.deepEqual(await runMigrations({ connectionString: clean.connectionString }), [
      BASELINE,
      CONNECTORS,
      CONNECTOR_PRIVACY,
      CONNECTOR_OPERATIONS,
      DOCUMENTS,
      M4_COMPLETION,
      M4_LEGACY_DOCUMENTS,
      DOCUMENT_DEPLOY_COMPATIBILITY,
      APPROVED_PAYMENT_HISTORY,
      DRAFT_RECIPIENT_SNAPSHOT,
    ]);
    const cleanClient = new pg.Client({ connectionString: clean.connectionString });
    await cleanClient.connect();
    assert.equal(
      (await cleanClient.query("SELECT count(*) FROM schema_migrations")).rows[0].count,
      "10",
    );
    await cleanClient.end();

    const changed = await mkdtemp(path.join(os.tmpdir(), "hf-migrations-changed-"));
    await cp("migrations", changed, { recursive: true });
    await writeFile(
      path.join(changed, BASELINE),
      `${await readFile(path.join(changed, BASELINE), "utf8")}\n-- modifica vietata\n`,
    );
    await assert.rejects(
      runMigrations({ connectionString: clean.connectionString, directory: changed }),
      /Migrazione applicata modificata/,
    );
    await rm(path.join(changed, BASELINE));
    await assert.rejects(
      runMigrations({ connectionString: clean.connectionString, directory: changed }),
      /Migrazione applicata rimossa/,
    );

    // Una migrazione nuova che si ordina prima dell'ultima applicata salterebbe il proprio
    // turno: deve fallire invece di essere applicata fuori sequenza.
    const inserted = await mkdtemp(path.join(os.tmpdir(), "hf-migrations-inserted-"));
    await cp("migrations", inserted, { recursive: true });
    await writeFile(path.join(inserted, "000_inserted.sql"), "SELECT 1;\n");
    await assert.rejects(
      runMigrations({ connectionString: clean.connectionString, directory: inserted }),
      /Migrazione fuori ordine/,
    );

    await withClient(clean.connectionString, async (client) => {
      assert.equal(
        (await client.query("SELECT to_regclass('audit_events') AS table_name")).rows[0].table_name,
        "audit_events",
      );
      assert.equal(
        (await client.query("SELECT to_regclass('orders') AS table_name")).rows[0].table_name,
        "orders",
      );
      assert.equal(
        (
          await client.query(
            "SELECT to_regclass('audit_events_login_rate_scope_idx') AS index_name",
          )
        ).rows[0].index_name,
        "audit_events_login_rate_scope_idx",
      );
      assert.equal(
        (await client.query("SELECT value_json #>> '{}' AS trigger FROM settings")).rows[0].trigger,
        "PAID",
      );
      const customerId = (
        await client.query(
          `INSERT INTO customers
               (kind, match_key, display_name, billing_address_json, source_confidence, review_required)
             VALUES ('UNKNOWN', 'test-high-id', 'Test', '{}'::jsonb, 'AMBIGUOUS', true)
             RETURNING id`,
        )
      ).rows[0].id;
      // Il numero pubblico non tronca oltre le sei cifre: è la ragione per cui la sua
      // definizione era già stata rifatta due volte prima della baseline.
      await client.query("ALTER TABLE billing_cases ALTER COLUMN id RESTART WITH 1000000");
      assert.equal(
        (
          await client.query(
            `INSERT INTO billing_cases
                 (customer_id, local_order_date, currency, status, customer_snapshot_json)
               VALUES ($1, '2026-08-09', 'EUR', 'NEEDS_REVIEW', '{}'::jsonb)
               RETURNING public_number`,
            [customerId],
          )
        ).rows[0].public_number,
        "1000000",
      );
    });
  } finally {
    await clean.drop();
  }
});

test("l'aggiornamento deriva il pagamento e completa gli snapshot preesistenti", async () => {
  const database = await temporaryDatabase("m4_legacy_documents");
  const beforeM4 = await mkdtemp(path.join(os.tmpdir(), "hub-fatture-before-m4-"));
  let deployCaseId: string | undefined;
  try {
    await cp("migrations", beforeM4, { recursive: true });
    await rm(path.join(beforeM4, M4_COMPLETION));
    await rm(path.join(beforeM4, M4_LEGACY_DOCUMENTS));
    await rm(path.join(beforeM4, DOCUMENT_DEPLOY_COMPATIBILITY));
    await rm(path.join(beforeM4, APPROVED_PAYMENT_HISTORY));
    await rm(path.join(beforeM4, DRAFT_RECIPIENT_SNAPSHOT));
    await runMigrations({ connectionString: database.connectionString, directory: beforeM4 });

    await withClient(database.connectionString, async (client) => {
      const customer = await client.query<{ id: string }>(
        `INSERT INTO customers
             (kind, match_key, display_name, billing_address_json, source_confidence, review_required)
           VALUES ('PRIVATE_IT', 'm4-legacy', 'Mario Rossi', '{}', 'TAX_ID', false)
           RETURNING id`,
      );
      const customerId = customer.rows[0]!.id;
      const profile = {
        payment: { condition: "TP02", invoiceMethod: "MP01", creditNoteMethod: "MP05" },
      };
      await client.query(
        `INSERT INTO fiscal_profiles (version, status, profile_json)
         VALUES (1, 'MOCK', $1)`,
        [profile],
      );
      const cases = await client.query<{ id: string }>(
        `INSERT INTO billing_cases
             (customer_id, local_order_date, currency, status, customer_snapshot_json,
              fiscal_profile_version)
           VALUES
             ($1, '2026-08-09', 'EUR', 'READY', '{}', 1),
             ($1, '2026-08-10', 'EUR', 'APPROVED', '{}', 1),
             ($1, '2026-08-11', 'EUR', 'READY', '{}', 1)
           RETURNING id`,
        [customerId],
      );
      deployCaseId = cases.rows[2]!.id;
      const orders = await client.query<{ id: string }>(
        `INSERT INTO orders
             (provider, external_account_id, external_order_id, display_number,
              created_at_source, updated_at_source, local_order_date, currency, gross_amount,
              payment_status, fulfillment_status, trigger_status, customer_id, billing_case_id,
              raw_snapshot_json, normalized_snapshot_json)
           VALUES
             ('SHOPIFY', 'm4', 'pending', '#PENDING', now(), now(), '2026-08-09', 'EUR',
              1000, 'PENDING', 'FULFILLED', 'GROUPED', $1, $2, '{}', '{}'),
             ('SHOPIFY', 'm4', 'paid', '#PAID', now(), now(), '2026-08-10', 'EUR',
              1000, 'PAID', 'FULFILLED', 'INVOICED', $1, $3, '{}', '{}'),
             ('SHOPIFY', 'm4', 'deploy-window', '#DEPLOY', now(), now(), '2026-08-11', 'EUR',
              1000, 'PENDING', 'FULFILLED', 'GROUPED', $1, $4, '{}', '{}')
           RETURNING id`,
        [customerId, cases.rows[0]!.id, cases.rows[1]!.id, cases.rows[2]!.id],
      );
      const draft = await client.query<{ id: string }>(
        `INSERT INTO documents
             (billing_case_id, kind, status, document_type, series, document_date,
              fiscal_profile_version, currency, total_amount, source_total_amount,
              difference_amount, projection_sha256)
           VALUES ($1, 'INVOICE', 'DRAFT', 'TD01', 'FPR', '2026-08-09', 1, 'EUR',
                   1000, 1000, 0, $2)
           RETURNING id`,
        [cases.rows[0]!.id, "a".repeat(64)],
      );
      await client.query(
        `INSERT INTO document_orders (document_id, document_kind, order_id, amount)
         VALUES ($1, 'INVOICE', $2, 1000)`,
        [draft.rows[0]!.id, orders.rows[0]!.id],
      );

      const storage = await client.query<{ id: string }>(
        `INSERT INTO storage_objects
             (kind, relative_path, sha256, size_bytes, content_type)
           VALUES ('INVOICE_XML', 'legacy.xml', $1, 1, 'application/xml')
           RETURNING id`,
        ["b".repeat(64)],
      );
      const approved = await client.query<{ id: string }>(
        `INSERT INTO documents
             (billing_case_id, kind, status, document_type, series, document_date,
              fiscal_profile_version, currency, total_amount, source_total_amount,
              difference_amount, projection_sha256)
           VALUES ($1, 'INVOICE', 'DRAFT', 'TD01', 'FPR', '2026-08-10', 1, 'EUR',
                   1000, 1000, 0, $2)
           RETURNING id`,
        [cases.rows[1]!.id, "c".repeat(64)],
      );
      await client.query(
        `INSERT INTO document_orders (document_id, document_kind, order_id, amount)
         VALUES ($1, 'INVOICE', $2, 1000)`,
        [approved.rows[0]!.id, orders.rows[1]!.id],
      );
      await client.query(
        `UPDATE documents
         SET status = 'APPROVED', fiscal_year = 2026, fiscal_number = 1,
             immutable_snapshot_json = $2, fiscal_profile_snapshot_json = $3,
             approved_at = now(), pending_payment_confirmed_at = now(),
             xml_sha256 = $4, storage_object_id = $5
         WHERE id = $1`,
        [
          approved.rows[0]!.id,
          {
            kind: "INVOICE",
            documentDate: "2026-08-10",
            recipient: {
              kind: "PRIVATE_IT",
              firstName: "Mario",
              lastName: "Rossi",
              taxIdentifiers: [{ type: "CODICE_FISCALE", value: "RSSMRA80A01H501U" }],
              address: {
                line1: "Via Roma 1",
                postalCode: "00100",
                city: "Roma",
                province: "RM",
                countryCode: "IT",
              },
            },
            lines: [{ description: "Moneta", quantity: 1, unitAmount: 1000 }],
          },
          profile,
          "b".repeat(64),
          storage.rows[0]!.id,
        ],
      );
    });

    assert.deepEqual(await runMigrations({ connectionString: database.connectionString }), [
      M4_COMPLETION,
      M4_LEGACY_DOCUMENTS,
      DOCUMENT_DEPLOY_COMPATIBILITY,
      APPROVED_PAYMENT_HISTORY,
      DRAFT_RECIPIENT_SNAPSHOT,
    ]);
    assert.ok(deployCaseId);
    await withClient(database.connectionString, async (client) => {
      await client.query(
        `INSERT INTO documents
             (billing_case_id, kind, status, document_type, series, document_date,
              fiscal_profile_version, currency, total_amount, source_total_amount,
              difference_amount, projection_sha256)
           VALUES ($1, 'INVOICE', 'DRAFT', 'TD01', 'FPR', '2026-08-11', 1, 'EUR',
                   1000, 1000, 0, $2)`,
        [deployCaseId, "d".repeat(64)],
      );
      const result = await client.query<{
        status: string;
        payment_status: string;
        payment_method: string;
        immutable_snapshot_json: unknown;
        recipient_snapshot_json: unknown;
      }>(
        `SELECT status, payment_status, payment_method, immutable_snapshot_json,
                recipient_snapshot_json
         FROM documents ORDER BY id`,
      );
      assert.deepEqual(
        result.rows.map(({ status, payment_status, payment_method }) => ({
          status,
          payment_status,
          payment_method,
        })),
        [
          { status: "DRAFT", payment_status: "PENDING", payment_method: "MP01" },
          { status: "APPROVED", payment_status: "PENDING", payment_method: "MP01" },
          { status: "DRAFT", payment_status: "PENDING", payment_method: "MP01" },
        ],
      );
      documentInputSchema.parse(result.rows[1]!.immutable_snapshot_json);
      assert.ok(result.rows.every((row) => row.recipient_snapshot_json));
    });
  } finally {
    await rm(beforeM4, { recursive: true, force: true });
    await database.drop();
  }
});
