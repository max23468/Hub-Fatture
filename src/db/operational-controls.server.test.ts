import assert from "node:assert/strict";
import test from "node:test";

import { temporaryDatabase } from "./database-fixture.ts";
import { runMigrations } from "./migrations.server.ts";

test(
  "i controlli operativi restano stabili, deduplicati e si chiudono con la causa",
  { timeout: 45_000 },
  async () => {
    const clean = await temporaryDatabase("operational_controls");
    try {
      await runMigrations({ connectionString: clean.connectionString });
      process.env.APP_ENV = "test";
      process.env.APP_BASE_URL = "http://localhost:8080";
      process.env.ADMIN_BOOTSTRAP_TOKEN = "synthetic-bootstrap-token-for-tests";
      process.env.DATABASE_URL = clean.connectionString;

      const database = await import("./client.server.ts");
      const controls = await import("./operational-controls.server.ts");
      await database
        .getPool()
        .query(
          "INSERT INTO users (username, password_hash, can_approve) VALUES ('Massimo', 'synthetic', true)",
        );
      const customer = await database.getPool().query<{ id: string }>(
        `INSERT INTO customers
           (kind, match_key, display_name, billing_address_json,
            source_confidence, review_required)
         VALUES ('UNKNOWN', 'control-stability', 'Cliente da verificare', '{}',
                 'AMBIGUOUS', true)
         RETURNING id::text`,
      );

      const historicalFlag = await controls.readOperationalControls({ origin: "CUSTOMERS" });
      assert.equal(historicalFlag.total, 0);

      const billingCase = await database.getPool().query<{ id: string }>(
        `INSERT INTO billing_cases
           (customer_id, local_order_date, currency, status, customer_snapshot_json)
         VALUES ($1, '2026-08-31', 'EUR', 'NEEDS_REVIEW',
                 '{"displayName":"Cliente da verificare","reviewRequired":true,
                   "canonicalProfile":{}}')
         RETURNING id::text`,
        [customer.rows[0]!.id],
      );
      await database.getPool().query(
        `INSERT INTO orders
           (provider, external_account_id, external_order_id, display_number,
            created_at_source, updated_at_source, local_order_date, currency, gross_amount,
            payment_status, fulfillment_status, trigger_status, customer_id, billing_case_id,
            raw_snapshot_json, normalized_snapshot_json)
         VALUES ('SHOPIFY', 'operational-controls', 'actionable-customer', '#CONTROL',
                 now(), now(), '2026-08-31', 'EUR', 1000, 'PAID', 'FULFILLED', 'GROUPED',
                 $1, $2, '{}',
                 '{"customerReviewRequired":true,"deferredReviewRequired":false,
                   "totalsReconciled":true,"customerSnapshot":{"canonicalProfile":{}}}')`,
        [customer.rows[0]!.id, billingCase.rows[0]!.id],
      );

      assert.equal((await controls.readOperationalControlSummary()).open, 0);
      await controls.refreshOperationalControls();
      const first = await controls.readOperationalControls({ origin: "CUSTOMERS" });
      assert.equal(first.rows.length, 1);
      assert.equal(first.total, 1);
      assert.equal(first.rows[0]!.id, `CUSTOMER_IDENTITY:${customer.rows[0]!.id}`);
      assert.equal(first.rows[0]!.state, "OPEN");
      assert.equal(
        first.rows[0]!.href,
        `/ordini/preparazione/${billingCase.rows[0]!.id}#dati-destinatario`,
      );
      assert.equal(first.rows[0]!.primary_action, "Correggi destinatario");
      assert.match(first.rows[0]!.detail, /Tipo cliente/);
      assert.deepEqual(first.rows[0]!.metadata_json.facts, [
        { label: "Cliente", value: "Cliente da verificare" },
        { label: "Da completare", value: "Tipo cliente, Via, CAP, Città, Paese" },
      ]);

      const repeated = await controls.readOperationalControls({ origin: "CUSTOMERS" });
      assert.equal(repeated.total, 1);
      assert.equal(repeated.rows[0]!.id, first.rows[0]!.id);
      assert.equal(String(repeated.rows[0]!.opened_at), String(first.rows[0]!.opened_at));
      assert.equal(
        (
          await database
            .getPool()
            .query("SELECT count(*) FROM operational_controls WHERE source_type = 'CUSTOMER'")
        ).rows[0].count,
        "1",
      );

      await database
        .getPool()
        .query("UPDATE billing_cases SET status = 'READY' WHERE id = $1", [
          billingCase.rows[0]!.id,
        ]);
      await controls.refreshOperationalControls();
      assert.equal((await controls.readOperationalControlSummary()).open, 0);
      assert.equal(
        (
          await database
            .getPool()
            .query("SELECT state FROM operational_controls WHERE id = $1", [first.rows[0]!.id])
        ).rows[0].state,
        "RESOLVED",
      );

      await database
        .getPool()
        .query("UPDATE billing_cases SET status = 'NEEDS_REVIEW' WHERE id = $1", [
          billingCase.rows[0]!.id,
        ]);
      await controls.refreshOperationalControls();
      const reopened = await controls.readOperationalControls({ origin: "CUSTOMERS" });
      assert.equal(reopened.total, 1);
      assert.equal(reopened.rows[0]!.id, first.rows[0]!.id);
      assert.equal(reopened.rows[0]!.state, "OPEN");

      await database
        .getPool()
        .query("UPDATE orders SET trigger_status = 'NEEDS_REVIEW' WHERE billing_case_id = $1", [
          billingCase.rows[0]!.id,
        ]);
      assert.equal((await controls.readOperationalControls({ origin: "ORDERS" })).total, 0);
      await database.getPool().query(
        `UPDATE orders SET normalized_snapshot_json = jsonb_set(
           normalized_snapshot_json, '{sourceConflictRequired}', 'true'::jsonb)
         WHERE billing_case_id = $1`,
        [billingCase.rows[0]!.id],
      );
      await controls.refreshOperationalControls();
      const preparationCauses = await controls.readOperationalControls({ origin: "ORDERS" });
      assert.deepEqual(
        preparationCauses.rows.map(({ kind }) => kind),
        ["SOURCE_CONFLICT"],
      );
      assert.equal(
        preparationCauses.rows.some(({ kind }) => kind === "BILLING_CASE_REVIEW"),
        false,
      );

      await database.getPool().query(
        `UPDATE orders SET trigger_status = 'GROUPED',
           normalized_snapshot_json = jsonb_set(
             jsonb_set(
               normalized_snapshot_json, '{deferredReviewRequired}', 'false'::jsonb),
             '{sourceConflictRequired}', 'false'::jsonb
           )
         WHERE billing_case_id = $1`,
        [billingCase.rows[0]!.id],
      );
      await controls.refreshOperationalControls();
      assert.equal((await controls.readOperationalControls({ origin: "ORDERS" })).total, 0);

      await database
        .getPool()
        .query(
          "INSERT INTO fiscal_profiles (version, status, profile_json) VALUES (1, 'MOCK', '{}')",
        );
      await database.getPool().query(
        `WITH issued_case AS (
           INSERT INTO billing_cases
             (customer_id, local_order_date, currency, status, customer_snapshot_json,
              fiscal_profile_version)
           VALUES ($1, '2026-08-31', 'EUR', 'CLOSED', '{}', 1)
           RETURNING id
         ), stored AS (
           INSERT INTO storage_objects
             (kind, relative_path, sha256, size_bytes, content_type)
           VALUES ('ARUBA_XML', 'aruba/history/customer-control.xml', repeat('a', 64),
                   100, 'application/xml')
           RETURNING id
         ), issued AS (
           INSERT INTO documents
             (billing_case_id, kind, status, document_type, series, fiscal_year,
              fiscal_number, document_date, fiscal_profile_version, currency,
              total_amount, source_total_amount, difference_amount, projection_sha256,
              approved_at, xml_sha256, immutable_snapshot_json,
              fiscal_profile_snapshot_json, storage_object_id, payment_status,
              payment_method, recipient_snapshot_json, origin)
           SELECT issued_case.id, 'INVOICE', 'APPROVED', 'TD01', 'FPR', 2026, 4061,
                  '2026-08-31', 1, 'EUR', 1000, 1000, 0, repeat('b', 64), now(),
                  repeat('b', 64), '{}', '{}', stored.id, 'PAID', 'MP08', '{}',
                  'ARUBA_HISTORY'
           FROM issued_case, stored
           RETURNING id
         )
         INSERT INTO document_orders (document_id, document_kind, order_id, amount)
         SELECT issued.id, 'INVOICE', orders.id, 1000
         FROM issued, orders
         WHERE orders.external_order_id = 'actionable-customer'`,
        [customer.rows[0]!.id],
      );
      await controls.refreshOperationalControls();
      assert.equal((await controls.readOperationalControls({ origin: "CUSTOMERS" })).total, 0);
      assert.equal(
        (
          await database
            .getPool()
            .query("SELECT state FROM operational_controls WHERE id = $1", [first.rows[0]!.id])
        ).rows[0].state,
        "RESOLVED",
      );

      await database.getPool().query(
        `INSERT INTO operational_controls
           (id, kind, category, severity, state, source_type, source_id, origin, title,
            detail, consequence, href, primary_action, fingerprint, opened_at)
         SELECT 'BULK_CONTROL:' || sequence, 'ORDER_REVIEW', 'DECISION', 'ORDINARY',
                'OPEN', 'ORDER', sequence::text, 'ORDERS',
                'Controllo paginato ' || sequence,
                CASE WHEN sequence = 144 THEN 'riferimento needle-144' ELSE 'dettaglio' END,
                'Conseguenza sintetica', '/ordini', 'Apri ordini', repeat('f', 64),
                '2026-01-01T00:00:00Z'::timestamptz + sequence * interval '1 minute'
         FROM generate_series(1, 144) AS sequence`,
      );
      const firstPage = await controls.readOperationalControls({ origin: "ORDERS" });
      assert.equal(firstPage.total, 144);
      assert.equal(firstPage.rows.length, 50);
      assert.equal(firstPage.previousCursor, null);
      assert.ok(firstPage.nextCursor);
      const secondPage = await controls.readOperationalControls({
        origin: "ORDERS",
        cursor: firstPage.nextCursor!,
      });
      assert.equal(secondPage.rows.length, 50);
      assert.ok(secondPage.previousCursor);
      assert.ok(secondPage.nextCursor);
      const thirdPage = await controls.readOperationalControls({
        origin: "ORDERS",
        cursor: secondPage.nextCursor!,
      });
      assert.equal(thirdPage.rows.length, 44);
      assert.equal(thirdPage.nextCursor, null);
      const backToSecond = await controls.readOperationalControls({
        origin: "ORDERS",
        cursor: thirdPage.previousCursor!,
      });
      assert.deepEqual(
        backToSecond.rows.map(({ id }) => id),
        secondPage.rows.map(({ id }) => id),
      );
      const searched = await controls.readOperationalControls({ search: "needle-144" });
      assert.equal(searched.total, 1);
      assert.equal(searched.rows[0]!.id, "BULK_CONTROL:144");
      assert.equal((await controls.readOperationalControls({ search: "%" })).total, 0);

      await controls.markOperationalControlWaiting("BULK_CONTROL:144", {
        reason: "FOLLOW_UP",
        dueDate: "2099-12-31",
        assigneeUsername: "Massimo",
        note: "Verifica assegnata",
      });
      const waiting = await controls.readOperationalControls({ state: "WAITING" });
      assert.equal(waiting.rows[0]!.waiting_reason, "FOLLOW_UP");
      assert.equal(waiting.rows[0]!.assignee_username, "Massimo");
      assert.equal(new Date(waiting.rows[0]!.due_at!).toISOString().slice(0, 10), "2099-12-31");
      await controls.reopenOperationalControl("BULK_CONTROL:144");
      assert.equal((await controls.readOperationalControls({ state: "WAITING" })).total, 0);

      await database.getPool().query(
        `INSERT INTO jobs (type, status, attempts, max_attempts, last_error_code)
         VALUES ('maintenance_retention', 'FAILED', 5, 5, 'RETENTION_FAILED')`,
      );
      await controls.refreshOperationalControls();
      const retentionFailure = await controls.readOperationalControls({ kind: "RETENTION_FAILED" });
      assert.equal(retentionFailure.total, 1);
      assert.equal(retentionFailure.rows[0]!.severity, "BLOCKING");
      assert.equal(retentionFailure.rows[0]!.href, "/impostazioni#sistema");
      assert.ok(retentionFailure.rows[0]!.metadata_json.jobId);
    } finally {
      const database = await import("./client.server.ts");
      await database.closePool();
      await clean.drop();
    }
  },
);
