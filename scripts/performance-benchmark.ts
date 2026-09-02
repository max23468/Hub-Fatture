import { performance } from "node:perf_hooks";

import { temporaryDatabase } from "../src/db/database-fixture.ts";
import { runMigrations } from "../src/db/migrations.server.ts";

const CUSTOMER_COUNT = 1_000;
const ORDERS_PER_CUSTOMER = 3;
const PREPARATION_COUNT = 500;
const WARMUP_RUNS = 1;
const SAMPLE_RUNS = 5;

interface Measurement {
  minMs: number;
  medianMs: number;
  p95Ms: number;
  maxMs: number;
}

function percentile(values: number[], percentileValue: number) {
  const sorted = values.toSorted((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * percentileValue) - 1);
  return sorted[index]!;
}

async function measure(name: string, operation: () => Promise<unknown>): Promise<Measurement> {
  process.stderr.write(`Misuro ${name}...\n`);
  for (let index = 0; index < WARMUP_RUNS; index += 1) await operation();
  const samples: number[] = [];
  for (let index = 0; index < SAMPLE_RUNS; index += 1) {
    const startedAt = performance.now();
    await operation();
    samples.push(performance.now() - startedAt);
  }
  return {
    minMs: Math.min(...samples),
    medianMs: percentile(samples, 0.5),
    p95Ms: percentile(samples, 0.95),
    maxMs: Math.max(...samples),
  };
}

function rounded(measurement: Measurement) {
  return Object.fromEntries(
    Object.entries(measurement).map(([key, value]) => [key, Number(value.toFixed(1))]),
  );
}

const database = await temporaryDatabase("performance_benchmark");

