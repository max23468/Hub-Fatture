import { isDeepStrictEqual } from "node:util";

import type pg from "pg";

import { canonicalCustomerProfile, type OrderInput } from "../orders.ts";

interface PriorTaxIdentifierRow {
  order_id: string;
  type: "CODICE_FISCALE" | "PARTITA_IVA" | "ALTRO";
  normalized_value: string;
  country_code: string | null;
  source_field: string;
  normalized_snapshot_json: Record<string, unknown>;
}

function strongProfile(input: OrderInput) {
  const profile = canonicalCustomerProfile(input);
  return {
    displayName: profile.displayName,
    email: profile.email,
    billingAddress: {
      line1: profile.billingAddress.line1,
      postalCode: profile.billingAddress.postalCode,
      city: profile.billingAddress.city,
      province: profile.billingAddress.province,
      countryCode: profile.billingAddress.countryCode,
    },
  };
}

function priorStrongProfile(snapshot: Record<string, unknown>) {
  const customer = snapshot.customerSnapshot as Record<string, unknown> | undefined;
  const profile = customer?.canonicalProfile as Record<string, unknown> | undefined;
  const address = profile?.billingAddress as Record<string, unknown> | undefined;
  return {
    displayName: profile?.displayName,
    email: profile?.email,
    billingAddress: {
      line1: address?.line1,
      postalCode: address?.postalCode,
      city: address?.city,
      province: address?.province,
      countryCode: address?.countryCode,
    },
  };
}

export interface TaxIdentifierRecovery {
  input: OrderInput;
  recovered: boolean;
  sourceOrderId?: string;
  identifierType?: "CODICE_FISCALE" | "PARTITA_IVA";
}

/** Recupera un'identità fiscale solo da un altro ordine dello stesso cliente sorgente. */
export async function recoverCustomerTaxIdentifier(
  client: pg.PoolClient,
  input: OrderInput,
): Promise<TaxIdentifierRecovery> {
  if (
    input.customer.taxIdentifiers.length > 0 ||
    !input.externalCustomerId ||
    !["PRIVATE_IT", "BUSINESS_IT"].includes(input.customer.kind)
  ) {
    return { input, recovered: false };
  }
  const expectedType = input.customer.kind === "PRIVATE_IT" ? "CODICE_FISCALE" : "PARTITA_IVA";
  const rows = await client.query<PriorTaxIdentifierRow>(
    `SELECT orders.id::text AS order_id, order_tax_identifiers.type,
            order_tax_identifiers.normalized_value, order_tax_identifiers.country_code,
            order_tax_identifiers.source_field, orders.normalized_snapshot_json
     FROM orders
     JOIN order_tax_identifiers ON order_tax_identifiers.order_id = orders.id
     WHERE orders.provider = $1 AND orders.external_account_id = $2
       AND orders.external_order_id <> $3
       AND orders.normalized_snapshot_json ->> 'externalCustomerId' = $4
       AND order_tax_identifiers.type = $5
     ORDER BY orders.updated_at_source DESC, orders.id DESC`,
    [
      input.provider,
      input.externalAccountId,
      input.externalOrderId,
      input.externalCustomerId,
      expectedType,
    ],
  );
  const profile = strongProfile(input);
  const matching = rows.rows.filter((row) =>
    isDeepStrictEqual(priorStrongProfile(row.normalized_snapshot_json), profile),
  );
  const identities = new Map<string, PriorTaxIdentifierRow>();
  for (const row of matching) {
    const key = JSON.stringify([row.type, row.country_code ?? "", row.normalized_value]);
    identities.set(key, row);
  }
  if (identities.size !== 1) return { input, recovered: false };
  const source = [...identities.values()][0]!;
  const recoveredInput: OrderInput = {
    ...input,
    customer: {
      ...input.customer,
      taxIdentifiers: [
        {
          type: source.type,
          value: source.normalized_value,
          countryCode: source.country_code ?? "IT",
          sourceField: `priorOrder:${source.order_id}:${source.source_field}`,
        },
      ],
    },
  };
  return {
    input: recoveredInput,
    recovered: true,
    sourceOrderId: source.order_id,
    identifierType: expectedType,
  };
}
