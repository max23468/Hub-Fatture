import { run as ebayIdentity } from "./orders-ebay-identity.scenario.test.ts";
import { run as refundsConcurrency } from "./orders-refunds-concurrency.scenario.test.ts";
import type { OrdersTestContext } from "./orders-test-support.test.ts";

export async function run(context: OrdersTestContext) {
  await refundsConcurrency(context);
  await ebayIdentity(context);
}
