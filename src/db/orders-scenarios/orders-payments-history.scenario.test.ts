import { runExtendedHistoricalScenario } from "./orders-history-extended.scenario.test.ts";
import { runHistoricalMatchingScenario } from "./orders-history-matching.scenario.test.ts";
import { runPaymentsCoreScenario } from "./orders-payments-core.scenario.test.ts";
import type { OrdersTestContext } from "./orders-test-support.test.ts";

export async function runPaymentsAndHistoryScenario(context: OrdersTestContext) {
  const core = await runPaymentsCoreScenario(context);
  const matching = await runHistoricalMatchingScenario(context, core);
  await runExtendedHistoricalScenario(context, core, matching);
}