try {
  await runMigrations({ connectionString: database.connectionString });
  process.env.APP_ENV = "test";
  process.env.APP_BASE_URL = "http://127.0.0.1:4197";
  process.env.ADMIN_BOOTSTRAP_TOKEN = "synthetic-bootstrap-token-for-tests";
  process.env.CREDENTIALS_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64url");
  process.env.DATABASE_URL = database.connectionString;

  const clientModule = await import("../src/db/client.server.ts");
  const { getPool } = clientModule;
  const seedStartedAt = performance.now();
  await getPool().query(
    `INSERT INTO fiscal_profiles (version, status, profile_json)
     VALUES (1, 'MOCK', '{}')`,
  );
  await getPool().query(
    `INSERT INTO customers
       (kind, match_key, display_name, email, billing_address_json,
        source_confidence, review_required)
     SELECT 'PRIVATE_IT', 'benchmark-' || value,
            'Cliente benchmark ' || lpad(value::text, 5, '0'),
            'cliente-' || value || '@example.invalid', '{}',
            CASE WHEN value % 20 = 0 THEN 'AMBIGUOUS' ELSE 'EXACT_PROFILE' END,
            value % 20 = 0
     FROM generate_series(1, $1::integer) AS value`,
    [CUSTOMER_COUNT],
  );
  await getPool().query(
    `INSERT INTO customer_source_records
       (customer_id, provider, external_customer_id, raw_snapshot_json)
     SELECT customers.id,
            CASE WHEN customers.id % 2 = 0 THEN 'SHOPIFY' ELSE 'EBAY' END,
            'benchmark-customer-' || customers.id, '{}'
     FROM customers`,
  );
  await getPool().query(
    `INSERT INTO billing_cases
       (customer_id, local_order_date, currency, status, customer_snapshot_json,
        fiscal_profile_version)
     SELECT customers.id, current_date - ((customers.id % 180)::integer), 'EUR',
            CASE WHEN customers.id % 20 = 0 THEN 'NEEDS_REVIEW' ELSE 'DRAFT' END,
            jsonb_build_object(
              'displayName', customers.display_name,
              'email', customers.email,
              'reviewRequired', customers.review_required
            ),
            1
     FROM customers
     WHERE customers.id <= $1::integer`,
    [PREPARATION_COUNT],
  );
  await getPool().query(
    `INSERT INTO orders
       (provider, external_account_id, external_order_id, display_number,
        created_at_source, updated_at_source, local_order_date, currency, gross_amount,
        payment_status, fulfillment_status, trigger_status, customer_id, billing_case_id,
        raw_snapshot_json, normalized_snapshot_json)
     SELECT CASE WHEN customers.id % 2 = 0 THEN 'SHOPIFY' ELSE 'EBAY' END,
            'benchmark-account',
            'benchmark-order-' || customers.id || '-' || sequence.value,
            'ORD-' || customers.id || '-' || sequence.value,
            now() - ((customers.id % 180)::integer * interval '1 day'),
            now() - ((customers.id % 180)::integer * interval '1 day'),
            current_date - ((customers.id % 180)::integer),
            'EUR', 10_000 + sequence.value,
            CASE WHEN sequence.value = 3 THEN 'PENDING' ELSE 'PAID' END,
            'FULFILLED',
            CASE
              WHEN billing_cases.id IS NOT NULL THEN 'GROUPED'
              WHEN customers.review_required THEN 'NEEDS_REVIEW'
              ELSE 'ELIGIBLE'
            END,
            customers.id, billing_cases.id, '{}',
            jsonb_build_object(
              'customerSnapshot', jsonb_build_object(
                'displayName', customers.display_name,
                'email', customers.email
              ),
              'customerReviewRequired', customers.review_required
            )
     FROM customers
     CROSS JOIN generate_series(1, $1::integer) AS sequence(value)
     LEFT JOIN billing_cases ON billing_cases.customer_id = customers.id`,
    [ORDERS_PER_CUSTOMER],
  );
  await getPool().query(
    `INSERT INTO documents
       (billing_case_id, kind, status, document_type, series, document_date,
        fiscal_profile_version, currency, total_amount, source_total_amount,
        difference_amount, projection_sha256, payment_method, recipient_snapshot_json)
     SELECT billing_cases.id, 'INVOICE', 'DRAFT', 'TD01', 'FPR',
            billing_cases.local_order_date, 1, 'EUR', 30_006, 30_006, 0,
            repeat('a', 64), 'MP08', billing_cases.customer_snapshot_json
     FROM billing_cases`,
  );
  await getPool().query("ANALYZE");
  const seedMs = performance.now() - seedStartedAt;

  const customers = await import("../src/db/customers.server.ts");
  const documents = await import("../src/db/document-archive.server.ts");
  const controls = await import("../src/db/operational-controls.server.ts");
  const orders = await import("../src/db/order-queries.server.ts");

  const results = {
    dashboard: rounded(await measure("dashboard", () => orders.dashboardSummary())),
    controlsSummary: rounded(
      await measure("riepilogo controlli", () => controls.getOperationalControlSummary()),
    ),
    orders: rounded(await measure("lista ordini", () => orders.listOrders({ status: "ACTIVE" }))),
    customersSummary: rounded(
      await measure("riepilogo clienti", () => customers.customerDirectorySummary()),
    ),
    customers: rounded(await measure("lista clienti", () => customers.listCustomers({}))),
    documentsSummary: rounded(
      await measure("riepilogo documenti", () => documents.documentArchiveSummary()),
    ),
    documents: rounded(await measure("lista documenti", () => documents.listDocuments({}))),
  };

  process.stdout.write(
    `${JSON.stringify(
      {
        dataset: {
          customers: CUSTOMER_COUNT,
          orders: CUSTOMER_COUNT * ORDERS_PER_CUSTOMER,
          preparations: PREPARATION_COUNT,
          documents: PREPARATION_COUNT,
        },
        samples: SAMPLE_RUNS,
        warmups: WARMUP_RUNS,
        seedMs: Number(seedMs.toFixed(1)),
        results,
      },
      null,
      2,
    )}\n`,
  );
  await clientModule.closePool();
} finally {
  const clientModule = await import("../src/db/client.server.ts");
  await clientModule.closePool();
  await database.drop();
}
