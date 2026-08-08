import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import pg from "pg";

import { hashToken } from "../crypto.server.ts";
import { AppError } from "../errors.ts";
import { runMigrations } from "./migrations.server.ts";

// Nessuno skip silenzioso: senza database il gate deve dirlo, non passare in verde.
function requireTestDatabase(): string {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    throw new Error(
      "TEST_DATABASE_URL assente: avvia `docker compose --profile test up -d postgres-test` ed esportala.",
    );
  }
  return url;
}

const adminUrl = requireTestDatabase();

async function withClient<T>(
  connectionString: string,
  callback: (client: pg.Client) => Promise<T>,
) {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    return await callback(client);
  } finally {
    await client.end();
  }
}

async function temporaryDatabase(suffix: string) {
  const name = `hub_fatture_${process.pid}_${suffix}`;
  const url = new URL(adminUrl);
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  url.pathname = `/${name}`;
  return {
    connectionString: url.toString(),
    async drop() {
      const client = new pg.Client({ connectionString: adminUrl });
      await client.connect();
      await client.query(`DROP DATABASE ${name} WITH (FORCE)`);
      await client.end();
    },
  };
}

async function waitForBlockedQuery(client: pg.Client) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const waiting = await client.query<{ waiting: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_stat_activity
         WHERE datname = current_database()
           AND pid <> pg_backend_pid()
           AND wait_event_type = 'Lock'
       ) AS waiting`,
    );
    if (waiting.rows[0]!.waiting) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Nessuna query bloccata nel database di test");
}

test(
  "installazione vuota, checksum e upgrade preservano lo snapshot",
  { timeout: 30_000 },
  async () => {
    const clean = await temporaryDatabase("clean");
    const upgrade = await temporaryDatabase("upgrade");
    try {
      assert.deepEqual(await runMigrations({ connectionString: clean.connectionString }), [
        "001_foundations.sql",
        "002_auth_audit.sql",
        "003_login_ip.sql",
        "004_reset_password_hashes.sql",
        "005_order_domain.sql",
        "006_billing_case_customer_snapshot.sql",
        "007_order_source_revisions.sql",
        "008_invoiced_order_status.sql",
        "009_unprefixed_billing_case_number.sql",
        "010_order_domain_hardening.sql",
        "011_unbounded_billing_case_number.sql",
      ]);
      const cleanClient = new pg.Client({ connectionString: clean.connectionString });
      await cleanClient.connect();
      assert.equal(
        (await cleanClient.query("SELECT count(*) FROM schema_migrations")).rows[0].count,
        "11",
      );
      await cleanClient.end();

      const changed = await mkdtemp(path.join(os.tmpdir(), "hf-migrations-changed-"));
      await cp("migrations", changed, { recursive: true });
      await writeFile(
        path.join(changed, "001_foundations.sql"),
        `${await readFile(path.join(changed, "001_foundations.sql"), "utf8")}\n-- modifica vietata\n`,
      );
      await assert.rejects(
        runMigrations({ connectionString: clean.connectionString, directory: changed }),
        /Migrazione applicata modificata/,
      );
      await rm(path.join(changed, "001_foundations.sql"));
      await assert.rejects(
        runMigrations({ connectionString: clean.connectionString, directory: changed }),
        /Migrazione applicata rimossa/,
      );

      const inserted = await mkdtemp(path.join(os.tmpdir(), "hf-migrations-inserted-"));
      await cp("migrations", inserted, { recursive: true });
      await writeFile(path.join(inserted, "001_inserted.sql"), "SELECT 1;\n");
      await assert.rejects(
        runMigrations({ connectionString: clean.connectionString, directory: inserted }),
        /Migrazione fuori ordine/,
      );

      const firstOnly = await mkdtemp(path.join(os.tmpdir(), "hf-migrations-first-"));
      await cp("migrations/001_foundations.sql", path.join(firstOnly, "001_foundations.sql"));
      await runMigrations({ connectionString: upgrade.connectionString, directory: firstOnly });
      await withClient(upgrade.connectionString, async (client) => {
        await client.query(
          "INSERT INTO users (username, password_hash) VALUES ('matteo', 'synthetic')",
        );
      });
      await runMigrations({ connectionString: upgrade.connectionString });
      await withClient(upgrade.connectionString, async (client) => {
        // Il cambio di formato degli hash rimuove gli account invece di conservare un percorso
        // di verifica legacy: senza questo l'installazione esistente resterebbe esclusa.
        assert.equal((await client.query("SELECT count(*) FROM users")).rows[0].count, "0");
        assert.equal(
          (await client.query("SELECT to_regclass('audit_events') AS table_name")).rows[0]
            .table_name,
          "audit_events",
        );
        assert.equal(
          (await client.query("SELECT to_regclass('orders') AS table_name")).rows[0].table_name,
          "orders",
        );
        const customerId = (
          await client.query(
            `INSERT INTO customers
               (kind, match_key, display_name, billing_address_json, source_confidence, review_required)
             VALUES ('UNKNOWN', 'test-high-id', 'Test', '{}'::jsonb, 'AMBIGUOUS', true)
             RETURNING id`,
          )
        ).rows[0].id;
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

      process.env.APP_ENV = "test";
      process.env.APP_BASE_URL = "http://localhost:8080";
      process.env.ADMIN_BOOTSTRAP_TOKEN = "synthetic-bootstrap-token-for-tests";
      process.env.DATABASE_URL = clean.connectionString;
      const auth = await import("../auth.server.ts");
      const settings = await import("./settings.server.ts");
      const orders = await import("../orders.server.ts");
      const database = await import("./client.server.ts");
      assert.equal(
        await auth.getSessionUser(
          new Request("http://localhost:8080", { headers: { cookie: "invalid=%E0%A4%A" } }),
        ),
        null,
      );
      await assert.rejects(
        auth.setupAccounts({
          bootstrapToken: process.env.ADMIN_BOOTSTRAP_TOKEN,
          ownerPassword: "sette77",
          agentPassword: "codex888",
          requestId: "test-invalid-setup",
        }),
        /8 a 128 caratteri/,
      );
      await auth.setupAccounts({
        bootstrapToken: process.env.ADMIN_BOOTSTRAP_TOKEN,
        ownerPassword: "matteo88",
        agentPassword: "codex888",
        requestId: "test-setup",
      });
      const sessionCookies = await auth.login({
        username: "matteo",
        password: "matteo88",
        ipHash: "origine-titolare",
        requestId: "test-login",
      });
      const request = new Request("http://localhost:8080", {
        headers: { cookie: sessionCookies.map((value) => value.split(";", 1)[0]).join("; ") },
      });
      assert.equal((await auth.getSessionUser(request))?.username, "matteo");
      const sessionToken = sessionCookies
        .find((value) => value.startsWith("sessione="))!
        .split("=", 2)[1]!
        .split(";", 1)[0]!;
      assert.equal(
        (
          await database
            .getPool()
            .query("SELECT count(*) FROM sessions WHERE id_hash = $1", [sessionToken])
        ).rows[0].count,
        "0",
      );
      assert.equal(
        (
          await database
            .getPool()
            .query("SELECT count(*) FROM sessions WHERE id_hash = $1", [hashToken(sessionToken)])
        ).rows[0].count,
        "1",
      );
      const csrf = sessionCookies
        .find((value) => value.startsWith("csrf="))!
        .split("=", 2)[1]!
        .split(";", 1)[0]!;
      await auth.logout(request, csrf);
      assert.equal(await auth.getSessionUser(request), null);
      assert.equal(
        (
          await database
            .getPool()
            .query("SELECT count(*) FROM audit_events WHERE action = 'LOGOUT_SUCCEEDED'")
        ).rows[0].count,
        "1",
      );

      await auth.login({
        username: "codex",
        password: "codex888",
        ipHash: "origine-agente",
        requestId: "test-agent-login",
      });

      const attacco = [];
      for (let index = 0; index < 7; index += 1) {
        attacco.push(
          await auth
            .login({
              username: "codex",
              password: `password-errata-${index}`,
              ipHash: "origine-attaccante",
              requestId: `test-rate-limit-${index}`,
            })
            .then(() => null)
            .catch((error: unknown) => error),
        );
      }
      assert.equal(
        attacco.filter(
          (error) => error instanceof AppError && error.code === "AUTH_INVALID_CREDENTIALS",
        ).length,
        5,
      );
      assert.equal(
        attacco.filter((error) => error instanceof AppError && error.code === "AUTH_RATE_LIMITED")
          .length,
        2,
      );
      // Oltre la soglia nemmeno la password giusta viene verificata: il limite è reale.
      await assert.rejects(
        auth.login({
          username: "codex",
          password: "codex888",
          ipHash: "origine-attaccante",
          requestId: "test-rate-limit-credenziale-valida",
        }),
        /Troppi tentativi/,
      );
      // Il titolare arriva da un'altra origine e non viene escluso da quell'attacco.
      assert.equal(
        (
          await auth.login({
            username: "codex",
            password: "codex888",
            ipHash: "origine-agente",
            requestId: "test-rate-limit-titolare",
          })
        ).length,
        2,
      );
      // Il percorso bloccato non scrive: sotto flood la tabella non cresce con le richieste.
      assert.equal(
        (
          await database
            .getPool()
            .query("SELECT count(*) FROM login_attempts WHERE ip_hash = 'origine-attaccante'")
        ).rows[0].count,
        "5",
      );
      // Sotto concorrenza il contatore può scavalcare la soglia senza mai assumerne il valore:
      // la deduplica dell'audit deve reggere anche allora.
      await database
        .getPool()
        .query(
          "INSERT INTO login_attempts (username, ip_hash, successful) SELECT 'matteo', 'origine-parallela', false FROM generate_series(1, 7)",
        );
      await assert.rejects(
        auth.login({
          username: "matteo",
          password: "matteo88",
          ipHash: "origine-parallela",
          requestId: "test-soglia-scavalcata",
        }),
        /Troppi tentativi/,
      );
      assert.equal(
        (
          await database
            .getPool()
            .query(
              "SELECT count(*) FROM audit_events WHERE action = 'LOGIN_RATE_LIMITED' AND metadata_json->>'scope' = 'origine-parallela'",
            )
        ).rows[0].count,
        "1",
      );
      // L'accesso legittimo non deve azzerare il contatore di chi sta attaccando lo stesso
      // username da un'altra origine.
      await assert.rejects(
        auth.login({
          username: "codex",
          password: "codex888",
          ipHash: "origine-attaccante",
          requestId: "test-rate-limit-persiste",
        }),
        /Troppi tentativi/,
      );
      // Una riga per episodio: l'audit resta osservabile senza crescere sotto attacco.
      assert.equal(
        (
          await database
            .getPool()
            .query(
              "SELECT count(*) FROM audit_events WHERE action = 'LOGIN_RATE_LIMITED' AND metadata_json->>'scope' = 'origine-attaccante'",
            )
        ).rows[0].count,
        "1",
      );
      await database.getPool().query(
        `INSERT INTO sessions (id_hash, user_id, csrf_token_hash, expires_at)
           SELECT 'scaduta', id, 'scaduta', now() - interval '1 hour' FROM users WHERE username = 'codex'`,
      );
      const retention = await import("../retention.server.ts");
      await retention.pruneExpired();
      // La potatura di 17.7 dipende dal tempo trascorso, non dall'arrivo del prossimo login.
      assert.equal(
        (await database.getPool().query("SELECT count(*) FROM sessions WHERE id_hash = 'scaduta'"))
          .rows[0].count,
        "0",
      );

      assert.deepEqual(await settings.updateSetting("example", { enabled: true }, 0), {
        value: { enabled: true },
        version: 1,
      });
      await assert.rejects(
        settings.updateSetting("example", { enabled: false }, 0),
        /I dati sono cambiati/,
      );
      assert.deepEqual(await settings.getSetting("example"), {
        value: { enabled: true },
        version: 1,
      });
      const concurrentSettings = await Promise.allSettled([
        settings.updateSetting("concurrent", { writer: 1 }, 0),
        settings.updateSetting("concurrent", { writer: 2 }, 0),
      ]);
      assert.equal(concurrentSettings.filter(({ status }) => status === "fulfilled").length, 1);
      assert.equal(
        concurrentSettings.filter(
          (result) =>
            result.status === "rejected" &&
            result.reason instanceof AppError &&
            result.reason.code === "CONFLICT_REVISION",
        ).length,
        1,
      );
      assert.equal(
        (
          await database
            .getPool()
            .query(
              "SELECT count(DISTINCT actor_id) FROM audit_events WHERE action = 'LOGIN_SUCCEEDED'",
            )
        ).rows[0].count,
        "2",
      );

      const fixture = JSON.parse(
        await readFile("tests/fixtures/orders/normalized.mock.json", "utf8"),
      );
      await assert.rejects(
        orders.importOrders([fixture[0], fixture[0]], {
          id: 1,
          requestId: "test-duplicate-order-in-batch",
        }),
        (error: unknown) => error instanceof AppError && error.code === "ORDER_INVALID_INPUT",
      );
      assert.deepEqual(
        await orders.importOrders(fixture, { id: 1, requestId: "test-order-import" }),
        { imported: 3, updated: 0, ignored: 0 },
      );
      assert.deepEqual(
        await orders.importOrders(fixture, { id: 1, requestId: "test-order-reimport" }),
        { imported: 0, updated: 3, ignored: 0 },
      );
      await database.getPool().query(
        `INSERT INTO payments
          (order_id, external_payment_id, method, status, amount, paid_at,
           recorded_manually, raw_json)
         SELECT id, 'manual-payment', 'Contanti', 'PAID', 100, now(), true, '{}'::jsonb
         FROM orders WHERE external_order_id = $1`,
        [fixture[0].externalOrderId],
      );
      await orders.importOrders([fixture[0]], {
        id: 1,
        requestId: "test-manual-payment-preserved",
      });
      assert.equal(
        (
          await database.getPool().query(
            `SELECT count(*) FROM payments
             JOIN orders ON orders.id = payments.order_id
             WHERE orders.external_order_id = $1 AND payments.recorded_manually = true`,
            [fixture[0].externalOrderId],
          )
        ).rows[0].count,
        "1",
      );
      const snapshotOrder = (
        await database
          .getPool()
          .query("SELECT id, billing_case_id FROM orders WHERE external_order_id = $1", [
            fixture[0].externalOrderId,
          ])
      ).rows[0];
      let orderDetailPromise: ReturnType<typeof orders.getOrder> | undefined;
      await withClient(clean.connectionString, async (orderBlocker) => {
        await orderBlocker.query("BEGIN");
        await orderBlocker.query("LOCK TABLE order_lines IN ACCESS EXCLUSIVE MODE");
        orderDetailPromise = orders.getOrder(String(snapshotOrder.id));
        await waitForBlockedQuery(orderBlocker);
        await orderBlocker.query("UPDATE orders SET gross_amount = 12345 WHERE id = $1", [
          snapshotOrder.id,
        ]);
        await orderBlocker.query(
          "UPDATE order_lines SET gross_amount = 12345 WHERE order_id = $1",
          [snapshotOrder.id],
        );
        await orderBlocker.query("COMMIT");
      });
      const snapshotOrderDetail = await orderDetailPromise;
      assert.equal(
        snapshotOrderDetail!.gross_amount,
        snapshotOrderDetail!.lines.reduce(
          (total: number, line: { gross_amount: number }) => total + line.gross_amount,
          0,
        ),
      );
      await database
        .getPool()
        .query("UPDATE orders SET gross_amount = 12200 WHERE id = $1", [snapshotOrder.id]);
      await database
        .getPool()
        .query("UPDATE order_lines SET gross_amount = 12200 WHERE order_id = $1", [
          snapshotOrder.id,
        ]);

      let caseDetailPromise: ReturnType<typeof orders.getBillingCase> | undefined;
      await withClient(clean.connectionString, async (auditBlocker) => {
        await auditBlocker.query("BEGIN");
        await auditBlocker.query("LOCK TABLE audit_events IN ACCESS EXCLUSIVE MODE");
        caseDetailPromise = orders.getBillingCase(String(snapshotOrder.billing_case_id));
        await waitForBlockedQuery(auditBlocker);
        await auditBlocker.query("UPDATE billing_cases SET status = 'NEEDS_REVIEW' WHERE id = $1", [
          snapshotOrder.billing_case_id,
        ]);
        await auditBlocker.query(
          `INSERT INTO audit_events
            (actor_type, action, event_class, entity_type, entity_id, request_id)
           VALUES ('SYSTEM', 'BILLING_CASE_REACTIVATED', 'CRITICAL',
                   'BILLING_CASE', $1, 'test-snapshot-marker')`,
          [snapshotOrder.billing_case_id],
        );
        await auditBlocker.query("COMMIT");
      });
      const snapshotCaseDetail = await caseDetailPromise;
      assert.equal(snapshotCaseDetail!.status, "NEEDS_REVIEW");
      assert.ok(
        snapshotCaseDetail!.audit.some(
          (event: { request_id: string }) => event.request_id === "test-snapshot-marker",
        ),
      );
      await database
        .getPool()
        .query("UPDATE billing_cases SET status = 'READY' WHERE id = $1", [
          snapshotOrder.billing_case_id,
        ]);
      await database
        .getPool()
        .query("DELETE FROM audit_events WHERE request_id = 'test-snapshot-marker'");

      await withClient(clean.connectionString, async (client) => {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock(hashtext('setting:draft_trigger'))");
        let completed = false;
        const blockedImport = orders
          .importOrders([fixture[0]], { id: 1, requestId: "test-trigger-lock" })
          .finally(() => {
            completed = true;
          });
        await new Promise((resolve) => setTimeout(resolve, 75));
        assert.equal(completed, false);
        await client.query("COMMIT");
        assert.deepEqual(await blockedImport, { imported: 0, updated: 1, ignored: 0 });
      });
      assert.equal(await orders.getOrder("non-numerico"), null);
      assert.equal(await orders.getBillingCase("0"), null);
      assert.deepEqual(await orders.listOrders({ query: "test\0non valido" }), []);
      assert.deepEqual(await orders.listOrders({ localDate: "0000-01-01" }), []);
      const outOfRangeId = "9223372036854775808";
      assert.deepEqual(
        await Promise.all([
          orders.getOrder(outOfRangeId),
          orders.getBillingCase(outOfRangeId),
          orders.forcePrepareOrder(outOfRangeId, { id: 1, requestId: "test-invalid-order-id" }),
          orders.updateBillingCaseTransmission(outOfRangeId, null, {
            id: 1,
            requestId: "test-invalid-case-id",
          }),
        ]),
        [null, null, null, null],
      );
      assert.equal(typeof (await orders.getOrder("1"))?.local_order_date, "string");
      assert.equal(
        (await database.getPool().query("SELECT count(*) FROM orders")).rows[0].count,
        "3",
      );
      assert.equal(
        (await database.getPool().query("SELECT count(*) FROM billing_cases")).rows[0].count,
        "1",
      );
      assert.equal(
        (
          await database
            .getPool()
            .query(
              "SELECT count(DISTINCT billing_case_id) FROM orders WHERE external_order_id IN ('shop-order-1001', 'ebay-order-2001')",
            )
        ).rows[0].count,
        "1",
      );
      assert.equal((await orders.listOrders({ paymentStatus: "PENDING" })).length, 1);
      assert.equal((await orders.listOrders({ query: "shop-order-1001" })).length, 1);
      const waitingOrderId = (
        await database
          .getPool()
          .query("SELECT id FROM orders WHERE external_order_id = 'shop-order-1002'")
      ).rows[0].id;
      const forcedCaseId = await orders.forcePrepareOrder(waitingOrderId, {
        id: 1,
        requestId: "test-force-prepare",
      });
      assert.equal(
        await orders.forcePrepareOrder(waitingOrderId, {
          id: 1,
          requestId: "test-force-prepare-idempotent",
        }),
        forcedCaseId,
      );
      assert.deepEqual(
        await orders.setDraftTrigger("FULFILLED", 1, {
          id: 1,
          requestId: "test-trigger-change",
        }),
        { value: "FULFILLED", version: 2 },
      );
      assert.equal(
        (await database.getPool().query("SELECT count(*) FROM billing_cases")).rows[0].count,
        "2",
      );
      assert.equal(
        (
          await database
            .getPool()
            .query("SELECT bool_and(public_number ~ '^[0-9]{6}$') AS valid FROM billing_cases")
        ).rows[0].valid,
        true,
      );
      assert.equal(
        (
          await database
            .getPool()
            .query("SELECT count(*) FROM billing_cases WHERE status = 'NEEDS_REVIEW'")
        ).rows[0].count,
        "1",
      );
      await assert.rejects(
        orders.setDraftTrigger("PAID", 1, { id: 1, requestId: "test-stale-trigger" }),
        /I dati sono cambiati/,
      );
      const unsupported = structuredClone(fixture);
      unsupported[0].externalOrderId = "shop-order-usd";
      unsupported[0].currency = "USD";
      const validBeforeInvalid = structuredClone(fixture[0]);
      validBeforeInvalid.externalOrderId = "shop-order-rolled-back";
      await assert.rejects(
        orders.importOrders([validBeforeInvalid, unsupported[0]], {
          id: 1,
          requestId: "test-usd",
        }),
        /soltanto ordini in euro/,
      );
      assert.equal(
        (await database.getPool().query("SELECT count(*) FROM orders")).rows[0].count,
        "3",
      );
      assert.equal(
        (
          await database
            .getPool()
            .query("SELECT count(*) FROM orders WHERE external_order_id = 'shop-order-rolled-back'")
        ).rows[0].count,
        "0",
      );
      assert.equal(
        (
          await database
            .getPool()
            .query(
              "SELECT count(*) FROM audit_events WHERE action IN ('ORDER_IMPORTED', 'ORDER_GROUPED', 'DRAFT_TRIGGER_CHANGED')",
            )
        ).rows[0].count,
        "6",
      );
      assert.equal(
        (
          await database
            .getPool()
            .query("SELECT count(*) FROM audit_events WHERE action = 'ORDER_GROUPING_FORCED'")
        ).rows[0].count,
        "1",
      );
      const approvedGroup = [structuredClone(fixture[0]), structuredClone(fixture[1])];
      approvedGroup[0].externalOrderId = "shop-order-approved-1";
      approvedGroup[1].externalOrderId = "ebay-order-approved-2";
      for (const approvedOrder of approvedGroup) {
        approvedOrder.createdAt = "2026-08-12T08:00:00Z";
        approvedOrder.updatedAt = "2026-08-12T09:00:00Z";
      }
      approvedGroup[1].paymentStatus = "PENDING";
      approvedGroup[1].payments[0].status = "PENDING";
      await orders.importOrders(approvedGroup, { id: 1, requestId: "test-approved-group" });
      const approvedCaseId = (
        await database
          .getPool()
          .query("SELECT billing_case_id FROM orders WHERE external_order_id = $1", [
            approvedGroup[0].externalOrderId,
          ])
      ).rows[0].billing_case_id;
      await database
        .getPool()
        .query("UPDATE billing_cases SET status = 'APPROVED' WHERE id = $1", [approvedCaseId]);
      approvedGroup[1].lines[0].description = "Descrizione aggiornata dopo l’emissione";
      approvedGroup[1].paymentStatus = "PAID";
      approvedGroup[1].payments[0].status = "PAID";
      approvedGroup[1].total = "130.00";
      approvedGroup[1].lines[0].grossAmount = "130.00";
      approvedGroup[1].payments[0].amount = "130.00";
      approvedGroup[1].customer.displayName = "Cliente modificato dopo l’emissione";
      approvedGroup[1].updatedAt = "2026-08-12T09:30:00Z";
      await orders.importOrders([approvedGroup[1]], {
        id: 1,
        requestId: "test-approved-non-refund-conflict",
      });
      assert.equal(
        (
          await database
            .getPool()
            .query("SELECT trigger_status FROM orders WHERE external_order_id = $1", [
              approvedGroup[1].externalOrderId,
            ])
        ).rows[0].trigger_status,
        "INVOICED",
      );
      assert.deepEqual(
        (
          await database.getPool().query(
            `SELECT orders.gross_amount, orders.payment_status,
                    (SELECT gross_amount FROM order_lines WHERE order_id = orders.id) AS line_amount,
                    (SELECT amount FROM payments WHERE order_id = orders.id) AS payment_amount,
                    (SELECT status FROM payments WHERE order_id = orders.id) AS payment_row_status,
                    customers.display_name
             FROM orders JOIN customers ON customers.id = orders.customer_id
             WHERE orders.external_order_id = $1`,
            [approvedGroup[1].externalOrderId],
          )
        ).rows[0],
        {
          gross_amount: 7500,
          payment_status: "PAID",
          line_amount: 7500,
          payment_amount: 13000,
          payment_row_status: "PAID",
          display_name: "Mario Rossi",
        },
      );
      approvedGroup[1].updatedAt = "2026-08-12T09:45:00Z";
      await orders.importOrders([approvedGroup[1]], {
        id: 1,
        requestId: "test-approved-identical-reimport",
      });
      assert.equal(
        (
          await database.getPool().query(
            `SELECT count(*) FROM order_source_revisions
             JOIN orders ON orders.id = order_source_revisions.order_id
             WHERE orders.external_order_id = $1`,
            [approvedGroup[1].externalOrderId],
          )
        ).rows[0].count,
        "1",
      );
      approvedGroup[1].payments = [
        {
          ...approvedGroup[1].payments[0],
          externalPaymentId: "replacement-payment",
          method: "BANK_TRANSFER",
        },
      ];
      approvedGroup[1].updatedAt = "2026-08-12T09:50:00Z";
      await orders.importOrders([approvedGroup[1]], {
        id: 1,
        requestId: "test-approved-replaced-payment",
      });
      assert.deepEqual(
        (
          await database.getPool().query(
            `SELECT payments.external_payment_id, payments.method, payments.amount
               FROM payments JOIN orders ON orders.id = payments.order_id
               WHERE orders.external_order_id = $1`,
            [approvedGroup[1].externalOrderId],
          )
        ).rows,
        [{ external_payment_id: "replacement-payment", method: "BANK_TRANSFER", amount: 13000 }],
      );
      approvedGroup[0].paymentStatus = "REFUNDED";
      approvedGroup[0].payments[0].status = "REFUNDED";
      approvedGroup[0].updatedAt = "2026-08-12T10:00:00Z";
      await orders.importOrders([approvedGroup[0]], {
        id: 1,
        requestId: "test-approved-source-conflict",
      });
      const preservedApprovedGroup = await database.getPool().query(
        `SELECT billing_cases.status, count(*)::int AS order_count
           FROM billing_cases JOIN orders ON orders.billing_case_id = billing_cases.id
           WHERE billing_cases.id = $1 GROUP BY billing_cases.status`,
        [approvedCaseId],
      );
      assert.equal(preservedApprovedGroup.rows[0].status, "APPROVED");
      assert.equal(preservedApprovedGroup.rows[0].order_count, 2);
      assert.equal(
        (
          await database
            .getPool()
            .query("SELECT trigger_status FROM orders WHERE external_order_id = $1", [
              approvedGroup[0].externalOrderId,
            ])
        ).rows[0].trigger_status,
        "INVOICED",
      );
      assert.equal(
        (
          await database
            .getPool()
            .query(
              "SELECT count(*) FROM audit_events WHERE action = 'BILLING_CASE_DO_NOT_TRANSMIT'",
            )
        ).rows[0].count,
        "0",
      );
      const sourceChanged = structuredClone(fixture[0]);
      sourceChanged.paymentStatus = "REFUNDED";
      sourceChanged.payments[0].status = "REFUNDED";
      sourceChanged.updatedAt = "2026-08-08T10:00:00Z";
      await orders.importOrders([sourceChanged], {
        id: 1,
        requestId: "test-source-conflict",
      });
      const conflictedCase = (
        await database.getPool().query(
          `SELECT billing_cases.id, orders.id AS order_id, billing_cases.status, customers.review_required
             FROM billing_cases
             JOIN customers ON customers.id = billing_cases.customer_id
             JOIN orders ON orders.billing_case_id = billing_cases.id
             WHERE orders.external_order_id = 'shop-order-1001'`,
        )
      ).rows[0];
      assert.equal(conflictedCase.status, "DO_NOT_TRANSMIT");
      assert.equal(conflictedCase.review_required, false);
      assert.equal((await orders.getBillingCase(conflictedCase.id))?.status, "DO_NOT_TRANSMIT");
      assert.equal(
        (await orders.listOrders({ status: "ACTIVE" })).some(
          (order) => order.id === conflictedCase.order_id,
        ),
        false,
      );
      assert.equal(
        (await orders.listOrders({ status: "NO_DOCUMENT" })).some(
          (order) => order.id === conflictedCase.order_id,
        ),
        true,
      );
      const regroupedOrder = (
        await database.getPool().query(
          `SELECT orders.billing_case_id, orders.trigger_status, billing_cases.status
             FROM orders JOIN billing_cases ON billing_cases.id = orders.billing_case_id
             WHERE orders.external_order_id = 'ebay-order-2001'`,
        )
      ).rows[0];
      assert.notEqual(regroupedOrder.billing_case_id, conflictedCase.id);
      assert.equal(regroupedOrder.trigger_status, "GROUPED");
      assert.equal(regroupedOrder.status, "READY");
      assert.equal(
        (
          await database
            .getPool()
            .query("SELECT count(*) FROM audit_events WHERE action = 'ORDER_SOURCE_CONFLICT'")
        ).rows[0].count,
        "4",
      );
      assert.equal(
        (
          await database.getPool().query(
            `SELECT count(*) FROM order_source_revisions
             WHERE billing_case_id = $1
               AND previous_normalized_snapshot_json ->> 'paymentStatus' = 'PAID'
               AND current_normalized_snapshot_json ->> 'paymentStatus' = 'REFUNDED'`,
            [conflictedCase.id],
          )
        ).rows[0].count,
        "1",
      );
      assert.equal(
        (
          await database
            .getPool()
            .query(`SELECT do_not_transmit_reason FROM billing_cases WHERE id = $1`, [
              conflictedCase.id,
            ])
        ).rows[0].do_not_transmit_reason,
        "Ordine rimborsato prima dell’emissione",
      );
      assert.deepEqual(
        await orders.importOrders([fixture[0]], {
          id: 1,
          requestId: "test-stale-source-update",
        }),
        { imported: 0, updated: 0, ignored: 1 },
      );
      const preservedSource = (
        await database.getPool().query(
          `SELECT updated_at_source::text, payment_status, trigger_status
             FROM orders WHERE external_order_id = 'shop-order-1001'`,
        )
      ).rows[0];
      assert.equal(preservedSource.payment_status, "REFUNDED");
      assert.equal(preservedSource.trigger_status, "REFUNDED_BEFORE_ISSUE");
      assert.match(preservedSource.updated_at_source, /^2026-08-08 10:00:00/);
      await database.getPool().query(
        `UPDATE orders SET updated_at_source = '2026-08-08T10:00:00.123457Z'
         WHERE external_order_id = 'shop-order-1001'`,
      );
      const staleMicrosecond = structuredClone(sourceChanged);
      staleMicrosecond.paymentStatus = "PAID";
      staleMicrosecond.payments[0].status = "PAID";
      staleMicrosecond.updatedAt = "2026-08-08T10:00:00.123456Z";
      assert.deepEqual(
        await orders.importOrders([staleMicrosecond], {
          id: 1,
          requestId: "test-stale-source-microsecond",
        }),
        { imported: 0, updated: 0, ignored: 1 },
      );
      assert.deepEqual(
        (
          await database.getPool().query(
            `SELECT updated_at_source::text, payment_status
             FROM orders WHERE external_order_id = 'shop-order-1001'`,
          )
        ).rows[0],
        { updated_at_source: "2026-08-08 10:00:00.123457+00", payment_status: "REFUNDED" },
      );
      const reactivatedPending = structuredClone(sourceChanged);
      reactivatedPending.paymentStatus = "PENDING";
      reactivatedPending.fulfillmentStatus = "UNFULFILLED";
      reactivatedPending.payments[0].status = "PENDING";
      reactivatedPending.payments[0].paidAt = null;
      reactivatedPending.updatedAt = "2026-08-08T11:00:00Z";
      await orders.importOrders([reactivatedPending], {
        id: 1,
        requestId: "test-reactivated-pending",
      });
      assert.deepEqual(
        (
          await database.getPool().query(
            `SELECT billing_case_id, trigger_status,
                    normalized_snapshot_json ->> 'deferredReviewRequired' AS deferred_review
               FROM orders WHERE external_order_id = $1`,
            [reactivatedPending.externalOrderId],
          )
        ).rows[0],
        { billing_case_id: null, trigger_status: "WAITING_FOR_TRIGGER", deferred_review: "true" },
      );
      reactivatedPending.paymentStatus = "PAID";
      reactivatedPending.fulfillmentStatus = "FULFILLED";
      reactivatedPending.payments[0].status = "PAID";
      reactivatedPending.payments[0].paidAt = "2026-08-08T12:00:00Z";
      reactivatedPending.updatedAt = "2026-08-08T12:00:00Z";
      await orders.importOrders([reactivatedPending], {
        id: 1,
        requestId: "test-reactivated-paid",
      });
      assert.equal(
        (
          await database.getPool().query(
            `SELECT billing_cases.status
               FROM orders JOIN billing_cases ON billing_cases.id = orders.billing_case_id
               WHERE orders.external_order_id = $1`,
            [reactivatedPending.externalOrderId],
          )
        ).rows[0].status,
        "NEEDS_REVIEW",
      );
      const invalidAmount = structuredClone(fixture[1]);
      invalidAmount.externalOrderId = "ebay-invalid-amount";
      invalidAmount.lines[0].grossAmount = "12.345";
      await assert.rejects(
        orders.importOrders([invalidAmount], { id: 1, requestId: "test-invalid-amount" }),
        (error: unknown) => error instanceof AppError && error.code === "ORDER_INVALID_INPUT",
      );
      const excessiveDiscount = structuredClone(fixture[1]);
      excessiveDiscount.externalOrderId = "ebay-invalid-discount";
      excessiveDiscount.lines[0].discountAmount = "75.01";
      await assert.rejects(
        orders.importOrders([excessiveDiscount], {
          id: 1,
          requestId: "test-invalid-discount",
        }),
        (error: unknown) => error instanceof AppError && error.code === "ORDER_INVALID_INPUT",
      );
      const excessiveQuantity = structuredClone(fixture[1]);
      excessiveQuantity.externalOrderId = "ebay-invalid-quantity";
      excessiveQuantity.lines[0].quantity = 2_147_483_648;
      await assert.rejects(
        orders.importOrders([excessiveQuantity], {
          id: 1,
          requestId: "test-invalid-quantity",
        }),
        (error: unknown) => error instanceof AppError && error.code === "ORDER_INVALID_INPUT",
      );
      const nullByteText = structuredClone(fixture[1]);
      nullByteText.externalOrderId = "ebay-invalid-null-byte";
      nullByteText.lines[0].description = "Test\0non persistibile";
      await assert.rejects(
        orders.importOrders([nullByteText], { id: 1, requestId: "test-invalid-null-byte" }),
        (error: unknown) => error instanceof AppError && error.code === "ORDER_INVALID_INPUT",
      );
      const invalidTimestamp = structuredClone(fixture[1]);
      invalidTimestamp.externalOrderId = "ebay-invalid-timestamp";
      invalidTimestamp.createdAt = "0000-01-01T00:00:00Z";
      await assert.rejects(
        orders.importOrders([invalidTimestamp], { id: 1, requestId: "test-invalid-timestamp" }),
        (error: unknown) => error instanceof AppError && error.code === "ORDER_INVALID_INPUT",
      );
      await assert.rejects(
        orders.updateBillingCaseTransmission("1", "Test\0non persistibile", {
          id: 1,
          requestId: "test-invalid-reason-null-byte",
        }),
        (error: unknown) => error instanceof AppError && error.code === "ORDER_INVALID_INPUT",
      );
      const cancelled = structuredClone(fixture[2]);
      cancelled.externalOrderId = "shop-order-cancelled";
      cancelled.cancelledAt = "2026-08-08T11:00:00Z";
      const pendingBeforeCancelled = (await orders.dashboardSummary()).pending_payments;
      await orders.importOrders([cancelled], { id: 1, requestId: "test-cancelled" });
      assert.equal((await orders.dashboardSummary()).pending_payments, pendingBeforeCancelled);
      const cancelledId = (
        await database
          .getPool()
          .query("SELECT id FROM orders WHERE external_order_id = 'shop-order-cancelled'")
      ).rows[0].id;
      await assert.rejects(
        orders.forcePrepareOrder(cancelledId, { id: 1, requestId: "test-force-cancelled" }),
        (error: unknown) => error instanceof AppError && error.code === "ORDER_NOT_PREPARABLE",
      );
      const refunded = structuredClone(fixture[2]);
      refunded.externalOrderId = "shop-order-refunded";
      refunded.paymentStatus = "REFUNDED";
      refunded.payments = [];
      await orders.importOrders([refunded], { id: 1, requestId: "test-refunded" });
      const refundedId = (
        await database
          .getPool()
          .query("SELECT id FROM orders WHERE external_order_id = 'shop-order-refunded'")
      ).rows[0].id;
      await assert.rejects(
        orders.forcePrepareOrder(refundedId, { id: 1, requestId: "test-force-refunded" }),
        (error: unknown) => error instanceof AppError && error.code === "ORDER_NOT_PREPARABLE",
      );
      refunded.createdAt = "2026-08-09T08:00:00Z";
      refunded.updatedAt = "2026-08-09T09:00:00Z";
      await orders.importOrders([refunded], { id: 1, requestId: "test-corrected-created-at" });
      assert.deepEqual(
        (
          await database.getPool().query(
            `SELECT created_at_source = $2::timestamptz AS created_at_matches,
                    local_order_date::text
               FROM orders WHERE external_order_id = $1`,
            [refunded.externalOrderId, refunded.createdAt],
          )
        ).rows[0],
        { created_at_matches: true, local_order_date: "2026-08-09" },
      );
      const pendingPaymentsBefore = Number((await orders.dashboardSummary()).pending_payments);
      const pendingPayment = structuredClone(fixture[0]);
      pendingPayment.externalOrderId = "shop-order-pending-payment";
      pendingPayment.externalCustomerId = "shop-customer-pending-payment";
      pendingPayment.customer.taxIdentifiers[0].value = "RSSMRA80A01H501W";
      pendingPayment.paymentStatus = "PAID";
      pendingPayment.payments[0].status = "PENDING";
      pendingPayment.payments[0].paidAt = null;
      pendingPayment.createdAt = "2026-08-11T08:15:00Z";
      pendingPayment.updatedAt = "2026-08-11T09:00:00Z";
      await orders.importOrders([pendingPayment], {
        id: 1,
        requestId: "test-pending-payment",
      });
      assert.equal(
        (
          await database.getPool().query(
            `SELECT billing_cases.status
               FROM billing_cases JOIN orders ON orders.billing_case_id = billing_cases.id
               WHERE orders.external_order_id = 'shop-order-pending-payment'`,
          )
        ).rows[0].status,
        "NEEDS_REVIEW",
      );
      assert.equal(
        Number((await orders.dashboardSummary()).pending_payments),
        pendingPaymentsBefore + 1,
      );
      const incompleteCustomer = structuredClone(fixture[0]);
      incompleteCustomer.externalOrderId = "shop-order-incomplete-customer";
      incompleteCustomer.externalCustomerId = "shop-customer-incomplete";
      incompleteCustomer.customer.taxIdentifiers[0].value = "RSSMRA80A01H501V";
      incompleteCustomer.customer.billingAddress = {};
      incompleteCustomer.updatedAt = "2026-08-08T12:00:00Z";
      assert.deepEqual(
        await orders.importOrders([incompleteCustomer], {
          id: 1,
          requestId: "test-incomplete-customer",
        }),
        { imported: 1, updated: 0, ignored: 0 },
      );
      assert.equal(
        (
          await database.getPool().query(
            `SELECT billing_cases.status
               FROM billing_cases JOIN orders ON orders.billing_case_id = billing_cases.id
               WHERE orders.external_order_id = 'shop-order-incomplete-customer'`,
          )
        ).rows[0].status,
        "NEEDS_REVIEW",
      );
      const completedCustomer = structuredClone(incompleteCustomer);
      completedCustomer.externalOrderId = "shop-order-completed-customer";
      completedCustomer.createdAt = "2026-08-09T08:15:00Z";
      completedCustomer.updatedAt = "2026-08-09T09:00:00Z";
      completedCustomer.customer.billingAddress = fixture[0].customer.billingAddress;
      await orders.importOrders([completedCustomer], {
        id: 1,
        requestId: "test-completed-customer",
      });
      const completedCase = (
        await database.getPool().query(
          `SELECT billing_cases.status, customers.review_required,
                  customers.billing_address_json ->> 'city' AS city
             FROM billing_cases
             JOIN customers ON customers.id = billing_cases.customer_id
             JOIN orders ON orders.billing_case_id = billing_cases.id
             WHERE orders.external_order_id = 'shop-order-completed-customer'`,
        )
      ).rows[0];
      assert.deepEqual(completedCase, {
        status: "READY",
        review_required: false,
        city: "Milano",
      });
      const laterIncompleteCustomer = structuredClone(incompleteCustomer);
      laterIncompleteCustomer.externalOrderId = "shop-order-later-incomplete-customer";
      laterIncompleteCustomer.createdAt = "2026-08-10T08:15:00Z";
      laterIncompleteCustomer.updatedAt = "2026-08-10T09:00:00Z";
      await orders.importOrders([laterIncompleteCustomer], {
        id: 1,
        requestId: "test-later-incomplete-customer",
      });
      const preservedCase = (
        await database.getPool().query(
          `SELECT billing_cases.status,
                  billing_cases.customer_snapshot_json ->> 'reviewRequired' AS review_required,
                  billing_cases.customer_snapshot_json #>> '{billingAddress,city}' AS city
             FROM billing_cases
             JOIN orders ON orders.billing_case_id = billing_cases.id
             WHERE orders.external_order_id = 'shop-order-completed-customer'`,
        )
      ).rows[0];
      assert.deepEqual(preservedCase, {
        status: "READY",
        review_required: "false",
        city: "Milano",
      });

      const { externalCustomerId: _, ...noExternalCustomer } = structuredClone(fixture[0]);
      noExternalCustomer.externalOrderId = "shop-order-without-external-customer";
      noExternalCustomer.createdAt = "2026-08-13T08:00:00Z";
      noExternalCustomer.updatedAt = "2026-08-13T09:00:00Z";
      noExternalCustomer.customer = {
        kind: "UNKNOWN",
        billingAddress: {},
        taxIdentifiers: [],
      };
      await orders.importOrders([noExternalCustomer], {
        id: 1,
        requestId: "test-without-external-customer",
      });
      assert.equal(
        (
          await database.getPool().query(
            `SELECT billing_cases.status
               FROM billing_cases JOIN orders ON orders.billing_case_id = billing_cases.id
               WHERE orders.external_order_id = $1`,
            [noExternalCustomer.externalOrderId],
          )
        ).rows[0].status,
        "NEEDS_REVIEW",
      );

      const unreconciled = structuredClone(fixture[0]);
      unreconciled.externalOrderId = "shop-order-unreconciled";
      unreconciled.externalCustomerId = "shop-customer-unreconciled";
      unreconciled.customer.taxIdentifiers[0].value = "RSSMRA80A01H501X";
      unreconciled.createdAt = "2026-08-14T08:00:00Z";
      unreconciled.updatedAt = "2026-08-14T09:00:00Z";
      unreconciled.total = "123.00";
      await orders.importOrders([unreconciled], { id: 1, requestId: "test-unreconciled" });
      const unreconciledCase = (
        await database.getPool().query(
          `SELECT billing_cases.status,
                  orders.normalized_snapshot_json ->> 'totalsReconciled' AS totals_reconciled
             FROM billing_cases JOIN orders ON orders.billing_case_id = billing_cases.id
             WHERE orders.external_order_id = $1`,
          [unreconciled.externalOrderId],
        )
      ).rows[0];
      assert.deepEqual(unreconciledCase, {
        status: "NEEDS_REVIEW",
        totals_reconciled: "false",
      });

      const lowerCountry = {
        ...structuredClone(fixture[0]),
        externalOrderId: "shop-order-country-lower",
        externalCustomerId: "shop-customer-country-lower",
        createdAt: "2026-08-15T08:00:00Z",
        updatedAt: "2026-08-15T09:00:00Z",
        customer: {
          ...structuredClone(fixture[0].customer),
          kind: "EU" as const,
          billingAddress: {
            ...structuredClone(fixture[0].customer.billingAddress),
            countryCode: "DE",
          },
          taxIdentifiers: [
            {
              ...structuredClone(fixture[0].customer.taxIdentifiers[0]),
              type: "ALTRO" as const,
              value: "DE123456789",
              countryCode: "de",
            },
          ],
        },
      };
      const upperCountry = structuredClone(lowerCountry);
      upperCountry.externalOrderId = "shop-order-country-upper";
      upperCountry.externalCustomerId = "shop-customer-country-upper";
      upperCountry.customer.taxIdentifiers[0].countryCode = "DE";
      await orders.importOrders([lowerCountry, upperCountry], {
        id: 1,
        requestId: "test-country-grouping",
      });
      assert.equal(
        (
          await database.getPool().query(
            `SELECT count(DISTINCT billing_case_id) FROM orders
             WHERE external_order_id IN ($1, $2)`,
            [lowerCountry.externalOrderId, upperCountry.externalOrderId],
          )
        ).rows[0].count,
        "1",
      );
      lowerCountry.customer.taxIdentifiers[0].countryCode = "DE";
      lowerCountry.updatedAt = "2026-08-15T10:00:00Z";
      await orders.importOrders([lowerCountry], { id: 1, requestId: "test-country-reimport" });
      assert.equal(
        (
          await database.getPool().query(
            `SELECT count(*) FROM order_source_revisions
             JOIN orders ON orders.id = order_source_revisions.order_id
             WHERE orders.external_order_id = $1`,
            [lowerCountry.externalOrderId],
          )
        ).rows[0].count,
        "0",
      );

      const shipped = structuredClone(fixture[0]);
      shipped.externalOrderId = "shop-order-with-shipping";
      shipped.externalCustomerId = "shop-customer-with-shipping";
      shipped.customer.taxIdentifiers[0].value = "RSSMRA80A01H501Y";
      shipped.createdAt = "2026-08-16T08:00:00Z";
      shipped.updatedAt = "2026-08-16T09:00:00Z";
      shipped.total = "127.00";
      shipped.shippingAmount = "5.00";
      shipped.payments[0].amount = "127.00";
      await orders.importOrders([shipped], { id: 1, requestId: "test-shipping" });
      assert.deepEqual(
        (
          await database.getPool().query(
            `SELECT billing_cases.status,
                    orders.normalized_snapshot_json ->> 'shippingAmount' AS shipping_amount,
                    orders.normalized_snapshot_json ->> 'totalsReconciled' AS totals_reconciled
               FROM billing_cases JOIN orders ON orders.billing_case_id = billing_cases.id
               WHERE orders.external_order_id = $1`,
            [shipped.externalOrderId],
          )
        ).rows[0],
        { status: "READY", shipping_amount: "500", totals_reconciled: "true" },
      );
      const manuallyClosedCaseId = (
        await database
          .getPool()
          .query("SELECT billing_case_id FROM orders WHERE external_order_id = $1", [
            shipped.externalOrderId,
          ])
      ).rows[0].billing_case_id;
      assert.equal(
        await orders.updateBillingCaseTransmission(manuallyClosedCaseId, "Già fatturato altrove", {
          id: 1,
          requestId: "test-manual-do-not-transmit",
        }),
        "DO_NOT_TRANSMIT",
      );
      assert.deepEqual(
        (
          await database.getPool().query(
            `SELECT status, do_not_transmit_reason
             FROM billing_cases WHERE id = $1`,
            [manuallyClosedCaseId],
          )
        ).rows[0],
        { status: "DO_NOT_TRANSMIT", do_not_transmit_reason: "Già fatturato altrove" },
      );
      shipped.lines[0].description = "Descrizione aggiornata mentre la preparazione è chiusa";
      shipped.updatedAt = "2026-08-16T10:00:00Z";
      await orders.importOrders([shipped], {
        id: 1,
        requestId: "test-manual-do-not-transmit-source-update",
      });
      assert.deepEqual(
        (
          await database.getPool().query(
            `SELECT billing_cases.id, billing_cases.status, billing_cases.do_not_transmit_reason
             FROM billing_cases JOIN orders ON orders.billing_case_id = billing_cases.id
             WHERE orders.external_order_id = $1`,
            [shipped.externalOrderId],
          )
        ).rows[0],
        {
          id: manuallyClosedCaseId,
          status: "DO_NOT_TRANSMIT",
          do_not_transmit_reason: "Già fatturato altrove",
        },
      );
      assert.equal(
        await orders.updateBillingCaseTransmission(manuallyClosedCaseId, null, {
          id: 1,
          requestId: "test-manual-reactivation",
        }),
        "NEEDS_REVIEW",
      );
      assert.deepEqual(
        (
          await database.getPool().query(
            `SELECT status, do_not_transmit_reason,
                    (SELECT count(*)::int FROM audit_events
                     WHERE entity_type = 'BILLING_CASE'
                       AND entity_id = billing_cases.id::text
                       AND action IN ('BILLING_CASE_DO_NOT_TRANSMIT', 'BILLING_CASE_REACTIVATED'))
                      AS audit_count
             FROM billing_cases WHERE id = $1`,
            [manuallyClosedCaseId],
          )
        ).rows[0],
        { status: "NEEDS_REVIEW", do_not_transmit_reason: null, audit_count: 2 },
      );

      const reorderedCollections = structuredClone(fixture[0]);
      reorderedCollections.externalOrderId = "shop-order-reordered-collections";
      reorderedCollections.externalCustomerId = "shop-customer-reordered-collections";
      reorderedCollections.customer.taxIdentifiers[0].value = "RSSMRA80A01H501W";
      reorderedCollections.customer.taxIdentifiers.push({
        ...reorderedCollections.customer.taxIdentifiers[0],
        sourceField: "duplicate-source-field",
      });
      reorderedCollections.customer.taxIdentifiers.push(
        { type: "ALTRO", value: "DUPLICATO42", countryCode: "DE", sourceField: "field-de" },
        { type: "ALTRO", value: "DUPLICATO42", countryCode: "FR", sourceField: "field-fr" },
      );
      reorderedCollections.createdAt = "2026-08-17T08:00:00Z";
      reorderedCollections.updatedAt = "2026-08-17T09:00:00Z";
      reorderedCollections.lines = [
        { ...reorderedCollections.lines[0], externalLineId: "line-a", grossAmount: "60.00" },
        { ...reorderedCollections.lines[0], externalLineId: "line-b", grossAmount: "62.00" },
      ];
      reorderedCollections.payments = [
        { ...reorderedCollections.payments[0], externalPaymentId: "payment-a", amount: "60.00" },
        { ...reorderedCollections.payments[0], externalPaymentId: "payment-b", amount: "62.00" },
      ];
      await orders.importOrders([reorderedCollections], {
        id: 1,
        requestId: "test-collection-order-import",
      });
      reorderedCollections.lines.reverse();
      reorderedCollections.payments.reverse();
      reorderedCollections.payments.forEach(
        (payment: { paidAt: string | null }) => (payment.paidAt = "2026-08-07T11:00:00+02:00"),
      );
      reorderedCollections.updatedAt = "2026-08-17T10:00:00Z";
      await orders.importOrders([reorderedCollections], {
        id: 1,
        requestId: "test-collection-order-reimport",
      });
      assert.equal(
        (
          await database.getPool().query(
            `SELECT count(*) FROM order_source_revisions
             JOIN orders ON orders.id = order_source_revisions.order_id
             WHERE orders.external_order_id = $1`,
            [reorderedCollections.externalOrderId],
          )
        ).rows[0].count,
        "0",
      );
      assert.equal(
        (
          await database.getPool().query(
            `SELECT count(*) FROM order_tax_identifiers
             JOIN orders ON orders.id = order_tax_identifiers.order_id
             WHERE orders.external_order_id = $1`,
            [reorderedCollections.externalOrderId],
          )
        ).rows[0].count,
        "3",
      );
      reorderedCollections.cancelledAt = "2026-08-17T12:00:00Z";
      reorderedCollections.updatedAt = "2026-08-17T11:00:00Z";
      await orders.importOrders([reorderedCollections], {
        id: 1,
        requestId: "test-canonical-cancelled-at",
      });
      reorderedCollections.cancelledAt = "2026-08-17T14:00:00+02:00";
      reorderedCollections.updatedAt = "2026-08-17T12:00:00Z";
      await orders.importOrders([reorderedCollections], {
        id: 1,
        requestId: "test-canonical-cancelled-at-reimport",
      });
      assert.equal(
        (
          await database.getPool().query(
            `SELECT count(*) FROM order_source_revisions
             JOIN orders ON orders.id = order_source_revisions.order_id
             WHERE orders.external_order_id = $1`,
            [reorderedCollections.externalOrderId],
          )
        ).rows[0].count,
        "1",
      );

      const canonicalA = structuredClone(fixture[0]);
      canonicalA.externalOrderId = "shop-order-tax-order-a";
      canonicalA.externalCustomerId = "shop-customer-tax-order-a";
      canonicalA.createdAt = "2026-08-18T08:00:00Z";
      canonicalA.updatedAt = "2026-08-18T09:00:00Z";
      canonicalA.customer.kind = "EU";
      canonicalA.customer.billingAddress.countryCode = "DE";
      canonicalA.customer.taxIdentifiers = [
        {
          type: "PARTITA_IVA",
          value: "DE123456789",
          countryCode: "DE",
          sourceField: "fixture-vat",
        },
        {
          type: "ALTRO",
          value: "DE-ALT-42",
          countryCode: "DE",
          sourceField: "fixture-other",
        },
      ];
      delete canonicalA.customer.billingAddress.province;
      const canonicalB = structuredClone(canonicalA);
      canonicalB.externalOrderId = "shop-order-tax-order-b";
      canonicalB.externalCustomerId = "shop-customer-tax-order-b";
      canonicalB.customer.taxIdentifiers.reverse();
      canonicalB.customer.taxIdentifiers.find(
        (identifier: { type: string }) => identifier.type === "PARTITA_IVA",
      )!.value = "123456789";
      canonicalB.customer.phone = "";
      canonicalB.customer.billingAddress.province = "";
      await orders.importOrders([canonicalA, canonicalB], {
        id: 1,
        requestId: "test-tax-order-grouping",
      });
      const canonicalAOrderId = (
        await database
          .getPool()
          .query("SELECT id FROM orders WHERE external_order_id = $1", [canonicalA.externalOrderId])
      ).rows[0].id;
      assert.ok(
        (await orders.listOrders({ query: "DE123456789" })).some(
          (order: { id: string }) => order.id === canonicalAOrderId,
        ),
      );
      assert.deepEqual(
        (
          await database.getPool().query(
            `SELECT count(DISTINCT billing_case_id)::int AS case_count,
                    min(billing_cases.status) AS status
               FROM orders JOIN billing_cases ON billing_cases.id = orders.billing_case_id
               WHERE external_order_id IN ($1, $2)`,
            [canonicalA.externalOrderId, canonicalB.externalOrderId],
          )
        ).rows[0],
        { case_count: 1, status: "READY" },
      );
      canonicalA.customer.taxIdentifiers.reverse();
      canonicalA.customer.phone = "";
      canonicalA.customer.billingAddress.province = "";
      canonicalA.updatedAt = "2026-08-18T10:00:00Z";
      await orders.importOrders([canonicalA], {
        id: 1,
        requestId: "test-tax-order-reimport",
      });
      assert.equal(
        (
          await database.getPool().query(
            `SELECT count(*) FROM order_source_revisions
             JOIN orders ON orders.id = order_source_revisions.order_id
             WHERE orders.external_order_id = $1`,
            [canonicalA.externalOrderId],
          )
        ).rows[0].count,
        "0",
      );
      canonicalA.displayNumber = "#1001-corretto";
      canonicalA.updatedAt = "2026-08-18T11:00:00Z";
      await orders.importOrders([canonicalA], {
        id: 1,
        requestId: "test-display-number-conflict",
      });
      assert.deepEqual(
        (
          await database.getPool().query(
            `SELECT count(order_source_revisions.*)::int AS revision_count,
                    billing_cases.status
               FROM orders
               JOIN billing_cases ON billing_cases.id = orders.billing_case_id
               LEFT JOIN order_source_revisions ON order_source_revisions.order_id = orders.id
               WHERE orders.external_order_id = $1
               GROUP BY billing_cases.status`,
            [canonicalA.externalOrderId],
          )
        ).rows[0],
        { revision_count: 1, status: "NEEDS_REVIEW" },
      );
      canonicalA.updatedAt = "2026-08-18T12:00:00Z";
      await orders.importOrders([canonicalA], {
        id: 1,
        requestId: "test-technical-update-after-conflict",
      });
      canonicalA.lines[0].description = "Descrizione dopo aggiornamento tecnico";
      canonicalA.updatedAt = "2026-08-18T13:00:00Z";
      await orders.importOrders([canonicalA], {
        id: 1,
        requestId: "test-second-conflict-after-technical-update",
      });
      assert.equal(
        (
          await database.getPool().query(
            `SELECT previous_normalized_snapshot_json ->> 'updatedAt' AS previous_updated_at
             FROM order_source_revisions
             JOIN orders ON orders.id = order_source_revisions.order_id
             WHERE orders.external_order_id = $1
             ORDER BY order_source_revisions.id DESC LIMIT 1`,
            [canonicalA.externalOrderId],
          )
        ).rows[0].previous_updated_at,
        "2026-08-18T12:00:00Z",
      );

      const profileA = structuredClone(fixture[0]);
      profileA.externalOrderId = "shop-order-profile-a";
      profileA.externalCustomerId = "shop-customer-profile-a";
      profileA.createdAt = "2026-08-21T08:00:00Z";
      profileA.updatedAt = "2026-08-21T09:00:00Z";
      profileA.customer.kind = "EU";
      profileA.customer.displayName = "Entreprise Exemple";
      profileA.customer.billingAddress.line1 = "Rue de Rome 1";
      profileA.customer.billingAddress.countryCode = "FR";
      profileA.customer.taxIdentifiers = [];
      const profileB = structuredClone(profileA);
      profileB.externalOrderId = "shop-order-profile-b";
      profileB.externalCustomerId = "shop-customer-profile-b";
      profileB.customer.displayName = "ENTREPRISE  EXEMPLE";
      profileB.customer.billingAddress.line1 = "RUE DE  ROME 1";
      await orders.importOrders([profileA, profileB], {
        id: 1,
        requestId: "test-profile-format-grouping",
      });
      assert.deepEqual(
        (
          await database.getPool().query(
            `SELECT count(DISTINCT billing_case_id)::int AS case_count,
                    min(billing_cases.status) AS status
               FROM orders JOIN billing_cases ON billing_cases.id = orders.billing_case_id
               WHERE external_order_id IN ($1, $2)`,
            [profileA.externalOrderId, profileB.externalOrderId],
          )
        ).rows[0],
        { case_count: 1, status: "READY" },
      );
      profileA.customer.displayName = "ENTREPRISE  EXEMPLE";
      profileA.customer.billingAddress.line1 = "RUE DE  ROME 1";
      profileA.updatedAt = "2026-08-21T10:00:00Z";
      await orders.importOrders([profileA], {
        id: 1,
        requestId: "test-profile-format-reimport",
      });
      assert.equal(
        (
          await database.getPool().query(
            `SELECT count(*) FROM order_source_revisions
             JOIN orders ON orders.id = order_source_revisions.order_id
             WHERE orders.external_order_id = $1`,
            [profileA.externalOrderId],
          )
        ).rows[0].count,
        "0",
      );

      const conflictingProfileA = structuredClone(fixture[0]);
      conflictingProfileA.externalOrderId = "shop-order-conflicting-profile-a";
      conflictingProfileA.externalCustomerId = "shop-customer-conflicting-profile-a";
      conflictingProfileA.customer.taxIdentifiers[0].value = "RSSMRA80A01H501L";
      conflictingProfileA.createdAt = "2026-08-22T08:00:00Z";
      conflictingProfileA.updatedAt = "2026-08-22T09:00:00Z";
      const conflictingProfileB = structuredClone(conflictingProfileA);
      conflictingProfileB.externalOrderId = "shop-order-conflicting-profile-b";
      conflictingProfileB.externalCustomerId = "shop-customer-conflicting-profile-b";
      conflictingProfileB.customer.billingAddress.line1 = "Via Milano 2";
      await orders.importOrders([conflictingProfileA, conflictingProfileB], {
        id: 1,
        requestId: "test-conflicting-profile-grouping",
      });
      const conflictingProfileCase = (
        await database.getPool().query(
          `SELECT billing_cases.id, billing_cases.status,
                  bool_and(orders.trigger_status = 'GROUPED') AS orders_grouped
             FROM orders JOIN billing_cases ON billing_cases.id = orders.billing_case_id
             WHERE orders.external_order_id IN ($1, $2)
             GROUP BY billing_cases.id, billing_cases.status`,
          [conflictingProfileA.externalOrderId, conflictingProfileB.externalOrderId],
        )
      ).rows[0];
      assert.deepEqual(conflictingProfileCase, {
        id: conflictingProfileCase.id,
        status: "NEEDS_REVIEW",
        orders_grouped: true,
      });
      await orders.updateBillingCaseTransmission(
        String(conflictingProfileCase.id),
        "Anagrafica da verificare",
        { id: 1, requestId: "test-archive-conflicting-profile" },
      );
      assert.equal(
        await orders.updateBillingCaseTransmission(String(conflictingProfileCase.id), null, {
          id: 1,
          requestId: "test-reactivate-conflicting-profile",
        }),
        "NEEDS_REVIEW",
      );

      const reviewedA = structuredClone(fixture[0]);
      reviewedA.externalOrderId = "shop-order-reviewed-a";
      reviewedA.externalCustomerId = "shop-customer-reviewed-a";
      reviewedA.createdAt = "2026-08-19T08:00:00Z";
      reviewedA.updatedAt = "2026-08-19T09:00:00Z";
      reviewedA.customer.taxIdentifiers[0].value = "RSSMRA80A01H501O";
      const reviewedB = structuredClone(reviewedA);
      reviewedB.externalOrderId = "shop-order-reviewed-b";
      reviewedB.externalCustomerId = "shop-customer-reviewed-b";
      await orders.importOrders([reviewedA, reviewedB], {
        id: 1,
        requestId: "test-reviewed-grouping",
      });
      reviewedA.lines[0].description = "Descrizione da verificare";
      reviewedA.updatedAt = "2026-08-19T10:00:00Z";
      await orders.importOrders([reviewedA], {
        id: 1,
        requestId: "test-reviewed-conflict",
      });
      reviewedB.lines[0].description = "Secondo ordine da verificare";
      reviewedB.updatedAt = "2026-08-19T10:15:00Z";
      await orders.importOrders([reviewedB], {
        id: 1,
        requestId: "test-reviewed-second-conflict",
      });
      reviewedB.cancelledAt = "2026-08-19T10:30:00Z";
      reviewedB.updatedAt = "2026-08-19T10:30:00Z";
      await orders.importOrders([reviewedB], {
        id: 1,
        requestId: "test-reviewed-cancellation",
      });
      const archivedCancelledCaseId = (
        await database.getPool().query(
          `SELECT entity_id FROM audit_events
           WHERE request_id = 'test-reviewed-cancellation'
             AND action = 'BILLING_CASE_DO_NOT_TRANSMIT'`,
        )
      ).rows[0].entity_id;
      assert.equal(
        (await orders.getBillingCase(String(archivedCancelledCaseId)))!.reactivation_blocker,
        "INCOMPATIBLE_ORDERS",
      );
      const recoveredReviewed = (
        await database.getPool().query(
          `SELECT orders.billing_case_id, billing_cases.status
             FROM orders JOIN billing_cases ON billing_cases.id = orders.billing_case_id
             WHERE orders.external_order_id = $1`,
          [reviewedA.externalOrderId],
        )
      ).rows[0];
      assert.equal(recoveredReviewed.status, "NEEDS_REVIEW");
      reviewedB.cancelledAt = null;
      reviewedB.customer.taxIdentifiers[0].value = "RSSMRA80A01H501N";
      reviewedB.updatedAt = "2026-08-19T11:00:00Z";
      await orders.importOrders([reviewedB], {
        id: 1,
        requestId: "test-cancellation-revoked",
      });
      const reidentifiedOrder = (
        await database.getPool().query(
          `SELECT orders.billing_case_id, orders.trigger_status, orders.customer_id,
                  billing_cases.customer_id AS case_customer_id, billing_cases.status
             FROM orders JOIN billing_cases ON billing_cases.id = orders.billing_case_id
             WHERE orders.external_order_id = $1`,
          [reviewedB.externalOrderId],
        )
      ).rows[0];
      assert.notEqual(reidentifiedOrder.billing_case_id, recoveredReviewed.billing_case_id);
      assert.equal(reidentifiedOrder.trigger_status, "GROUPED");
      assert.equal(reidentifiedOrder.customer_id, reidentifiedOrder.case_customer_id);
      assert.equal(reidentifiedOrder.status, "NEEDS_REVIEW");
      assert.ok(
        (await orders.getBillingCase(String(reidentifiedOrder.billing_case_id)))!.revisions.length >
          0,
      );
      await orders.updateBillingCaseTransmission(
        String(reidentifiedOrder.billing_case_id),
        "Preparazione sostitutiva archiviata per il test",
        { id: 1, requestId: "test-archive-replacement-case" },
      );
      await assert.rejects(
        orders.updateBillingCaseTransmission(String(archivedCancelledCaseId), null, {
          id: 1,
          requestId: "test-empty-case-reactivation",
        }),
        (error: unknown) => error instanceof AppError && error.code === "BILLING_CASE_EMPTY",
      );
      assert.equal(
        (await orders.getBillingCase(String(archivedCancelledCaseId)))!.reactivation_blocker,
        "EMPTY",
      );
      await orders.updateBillingCaseTransmission(String(reidentifiedOrder.billing_case_id), null, {
        id: 1,
        requestId: "test-reactivate-replacement-case",
      });

      const triggerConcurrentA = structuredClone(fixture[0]);
      triggerConcurrentA.externalOrderId = "shop-order-trigger-concurrent-a";
      triggerConcurrentA.externalCustomerId = "shop-customer-trigger-concurrent";
      triggerConcurrentA.customer.taxIdentifiers[0].value = "RSSMRA80A01H501M";
      triggerConcurrentA.createdAt = "2026-08-20T08:00:00Z";
      triggerConcurrentA.updatedAt = "2026-08-20T09:00:00Z";
      const triggerConcurrentB = structuredClone(triggerConcurrentA);
      triggerConcurrentB.externalOrderId = "shop-order-trigger-concurrent-b";
      await orders.importOrders([triggerConcurrentA, triggerConcurrentB], {
        id: 1,
        requestId: "test-trigger-concurrent-import",
      });
      const triggerConcurrentBId = (
        await database
          .getPool()
          .query("SELECT id FROM orders WHERE external_order_id = $1", [
            triggerConcurrentB.externalOrderId,
          ])
      ).rows[0].id;
      await Promise.all([
        orders.setDraftTrigger("PAID", 2, {
          id: 1,
          requestId: "test-trigger-concurrent-change",
        }),
        orders.forcePrepareOrder(triggerConcurrentBId, {
          id: 1,
          requestId: "test-trigger-concurrent-force",
        }),
      ]);
      assert.equal(
        (
          await database.getPool().query(
            `SELECT count(DISTINCT billing_case_id) FROM orders
             WHERE external_order_id IN ($1, $2)`,
            [triggerConcurrentA.externalOrderId, triggerConcurrentB.externalOrderId],
          )
        ).rows[0].count,
        "1",
      );

      const concurrentA = structuredClone(fixture[0]);
      concurrentA.externalOrderId = "shop-order-concurrent-a";
      concurrentA.externalCustomerId = "shop-customer-concurrent";
      concurrentA.customer.taxIdentifiers[0].value = "RSSMRA80A01H501Z";
      concurrentA.createdAt = "2026-08-17T08:00:00Z";
      concurrentA.updatedAt = "2026-08-17T09:00:00Z";
      const concurrentB = structuredClone(concurrentA);
      concurrentB.externalOrderId = "shop-order-concurrent-b";
      const concurrentImports = await Promise.all([
        orders.importOrders([concurrentA, concurrentB], {
          id: 1,
          requestId: "test-concurrent-forward",
        }),
        orders.importOrders([concurrentB, concurrentA], {
          id: 1,
          requestId: "test-concurrent-reverse",
        }),
      ]);
      assert.deepEqual(concurrentImports.map(({ imported }) => imported).sort(), [0, 2]);
      await database.closePool();
    } finally {
      await import("./client.server.ts").then(({ closePool }) => closePool());
      await clean.drop();
      await upgrade.drop();
    }
  },
);
