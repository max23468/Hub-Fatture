import test from "node:test";

import { temporaryDatabase } from "./database-fixture.ts";
import { runMigrations } from "./migrations.server.ts";
import { run as identityException } from "./orders-scenarios/orders-customer-identity-exception.scenario.test.ts";
import { run as importSettings } from "./orders-scenarios/orders-import-settings.scenario.test.ts";
import { run as mutationsGrouping } from "./orders-scenarios/orders-mutations-grouping.scenario.test.ts";
import { runExtendedHistoricalScenario } from "./orders-scenarios/orders-history-extended.scenario.test.ts";
import { runHistoricalMatchingScenario } from "./orders-scenarios/orders-history-matching.scenario.test.ts";
import { runPaymentsCoreScenario } from "./orders-scenarios/orders-payments-core.scenario.test.ts";
import { run as ebayIdentity } from "./orders-scenarios/orders-ebay-identity.scenario.test.ts";
import { run as refundsConcurrency } from "./orders-scenarios/orders-refunds-concurrency.scenario.test.ts";
import { run as sourceAlignment } from "./orders-scenarios/orders-source-alignment.scenario.test.ts";
import { createOrdersTestContext } from "./orders-scenarios/orders-test-support.test.ts";

test("il dominio ordini resta coerente su PostgreSQL reale", { timeout: 120_000 }, async (t) => {
  const clean = await temporaryDatabase("orders");
  try {
    await runMigrations({ connectionString: clean.connectionString });
    const context = await createOrdersTestContext(clean.connectionString);
    await t.test("importazione, impostazioni e letture concorrenti", () => importSettings(context));
    await t.test("mutazioni, raggruppamento e identità cliente", () => mutationsGrouping(context));
    await t.test("pagamenti, riconciliazione storica e casi complessi", async () => {
      const core = await runPaymentsCoreScenario(context);
      const matching = await runHistoricalMatchingScenario(context, core);
      await runExtendedHistoricalScenario(context, core, matching);
    });
    await t.test("allineamento automatico delle sorgenti", () => sourceAlignment(context));
    await t.test("deroga automatica dell’identità cliente", () => identityException(context));
    await t.test("rimborsi, concorrenza e proiezioni finali", async () => {
      await refundsConcurrency(context);
      await ebayIdentity(context);
    });
    await context.database.closePool();
  } finally {
    await import("./client.server.ts").then(({ closePool }) => closePool());
    await clean.drop();
  }
});
