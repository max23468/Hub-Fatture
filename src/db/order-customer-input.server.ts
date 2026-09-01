import type pg from "pg";

import { automaticCustomerIdentityException } from "../customer-identity-exception.ts";
import { customerIdentity, type OrderInput } from "../orders.ts";
import { recoverCustomerTaxIdentifier } from "./order-customer-tax-recovery.server.ts";

export async function prepareCustomerInput(client: pg.PoolClient, sourceInput: OrderInput) {
  const taxRecovery = await recoverCustomerTaxIdentifier(client, sourceInput);
  const automaticException = automaticCustomerIdentityException(taxRecovery.input);
  const sourceIdentity = customerIdentity(taxRecovery.input);
  const proposedIdentity = customerIdentity(automaticException.input);
  const exception =
    sourceIdentity.reviewRequired && !proposedIdentity.reviewRequired
      ? automaticException.proposal
      : null;
  return {
    taxRecovery,
    exception,
    input: exception ? automaticException.input : taxRecovery.input,
  };
}
