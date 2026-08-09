import { AppError } from "../errors.ts";
import { orderInputSchema, type OrderInput } from "../orders.ts";

export function providerOrder(input: unknown): OrderInput {
  const parsed = orderInputSchema.safeParse(input);
  if (!parsed.success) throw new AppError("PROVIDER_RESPONSE_INVALID", 502);
  return parsed.data;
}
