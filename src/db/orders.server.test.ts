import test from "node:test";

import { temporaryDatabase } from "./database-fixture.ts";
import { runMigrations } from "./migrations.server.ts";
import { runImportAndSettingsScenario } from "./orders-scenarios/orders-import-settings.scenario.test.ts";
import { runMutationsAndGroupingScenario } from "./orders-scenarios/orders-mutations-grouping.scenario.test.ts";
import { runPaymentsAndHistoryScenario } from "./orders-scenarios/orders-payments-history.scenario.test.ts";
import { runRefundsAndConcurrencyScenario } from "./orders-scenarios/orders-refunds-concurrency.scenario.test.ts";
import { runSourceAlignmentScenario } from "./orders-scenarios/orders-source-alignment.scenario.test.ts";
import { createOrdersTestContext } from "./orders-scenarios/orders-test-support.test.ts";

test("il dominio ordini resta coerente su PostgreSQL reale", { timeout: 60_000 }, async (t) => {
  const clean = await temporaryDatabase("orders");
  try {
    await runMigrations({ connectionString: clean.connectionString });
    const context = await createOrdersTestContext(clean.connectionString);
    await t.test("importazione, impostazioni e letture concorrenti", () =>
      runImportAndSettingsScenario(context),
    );
    await t.test("mutazioni, raggruppamento e identità cliente", () =>
      runMutationsAndGroupingScenario(context),
    );
    await t.test("pagamenti, riconciliazione storica e casi complessi", () =>
      runPaymentsAndHistoryScenario(context),
    );
    await t.test("allineamento automatico delle sorgenti", () =>
      runSourceAlignmentScenario(context),
    );
    await t.test("rimborsi, concorrenza e proiezioni finali", () =>
      runRefundsAndConcurrencyScenario(context),
    );
    await context.database.closePool();
  } finally {
    await import("./client.server.ts").then(({ closePool }) => closePool());
    await clean.drop();
  }
});
