import { createHash } from "node:crypto";
import path from "node:path";

import type pg from "pg";
import { AppError } from "../errors.ts";
import { z } from "zod";
import { validateUntrustedXml } from "../aruba.ts";
import { acceptedInvoiceFromXml, fiscalProfileSchema, type FiscalProfile } from "../documents.ts";
import { validateFatturaXml } from "../fatturapa.server.ts";
import {
  draftTriggerSchema,
  POSTGRES_INTEGER_MAX,
  shopifyPaymentFeeModeSchema,
  triggerStatus,
  type OrderInput,
} from "../orders.ts";
import { preIssueRefund } from "../refunds.ts";
import { writeAudit } from "./audit.server.ts";
import { getPool, withTransaction } from "./client.server.ts";
import { isDatabaseId } from "./database-id.ts";
import { archiveImportedInvoiceXml } from "./document-storage.server.ts";
import {
  groupOrder,
  reconcileInvoiceDraft,
  reconcilePreIssueInvoiceAmount,
  type Actor,
} from "./order-import.server.ts";
import { serializeOrderMutations } from "./order-mutation-lock.server.ts";

const historicalReconciliationSchema = z.object({
  outcome: z.enum(["ALREADY_INVOICED", "NOT_INVOICED"]),
  reference: z.string().trim().min(10).max(500),
});

function fiscalContract(profile: FiscalProfile) {
  const { phone: _phone, email: _email, ...seller } = profile.seller;
  const { invoiceMethod: _invoiceMethod, ...payment } = profile.payment;
  const {
    lastObservedYear: _year,
    lastObservedNumber: _number,
    sourceXmlSha256: _sha256,
    approvedAt: _approvedAt,
    ...numbering
  } = profile.numbering;
  return { ...profile, seller, numbering, payment };
}

function hasOrderReference(references: string[], provider: string, displayNumber: string) {
  const expectedProvider = provider.toLowerCase();
  const expectedNumber = displayNumber.toLowerCase();
  return references.some((reference) => {
    const value = reference.toLowerCase();
    if (!value.includes(expectedProvider)) return false;
    const boundary = /[\p{L}\p{N}]/u;
    for (let index = value.indexOf(expectedNumber); index >= 0;) {
      if (
        !boundary.test(value[index - 1] ?? "") &&
        !boundary.test(value[index + expectedNumber.length] ?? "")
      ) {
        return true;
      }
      index = value.indexOf(expectedNumber, index + expectedNumber.length);
    }
    return false;
  });
}

function hasBareOrderReference(references: string[], displayNumber: string) {
  const expectedNumber = displayNumber.toLowerCase();
  const boundary = /[\p{L}\p{N}]/u;
  return references.some((reference) => {
    const value = reference.toLowerCase();
    for (let index = value.indexOf(expectedNumber); index >= 0;) {
      const prefix = value.slice(Math.max(0, index - 32), index);
      if (
        !boundary.test(value[index - 1] ?? "") &&
        !boundary.test(value[index + expectedNumber.length] ?? "") &&
        /(?:^|[^\p{L}\p{N}])ordine(?:\s+n(?:umero)?\.?)?\s*$/u.test(prefix)
      ) {
        return true;
      }
      index = value.indexOf(expectedNumber, index + expectedNumber.length);
    }
    return false;
  });
}

function hasGenericOrderReference(references: string[]) {
  return references.some((reference) => {
    if (/(?:^|[^\p{L}\p{N}])\d{2}-\d{5}-\d{5}(?=$|[^\p{L}\p{N}])/u.test(reference)) {
      return true;
    }
    const orderReferences = Array.from(
      reference.matchAll(
        /(?:^|[^\p{L}\p{N}])ordine(?:\s+n(?:umero)?\.?)?\s*#?\s*([\p{L}\p{N}][\p{L}\p{N}-]{0,63})/giu,
      ),
      (match) => match[1]!,
    );
    const hashReferences = Array.from(
      reference.matchAll(
        /(?:^|[^\p{L}\p{N}])#([\p{L}\p{N}][\p{L}\p{N}-]{0,63})(?=$|[^\p{L}\p{N}-])/giu,
      ),
      (match) => match[1]!,
    );
    return [...orderReferences, ...hashReferences].some((candidate) => /\d/u.test(candidate));
  });
}

function hasIncompatibleMarketplaceMarker(references: string[], provider: "SHOPIFY" | "EBAY") {
  const expected = provider.toLowerCase();
  return references.some((reference) =>
    Array.from(
      reference.matchAll(/(^|[^\p{L}\p{N}])(ebay|shopify)(?=$|[^\p{L}\p{N}])/giu),
      (match) => match[2]!.toLowerCase(),
    ).some((marker) => marker !== expected),
  );
}

function hasConflictingMarketplaceReference(references: string[], provider: "SHOPIFY" | "EBAY") {
  if (hasIncompatibleMarketplaceMarker(references, provider)) return true;
  if (hasGenericOrderReference(references)) return true;
  const providerPattern = provider === "SHOPIFY" ? "shopify" : "ebay";
  const providerMarker = new RegExp(
    `(^|[^\\p{L}\\p{N}])${providerPattern}(?=$|[^\\p{L}\\p{N}])`,
    "iu",
  );
  return (
    references.some((reference) => providerMarker.test(reference)) &&
    references.some((reference) => /\d/u.test(reference))
  );
}

function attributedInvoiceAmount(
  invoice: ReturnType<typeof acceptedInvoiceFromXml>,
  provider: string,
  displayNumber: string,
) {
  const matchingLines = invoice.input.lines.filter((line) =>
    hasOrderReference([line.description], provider, displayNumber),
  );
  if (matchingLines.length > 0) {
    return matchingLines.reduce((sum, line) => sum + line.unitAmount * line.quantity, 0);
  }
  return invoice.input.lines.length === 1 &&
    hasOrderReference(invoice.references, provider, displayNumber)
    ? invoice.totalAmount
    : null;
}

function normalizedIdentityPart(value: unknown) {
  return typeof value === "string"
    ? value
        .normalize("NFKD")
        .replace(/\p{M}/gu, "")
        .toLocaleLowerCase("it")
        .replace(/[^\p{L}\p{N}]+/gu, " ")
        .trim()
        .replace(/\s+/g, " ")
    : "";
}

function identityTokens(value: unknown) {
  return new Set(normalizedIdentityPart(value).split(" ").filter(Boolean));
}

function sameTokenSet(left: unknown, right: unknown) {
  const leftTokens = identityTokens(left);
  const rightTokens = identityTokens(right);
  return (
    leftTokens.size > 0 &&
    leftTokens.size === rightTokens.size &&
    [...leftTokens].every((token) => rightTokens.has(token))
  );
}

function isPersonalNameSubset(candidateName: unknown, recipientName: unknown) {
  const candidateTokens = identityTokens(candidateName);
  const recipientTokens = identityTokens(recipientName);
  return (
    recipientTokens.size >= 2 &&
    candidateTokens.size >= recipientTokens.size &&
    [...recipientTokens].every((token) => candidateTokens.has(token))
  );
}

function sameNonEmptyIdentityPart(left: unknown, right: unknown) {
  const normalizedLeft = normalizedIdentityPart(left);
  return Boolean(normalizedLeft && normalizedLeft === normalizedIdentityPart(right));
}

const streetKindTokens = new Set([
  "via",
  "viale",
  "vicolo",
  "piazza",
  "piazzale",
  "corso",
  "strada",
  "largo",
  "lungomare",
  "localita",
  "frazione",
  "contrada",
  "rue",
  "avenue",
  "boulevard",
  "chemin",
  "route",
  "street",
  "road",
  "lane",
  "drive",
  "place",
  "ul",
  "ulica",
  "aleja",
]);

const streetConnectorTokens = new Set([
  "de",
  "del",
  "della",
  "delle",
  "dei",
  "degli",
  "di",
  "da",
  "dal",
  "dalla",
  "das",
  "do",
  "dos",
  "la",
  "le",
  "les",
  "el",
  "los",
  "las",
  "the",
]);

function normalizedAddressTokens(value: unknown) {
  return normalizedIdentityPart(value).split(" ").filter(Boolean);
}

function compactAddressPart(value: unknown) {
  return normalizedIdentityPart(value).replaceAll(" ", "");
}

function withoutAddressPart(tokens: string[], value: unknown) {
  const expected = compactAddressPart(value);
  if (!expected) return tokens;
  return tokens.filter((_, index) => {
    if (tokens[index] === expected) return false;
    if (`${tokens[index]}${tokens[index + 1] ?? ""}` === expected) return false;
    if (`${tokens[index - 1] ?? ""}${tokens[index]}` === expected) return false;
    return true;
  });
}

function distinctiveStreetTokens(
  address: unknown,
  streetNumber: unknown,
  postalCode: unknown,
  keepNumeric: boolean,
) {
  const tokens = withoutAddressPart(
    withoutAddressPart(normalizedAddressTokens(address), streetNumber),
    postalCode,
  );
  const kindIndex = tokens.findIndex((token) => streetKindTokens.has(token));
  return tokens.filter(
    (token, index) =>
      index !== kindIndex &&
      !streetConnectorTokens.has(token) &&
      token !== "civico" &&
      token !== "snc" &&
      (keepNumeric || !/^\d/u.test(token)),
  );
}

function orderedCommonTokenCount(left: string[], right: string[]) {
  const counts = Array.from({ length: left.length + 1 }, () =>
    Array<number>(right.length + 1).fill(0),
  );
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      counts[leftIndex]![rightIndex] =
        left[leftIndex - 1] === right[rightIndex - 1]
          ? counts[leftIndex - 1]![rightIndex - 1]! + 1
          : Math.max(counts[leftIndex - 1]![rightIndex]!, counts[leftIndex]![rightIndex - 1]!);
    }
  }
  return counts[left.length]![right.length]!;
}

function streetKind(address: unknown, streetNumber: unknown, postalCode: unknown) {
  return withoutAddressPart(
    withoutAddressPart(normalizedAddressTokens(address), streetNumber),
    postalCode,
  ).find((token) => streetKindTokens.has(token));
}

function containsStructuredStreetNumber(
  address: unknown,
  streetNumber: unknown,
  postalCode: unknown,
) {
  const expected = compactAddressPart(streetNumber);
  const addressParts = withoutAddressPart(normalizedAddressTokens(address), postalCode);
  return Boolean(
    expected &&
    addressParts.some(
      (part, index) => part === expected || `${part}${addressParts[index + 1] ?? ""}` === expected,
    ),
  );
}

function hasSupportingAddressEvidence(
  customerAddress: Record<string, unknown>,
  recipientAddress: ReturnType<typeof acceptedInvoiceFromXml>["input"]["recipient"]["address"],
) {
  const samePostalCode = sameNonEmptyIdentityPart(
    customerAddress.postalCode,
    recipientAddress.postalCode,
  );
  const sameCity = sameNonEmptyIdentityPart(customerAddress.city, recipientAddress.city);
  const sameAddressLine = sameNonEmptyIdentityPart(customerAddress.line1, recipientAddress.line1);
  if (recipientAddress.streetNumber) {
    const customerCountry = normalizedIdentityPart(customerAddress.countryCode);
    const recipientCountry = normalizedIdentityPart(recipientAddress.countryCode);
    const customerStreetTokens = distinctiveStreetTokens(
      customerAddress.line1,
      recipientAddress.streetNumber,
      customerAddress.postalCode,
      customerCountry === "it",
    );
    const recipientStreetTokens = distinctiveStreetTokens(
      recipientAddress.line1,
      recipientAddress.streetNumber,
      recipientAddress.postalCode,
      customerCountry === "it",
    );
    if (
      !customerCountry ||
      customerCountry !== recipientCountry ||
      !containsStructuredStreetNumber(
        customerAddress.line1,
        recipientAddress.streetNumber,
        customerAddress.postalCode,
      )
    ) {
      return false;
    }
    const sharedStreetTokens = orderedCommonTokenCount(customerStreetTokens, recipientStreetTokens);
    if (customerCountry === "it") {
      const sameStreetTokens =
        customerStreetTokens.length > 0 &&
        customerStreetTokens.length === recipientStreetTokens.length &&
        customerStreetTokens.every((token, index) => token === recipientStreetTokens[index]);
      const sameShortStreetEnding =
        sharedStreetTokens === 1 &&
        customerStreetTokens.length <= 2 &&
        recipientStreetTokens.length <= 2 &&
        customerStreetTokens.at(-1) === recipientStreetTokens.at(-1);
      return (
        samePostalCode &&
        sameCity &&
        streetKind(
          customerAddress.line1,
          recipientAddress.streetNumber,
          customerAddress.postalCode,
        ) ===
          streetKind(
            recipientAddress.line1,
            recipientAddress.streetNumber,
            recipientAddress.postalCode,
          ) &&
        (sameStreetTokens || sameShortStreetEnding)
      );
    }
    return sharedStreetTokens >= 2;
  }
  return sameAddressLine && samePostalCode && sameCity;
}

function customerIdentityNames(customer: Record<string, unknown>, business: boolean) {
  const canonical =
    customer.canonicalProfile && typeof customer.canonicalProfile === "object"
      ? (customer.canonicalProfile as Record<string, unknown>)
      : {};
  const businessNames = [customer.companyName, canonical.companyName].filter((value) =>
    normalizedIdentityPart(value),
  );
  const personalNames = [
    [customer.firstName, customer.lastName].filter(Boolean).join(" "),
    [canonical.firstName, canonical.lastName].filter(Boolean).join(" "),
  ].filter((value) => normalizedIdentityPart(value));
  const typedNames = business ? businessNames : personalNames;
  if (typedNames.length > 0) return typedNames;
  if ((business ? personalNames : businessNames).length > 0) return [];
  return [customer.displayName, canonical.displayName].filter((value) =>
    normalizedIdentityPart(value),
  );
}

function hasExplicitBusinessName(customer: Record<string, unknown>) {
  const canonical =
    customer.canonicalProfile && typeof customer.canonicalProfile === "object"
      ? (customer.canonicalProfile as Record<string, unknown>)
      : {};
  return [customer.companyName, canonical.companyName].some((value) =>
    Boolean(normalizedIdentityPart(value)),
  );
}

function matchesRecipientWithoutTaxId(
  customer: Record<string, unknown>,
  recipient: ReturnType<typeof acceptedInvoiceFromXml>["input"]["recipient"],
) {
  const billingAddress =
    customer.billingAddress && typeof customer.billingAddress === "object"
      ? (customer.billingAddress as Record<string, unknown>)
      : {};
  const recipientBusinessName = normalizedIdentityPart(recipient.businessName);
  const recipientName =
    recipientBusinessName ||
    normalizedIdentityPart([recipient.firstName, recipient.lastName].filter(Boolean).join(" "));
  const customerKind = typeof customer.kind === "string" ? customer.kind.trim().toUpperCase() : "";
  const hasCustomerBusinessName = hasExplicitBusinessName(customer);
  const customerIsBusiness =
    customerKind === "BUSINESS_IT" || (customerKind === "EU" && hasCustomerBusinessName);
  const customerIsPersonal =
    customerKind === "PRIVATE_IT" || (customerKind === "EU" && !hasCustomerBusinessName);
  if (
    (customerIsBusiness && !recipientBusinessName) ||
    (customerIsPersonal && recipientBusinessName)
  ) {
    return false;
  }
  const business = customerIsBusiness || (!customerIsPersonal && Boolean(recipientBusinessName));
  const customerCountry = normalizedIdentityPart(billingAddress.countryCode);
  const recipientCountry = normalizedIdentityPart(recipient.address.countryCode);
  if (!recipientName || !customerCountry || customerCountry !== recipientCountry) return false;
  return customerIdentityNames(customer, business).some(
    (customerName) =>
      (business
        ? sameNonEmptyIdentityPart(customerName, recipientName)
        : sameTokenSet(customerName, recipientName) ||
          (customerCountry !== "it" && isPersonalNameSubset(customerName, recipientName))) &&
      hasSupportingAddressEvidence(billingAddress, recipient.address),
  );
}

function historicalDocumentDateAllowed(orderDate: string, documentDate: string) {
  const difference = Date.parse(`${documentDate}T00:00:00Z`) - Date.parse(`${orderDate}T00:00:00Z`);
  return difference >= 0 && difference <= 7 * 24 * 60 * 60 * 1000;
}

function taxIdentifierKey(identifier: {
  type: string;
  value: string;
  countryCode?: string | null;
}) {
  const value = identifier.value
    .normalize("NFKC")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
  const countryCode = (
    identifier.countryCode ??
    (identifier.type === "CODICE_FISCALE" ||
    (identifier.type === "PARTITA_IVA" && /^\d{11}$/.test(value))
      ? "IT"
      : "")
  ).toUpperCase();
  return JSON.stringify([identifier.type, countryCode, value]);
}

type ImportedHistoricalInvoice = ReturnType<typeof acceptedInvoiceFromXml>;

interface HistoricalInvoiceCandidate {
  id: string;
  provider: "SHOPIFY" | "EBAY";
  customer_snapshot: Record<string, unknown>;
  local_order_date: string;
  gross_amount: number;
  billable_amount: number;
  tax_identifiers: Array<{
    type: string;
    value: string;
    countryCode: string | null;
  }>;
  refunds: Array<{
    status: string;
    amount: number | null;
    completed_date: string | null;
  }>;
}

function matchesHistoricalRecipient(
  candidate: HistoricalInvoiceCandidate,
  invoice: ImportedHistoricalInvoice,
  invoiceTaxIdentifiers: Set<string>,
) {
  return candidate.tax_identifiers.length > 0
    ? candidate.tax_identifiers.some((identifier) =>
        invoiceTaxIdentifiers.has(taxIdentifierKey(identifier)),
      )
    : matchesRecipientWithoutTaxId(candidate.customer_snapshot, invoice.input.recipient);
}

function expectedHistoricalInvoiceAmount(
  candidate: HistoricalInvoiceCandidate,
  documentDate: string,
) {
  if (
    candidate.refunds.some(
      (refund) =>
        refund.status === "AMBIGUOUS" ||
        (refund.status === "COMPLETED" &&
          (refund.amount === null ||
            !refund.completed_date ||
            refund.completed_date === documentDate)),
    )
  ) {
    return null;
  }
  const amount =
    (candidate.provider === "SHOPIFY" ? candidate.billable_amount : candidate.gross_amount) -
    candidate.refunds
      .filter((refund) => refund.status === "COMPLETED" && refund.completed_date! < documentDate)
      .reduce((sum, refund) => sum + refund.amount!, 0);
  return amount >= 0 ? amount : null;
}

async function uniquelyMatchesUnreferencedMarketplaceInvoice(
  client: pg.PoolClient,
  currentId: string,
  invoice: ImportedHistoricalInvoice,
  invoiceTaxIdentifiers: Set<string>,
) {
  const candidates = await client.query<HistoricalInvoiceCandidate>(
    `SELECT orders.id, orders.provider,
            orders.normalized_snapshot_json -> 'customerSnapshot' AS customer_snapshot,
            orders.local_order_date::text, orders.gross_amount, orders.billable_amount,
            coalesce((
              SELECT jsonb_agg(jsonb_build_object(
                'type', order_tax_identifiers.type,
                'value', order_tax_identifiers.normalized_value,
                'countryCode', order_tax_identifiers.country_code
              ))
              FROM order_tax_identifiers WHERE order_tax_identifiers.order_id = orders.id
            ), '[]'::jsonb) AS tax_identifiers,
            coalesce((
              SELECT jsonb_agg(jsonb_build_object(
                'status', refunds.status, 'amount', refunds.amount,
                'completed_date', (refunds.completed_at AT TIME ZONE 'Europe/Rome')::date::text
              )) FROM refunds WHERE refunds.order_id = orders.id
            ), '[]'::jsonb) AS refunds
     FROM orders
     WHERE coalesce((orders.normalized_snapshot_json ->> 'historical')::boolean, false)
       AND (
         orders.id = $1
         OR (orders.trigger_status = 'LEGACY_BILLING_REVIEW'
           AND orders.historical_reconciliation_outcome IS NULL
           AND orders.historical_reconciled_at IS NULL)
         OR (orders.historical_reconciliation_outcome = 'ALREADY_INVOICED'
           AND NOT EXISTS (
             SELECT 1 FROM document_orders
             JOIN documents ON documents.id = document_orders.document_id
             WHERE document_orders.order_id = orders.id
               AND document_orders.document_kind = 'INVOICE'
               AND documents.origin = 'ARUBA_HISTORY'
           ))
       )
     FOR UPDATE OF orders`,
    [currentId],
  );
  const matches = candidates.rows.filter(
    (candidate) =>
      !hasConflictingMarketplaceReference(invoice.references, candidate.provider) &&
      historicalDocumentDateAllowed(candidate.local_order_date, invoice.documentDate) &&
      expectedHistoricalInvoiceAmount(candidate, invoice.documentDate) === invoice.totalAmount &&
      matchesHistoricalRecipient(candidate, invoice, invoiceTaxIdentifiers),
  );
  return matches.length === 1 && matches[0]!.id === currentId;
}

export async function getDraftTrigger() {
  const result = await getPool().query<{ value_json: unknown; version: number }>(
    "SELECT value_json, version FROM settings WHERE key = 'draft_trigger'",
  );
  return {
    value: draftTriggerSchema.parse(result.rows[0]?.value_json ?? "PAID"),
    version: result.rows[0]?.version ?? 0,
  };
}

export async function getShopifyPaymentFeeMode() {
  const result = await getPool().query<{ value_json: unknown; version: number }>(
    "SELECT value_json, version FROM settings WHERE key = 'shopify_payment_fee_mode'",
  );
  return {
    value: shopifyPaymentFeeModeSchema.parse(result.rows[0]?.value_json ?? "DEDUCT"),
    version: result.rows[0]?.version ?? 0,
  };
}

export async function setShopifyPaymentFeeMode(
  value: unknown,
  expectedVersion: number,
  actor: Actor,
) {
  const mode = shopifyPaymentFeeModeSchema.safeParse(value);
  if (
    !mode.success ||
    !Number.isInteger(expectedVersion) ||
    expectedVersion < 0 ||
    expectedVersion > POSTGRES_INTEGER_MAX
  ) {
    throw new AppError("ORDER_INVALID_INPUT", 422);
  }
  return withTransaction(async (client) => {
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext('setting:shopify_payment_fee_mode'))",
    );
    await serializeOrderMutations(client);
    const setting = await client.query<{ version: number; value_json: unknown }>(
      "SELECT version, value_json FROM settings WHERE key = 'shopify_payment_fee_mode' FOR UPDATE",
    );
    if (setting.rows[0]?.version !== expectedVersion) {
      throw new AppError("CONFLICT_REVISION", 409);
    }
    const previousMode = shopifyPaymentFeeModeSchema.parse(setting.rows[0]?.value_json ?? "DEDUCT");
    const updated = await client.query<{ version: number }>(
      `UPDATE settings SET value_json = $1, version = version + 1, updated_at = now()
       WHERE key = 'shopify_payment_fee_mode' RETURNING version`,
      [JSON.stringify(mode.data)],
    );
    // La seconda scrittura dipende dalla versione appena fissata nella stessa transazione.
    // react-doctor-disable-next-line react-doctor/server-sequential-independent-await
    const changedOrders = await client.query<{ billing_case_id: string | null }>(
      `UPDATE orders
       SET deducted_shopify_payments_fee_amount = CASE
             WHEN $1 = 'DEDUCT' THEN shopify_payments_fee_amount ELSE 0
           END,
           normalized_snapshot_json = jsonb_set(
             jsonb_set(
               normalized_snapshot_json,
               '{deductedShopifyPaymentsFeeAmount}',
               to_jsonb(CASE WHEN $1 = 'DEDUCT' THEN shopify_payments_fee_amount ELSE 0 END)
             ),
             '{billableAmount}',
             to_jsonb(gross_amount - CASE
               WHEN $1 = 'DEDUCT' THEN shopify_payments_fee_amount ELSE 0
             END)
           )
       WHERE provider = 'SHOPIFY'
         AND deducted_shopify_payments_fee_amount <> CASE
           WHEN $1 = 'DEDUCT' THEN shopify_payments_fee_amount ELSE 0
         END
         AND historical_reconciliation_outcome IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM document_orders
           JOIN documents ON documents.id = document_orders.document_id
           WHERE document_orders.order_id = orders.id
             AND document_orders.document_kind = 'INVOICE'
             AND documents.status = 'APPROVED'
         )
       RETURNING billing_case_id::text`,
      [mode.data],
    );
    const caseIds = new Set(
      changedOrders.rows.flatMap((order) =>
        order.billing_case_id === null ? [] : [order.billing_case_id],
      ),
    );
    for (const caseId of caseIds) {
      // Una sola connessione transazionale aggiorna le bozze in ordine deterministico.
      // react-doctor-disable-next-line react-doctor/async-await-in-loop
      await reconcileInvoiceDraft(client, caseId);
    }
    await writeAudit(client, {
      actorType: "ADMIN",
      actorId: actor.id === undefined ? null : String(actor.id),
      action: "SHOPIFY_PAYMENT_FEE_MODE_CHANGED",
      eventClass: "CRITICAL",
      entityType: "SETTING",
      entityId: "shopify_payment_fee_mode",
      before: { mode: previousMode },
      after: { mode: mode.data, updatedOrders: changedOrders.rowCount ?? 0 },
      requestId: actor.requestId,
    });
    return { value: mode.data, version: updated.rows[0]!.version };
  });
}

export async function setDraftTrigger(value: unknown, expectedVersion: number, actor: Actor) {
  const trigger = draftTriggerSchema.safeParse(value);
  if (
    !trigger.success ||
    !Number.isInteger(expectedVersion) ||
    expectedVersion < 0 ||
    expectedVersion > POSTGRES_INTEGER_MAX
  ) {
    throw new AppError("ORDER_INVALID_INPUT", 422);
  }
  return withTransaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('setting:draft_trigger'))");
    await serializeOrderMutations(client);
    const setting = await client.query<{ version: number }>(
      "SELECT version FROM settings WHERE key = 'draft_trigger' FOR UPDATE",
    );
    if (setting.rows[0]?.version !== expectedVersion) {
      throw new AppError("CONFLICT_REVISION", 409);
    }
    const updated = await client.query<{ version: number }>(
      `UPDATE settings
       SET value_json = $1, version = version + 1, updated_at = now()
       WHERE key = 'draft_trigger'
       RETURNING version`,
      [JSON.stringify(trigger.data)],
    );
    await writeAudit(client, {
      actorType: "ADMIN",
      actorId: String(actor.id),
      action: "DRAFT_TRIGGER_CHANGED",
      eventClass: "CRITICAL",
      entityType: "SETTING",
      entityId: "draft_trigger",
      metadata: { value: trigger.data },
      requestId: actor.requestId,
    });
    const ungrouped = await client.query<{
      id: string;
      customer_id: string;
      customer_snapshot: Record<string, unknown>;
      local_order_date: string;
      currency: string;
      payment_status: OrderInput["paymentStatus"];
      fulfillment_status: OrderInput["fulfillmentStatus"];
      cancelled_at: string | null;
      historical: boolean;
      historical_reconciliation_outcome: "ALREADY_INVOICED" | "NOT_INVOICED" | null;
    }>(
      `SELECT orders.id, orders.customer_id,
              orders.normalized_snapshot_json -> 'customerSnapshot' AS customer_snapshot,
              orders.local_order_date::text, orders.currency, orders.payment_status,
              orders.fulfillment_status, orders.cancelled_at,
              orders.historical_reconciliation_outcome,
              coalesce((orders.normalized_snapshot_json ->> 'historical')::boolean, false)
                AS historical
       FROM orders
       WHERE orders.billing_case_id IS NULL`,
    );
    for (const order of ungrouped.rows) {
      const status =
        order.historical_reconciliation_outcome === "ALREADY_INVOICED"
          ? "INVOICED"
          : triggerStatus(
              {
                cancelledAt: order.cancelled_at,
                paymentStatus: order.payment_status,
                fulfillmentStatus: order.fulfillment_status,
                historical: order.historical && order.historical_reconciliation_outcome === null,
              },
              trigger.data,
            );
      const updatedOrder = await client.query(
        `UPDATE orders SET trigger_status = $2
         WHERE id = $1 AND billing_case_id IS NULL
         RETURNING id`,
        [order.id, status],
      );
      if (status === "ELIGIBLE" && updatedOrder.rowCount) {
        await groupOrder(
          client,
          {
            id: order.id,
            customerId: order.customer_id,
            customerSnapshot: order.customer_snapshot,
            localOrderDate: order.local_order_date,
            currency: order.currency,
          },
          actor,
        );
      }
    }
    return { value: trigger.data, version: updated.rows[0]!.version };
  });
}

export async function reconcileHistoricalOrder(
  id: string,
  raw: { outcome: unknown; reference: unknown; invoiceXml?: Buffer },
  actor: Actor & { canApprove: boolean },
) {
  if (!actor.canApprove) throw new AppError("ORDER_HISTORY_RECONCILIATION_FORBIDDEN", 403);
  if (!isDatabaseId(id)) return null;
  const parsed = historicalReconciliationSchema.safeParse(raw);
  if (!parsed.success || actor.id === undefined) throw new AppError("ORDER_INVALID_INPUT", 422);
  let importedInvoice: ReturnType<typeof acceptedInvoiceFromXml> | null = null;
  let importedTaxIdentifiers = new Set<string>();
  let invoicePath: string | null = null;
  if (parsed.data.outcome === "ALREADY_INVOICED") {
    if (!raw.invoiceXml?.byteLength) {
      throw new AppError("ORDER_HISTORY_INVOICE_REQUIRED", 422);
    }
    try {
      const xml = validateUntrustedXml(raw.invoiceXml);
      await validateFatturaXml(xml);
      importedInvoice = acceptedInvoiceFromXml(xml, new Date().toISOString());
      importedTaxIdentifiers = new Set(
        importedInvoice.input.recipient.taxIdentifiers.map(taxIdentifierKey),
      );
      const digest = createHash("sha256").update(xml).digest("hex");
      invoicePath = path.posix.join(
        "invoices",
        "history",
        String(importedInvoice.year),
        `${importedInvoice.documentNumber.replaceAll(" ", "-").replaceAll("/", "-")}-${digest}.xml`,
      );
    } catch (error) {
      if (error instanceof AppError && error.code === "DOCUMENT_STORAGE_FAILED") throw error;
      throw new AppError("ORDER_HISTORY_INVOICE_INVALID", 422);
    }
  }
  return withTransaction(async (client) => {
    let archivedInvoice: Awaited<ReturnType<typeof archiveImportedInvoiceXml>> | null = null;
    try {
      if (importedInvoice && invoicePath) {
        archivedInvoice = await archiveImportedInvoiceXml(client, invoicePath, importedInvoice.xml);
      }
      await client.query("SELECT pg_advisory_xact_lock_shared(hashtext('setting:draft_trigger'))");
      await client.query(
        "SELECT pg_advisory_xact_lock_shared(hashtext('setting:shopify_payment_fee_mode'))",
      );
      await serializeOrderMutations(client);
      const order = await client.query<{
        id: string;
        customer_id: string;
        customer_snapshot: Record<string, unknown>;
        local_order_date: string;
        currency: string;
        payment_status: OrderInput["paymentStatus"];
        provider: "SHOPIFY" | "EBAY";
        display_number: string;
        fulfillment_status: OrderInput["fulfillmentStatus"];
        cancelled_at: string | null;
        trigger_status: string;
        historical: boolean;
        historical_reconciled_at: Date | null;
        historical_reconciliation_outcome: "ALREADY_INVOICED" | "NOT_INVOICED" | null;
        historical_invoice_id: string | null;
        gross_amount: number;
        billable_amount: number;
        tax_identifiers: Array<{
          type: string;
          value: string;
          countryCode: string | null;
        }>;
        refunds: Array<{
          id: string;
          status: string;
          amount: number | null;
          completed_date: string | null;
        }>;
      }>(
        `SELECT orders.id, orders.customer_id, orders.provider, orders.display_number,
              orders.normalized_snapshot_json -> 'customerSnapshot' AS customer_snapshot,
              orders.local_order_date::text, orders.currency, orders.payment_status,
              orders.fulfillment_status, orders.cancelled_at, orders.trigger_status,
              coalesce((orders.normalized_snapshot_json ->> 'historical')::boolean, false)
                AS historical,
              orders.historical_reconciled_at, orders.gross_amount, orders.billable_amount,
              orders.historical_reconciliation_outcome,
              (SELECT document_orders.document_id::text
               FROM document_orders JOIN documents ON documents.id = document_orders.document_id
               WHERE document_orders.order_id = orders.id
                 AND document_orders.document_kind = 'INVOICE'
                 AND documents.origin = 'ARUBA_HISTORY' LIMIT 1) AS historical_invoice_id,
              coalesce((
                SELECT jsonb_agg(jsonb_build_object(
                  'type', order_tax_identifiers.type,
                  'value', order_tax_identifiers.normalized_value,
                  'countryCode', order_tax_identifiers.country_code
                ))
                FROM order_tax_identifiers WHERE order_tax_identifiers.order_id = orders.id
              ), '[]'::jsonb) AS tax_identifiers,
              coalesce((
                SELECT jsonb_agg(jsonb_build_object(
                  'id', refunds.id::text, 'status', refunds.status, 'amount', refunds.amount,
                  'completed_date',
                    (refunds.completed_at AT TIME ZONE 'Europe/Rome')::date::text
                )) FROM refunds WHERE refunds.order_id = orders.id
              ), '[]'::jsonb) AS refunds
       FROM orders WHERE orders.id = $1 FOR UPDATE`,
        [id],
      );
      const current = order.rows[0];
      if (!current) {
        await archivedInvoice?.cleanupIfUnreferenced();
        return null;
      }
      const attachingInvoice =
        current.historical_reconciliation_outcome === "ALREADY_INVOICED" &&
        parsed.data.outcome === "ALREADY_INVOICED" &&
        !current.historical_invoice_id;
      if (!current.historical || (!attachingInvoice && current.historical_reconciled_at)) {
        throw new AppError("CONFLICT_REVISION", 409);
      }
      if (!attachingInvoice && current.trigger_status !== "LEGACY_BILLING_REVIEW") {
        throw new AppError("CONFLICT_REVISION", 409);
      }
      const trigger = await client.query<{ value_json: unknown }>(
        "SELECT value_json FROM settings WHERE key = 'draft_trigger' FOR SHARE",
      );
      const refundEffect = preIssueRefund(
        current.gross_amount,
        current.refunds,
        current.billable_amount,
      );
      const hasExplicitHistoricalOrderReference = importedInvoice
        ? hasOrderReference(importedInvoice.references, current.provider, current.display_number) ||
          hasBareOrderReference(importedInvoice.references, current.display_number)
        : false;
      const usesUnreferencedMarketplaceFallback = Boolean(
        importedInvoice &&
        !hasExplicitHistoricalOrderReference &&
        !hasConflictingMarketplaceReference(importedInvoice.references, current.provider),
      );
      const historicalInvoiceAmount = importedInvoice
        ? hasExplicitHistoricalOrderReference
          ? attributedInvoiceAmount(importedInvoice, current.provider, current.display_number)
          : usesUnreferencedMarketplaceFallback
            ? importedInvoice.totalAmount
            : null
        : null;
      const historicalInvoiceDate = importedInvoice?.documentDate;
      const completedHistoricalRefunds = current.refunds.filter(
        (refund) => refund.status === "COMPLETED",
      );
      const preIssueHistoricalRefunds = completedHistoricalRefunds.filter(
        (refund) => refund.completed_date! < historicalInvoiceDate!,
      );
      const historicalRefundsNeedReview = current.refunds.some(
        (refund) =>
          refund.status === "AMBIGUOUS" ||
          (refund.status === "COMPLETED" &&
            (refund.amount === null ||
              !refund.completed_date ||
              refund.completed_date === historicalInvoiceDate)),
      );
      const expectedHistoricalInvoiceTotal =
        current.billable_amount -
        preIssueHistoricalRefunds.reduce((sum, refund) => sum + refund.amount!, 0);
      if (
        parsed.data.outcome === "ALREADY_INVOICED" &&
        (historicalRefundsNeedReview ||
          expectedHistoricalInvoiceTotal < 0 ||
          historicalInvoiceAmount !== expectedHistoricalInvoiceTotal)
      ) {
        throw new AppError("ORDER_HISTORY_INVOICE_INVALID", 422);
      }
      const nextStatus =
        parsed.data.outcome === "ALREADY_INVOICED"
          ? "INVOICED"
          : refundEffect.state === "TOTAL"
            ? "REFUNDED_BEFORE_ISSUE"
            : triggerStatus(
                {
                  cancelledAt: current.cancelled_at,
                  paymentStatus: current.payment_status,
                  fulfillmentStatus: current.fulfillment_status,
                  historical: false,
                },
                draftTriggerSchema.parse(trigger.rows[0]?.value_json ?? "PAID"),
              );
      let invoiceDocumentId: string | null = null;
      if (parsed.data.outcome === "ALREADY_INVOICED") {
        await client.query("SELECT pg_advisory_xact_lock(hashtext('fiscal-profile'))");
        const activeProfile = await client.query<{ version: number; profile_json: unknown }>(
          "SELECT version, profile_json FROM fiscal_profiles WHERE status IN ('MOCK', 'AUDITED')",
        );
        const profile = fiscalProfileSchema.safeParse(activeProfile.rows[0]?.profile_json);
        const unreferencedMarketplaceMatch =
          importedInvoice && usesUnreferencedMarketplaceFallback
            ? await uniquelyMatchesUnreferencedMarketplaceInvoice(
                client,
                current.id,
                importedInvoice,
                importedTaxIdentifiers,
              )
            : false;
        if (
          !profile.success ||
          !importedInvoice ||
          !archivedInvoice ||
          !invoicePath ||
          !historicalDocumentDateAllowed(current.local_order_date, importedInvoice.documentDate) ||
          (!hasExplicitHistoricalOrderReference && !unreferencedMarketplaceMatch) ||
          !matchesHistoricalRecipient(current, importedInvoice, importedTaxIdentifiers) ||
          JSON.stringify(fiscalContract(profile.data)) !==
            JSON.stringify(fiscalContract(importedInvoice.profile))
        ) {
          throw new AppError("ORDER_HISTORY_INVOICE_INVALID", 422);
        }
        const existing = await client.query<{
          id: string;
          origin: string;
          xml_sha256: string;
        }>(
          `SELECT id, origin, xml_sha256 FROM documents
         WHERE series = 'FPR' AND fiscal_year = $1 AND fiscal_number = $2
         FOR UPDATE`,
          [importedInvoice.year, importedInvoice.number],
        );
        const previous = existing.rows[0];
        if (
          previous &&
          (previous.origin !== "ARUBA_HISTORY" || previous.xml_sha256 !== archivedInvoice.sha256)
        ) {
          throw new AppError("ORDER_HISTORY_INVOICE_INVALID", 422);
        }
        if (previous && usesUnreferencedMarketplaceFallback) {
          const linkedOrders = await client.query(
            `SELECT order_id FROM document_orders
             WHERE document_id = $1 AND document_kind = 'INVOICE'
             FOR UPDATE`,
            [previous.id],
          );
          if (linkedOrders.rowCount) {
            throw new AppError("ORDER_HISTORY_INVOICE_INVALID", 422);
          }
        }
        invoiceDocumentId = previous?.id ?? null;
        if (!invoiceDocumentId) {
          const billingCase = await client.query<{ id: string }>(
            `INSERT INTO billing_cases
            (customer_id, local_order_date, currency, status, customer_snapshot_json,
             fiscal_profile_version)
           VALUES ($1, $2, 'EUR', 'CLOSED', $3, $4) RETURNING id`,
            [
              current.customer_id,
              importedInvoice.documentDate,
              JSON.stringify(current.customer_snapshot),
              activeProfile.rows[0]!.version,
            ],
          );
          const storage = await client.query<{ id: string }>(
            `INSERT INTO storage_objects
            (kind, relative_path, sha256, size_bytes, content_type)
           VALUES ('INVOICE_XML', $1, $2, $3, 'application/xml')
           ON CONFLICT (relative_path) DO UPDATE SET relative_path = EXCLUDED.relative_path
           RETURNING id`,
            [invoicePath, archivedInvoice.sha256, archivedInvoice.sizeBytes],
          );
          const snapshot = {
            generatorVersion: 2,
            ...importedInvoice.input,
            sourceTotal: importedInvoice.totalAmount,
            total: importedInvoice.totalAmount,
            difference: 0,
            differenceReason: null,
          };
          const document = await client.query<{ id: string }>(
            `INSERT INTO documents
            (billing_case_id, kind, status, document_type, series, fiscal_year,
             fiscal_number, document_date, fiscal_profile_version, currency, total_amount,
             source_total_amount, difference_amount, projection_sha256, approved_at,
             xml_sha256, immutable_snapshot_json, fiscal_profile_snapshot_json,
             storage_object_id, payment_status, payment_method, recipient_snapshot_json, origin)
           VALUES ($1, 'INVOICE', 'APPROVED', 'TD01', 'FPR', $2, $3, $4, $5, 'EUR',
             $6, $6, 0, $7, now(), $7, $8, $9, $10, 'PAID', $11, $12, 'ARUBA_HISTORY')
           RETURNING id`,
            [
              billingCase.rows[0]!.id,
              importedInvoice.year,
              importedInvoice.number,
              importedInvoice.documentDate,
              activeProfile.rows[0]!.version,
              importedInvoice.totalAmount,
              archivedInvoice.sha256,
              JSON.stringify(snapshot),
              JSON.stringify(importedInvoice.profile),
              storage.rows[0]!.id,
              importedInvoice.input.paymentMethod,
              JSON.stringify(importedInvoice.input.recipient),
            ],
          );
          invoiceDocumentId = document.rows[0]!.id;
        }
        await client.query(
          `INSERT INTO document_orders (document_id, document_kind, order_id, amount)
         VALUES ($1, 'INVOICE', $2, $3)`,
          [invoiceDocumentId, id, historicalInvoiceAmount],
        );
      }
      await client.query(
        `UPDATE orders SET trigger_status = $2, historical_reconciliation_outcome = $3,
         historical_reconciliation_reference = $4,
         historical_reconciled_at = coalesce(historical_reconciled_at, now())
       WHERE id = $1`,
        [id, nextStatus, parsed.data.outcome, parsed.data.reference],
      );
      if (parsed.data.outcome === "ALREADY_INVOICED") {
        await client.query(
          `UPDATE refunds
           SET applied_before_issue = (id::text = ANY($2::text[])), updated_at = now()
           WHERE order_id = $1 AND status = 'COMPLETED'`,
          [id, preIssueHistoricalRefunds.map((refund) => refund.id)],
        );
        await client.query(
          `INSERT INTO jobs (type, payload_json)
         SELECT 'process_refund', jsonb_build_object('refundId', refunds.id::text)
         FROM refunds WHERE refunds.order_id = $1
           AND refunds.status IN ('COMPLETED', 'AMBIGUOUS')
           AND NOT refunds.applied_before_issue AND refunds.credit_document_id IS NULL
         ON CONFLICT DO NOTHING`,
          [id],
        );
      }
      await writeAudit(client, {
        actorType: actor.type ?? "ADMIN",
        actorId: String(actor.id),
        action: "ORDER_HISTORY_RECONCILED",
        eventClass: "CRITICAL",
        entityType: "ORDER",
        entityId: id,
        after: {
          outcome: parsed.data.outcome,
          reference: parsed.data.reference,
          invoiceDocumentId,
        },
        requestId: actor.requestId,
      });
      const caseId =
        nextStatus === "ELIGIBLE" || nextStatus === "REFUNDED_BEFORE_ISSUE"
          ? await groupOrder(
              client,
              {
                id: current.id,
                customerId: current.customer_id,
                customerSnapshot: current.customer_snapshot,
                localOrderDate: current.local_order_date,
                currency: current.currency,
                isolated: nextStatus === "REFUNDED_BEFORE_ISSUE",
              },
              actor,
            )
          : null;
      if (caseId && nextStatus === "REFUNDED_BEFORE_ISSUE") {
        await client.query("UPDATE orders SET trigger_status = $2 WHERE id = $1", [id, nextStatus]);
      }
      if (caseId && nextStatus === "ELIGIBLE" && refundEffect.state === "PARTIAL") {
        await reconcilePreIssueInvoiceAmount(client, id, caseId, refundEffect.billableAmount);
      }
      return { caseId, outcome: parsed.data.outcome, invoiceDocumentId };
    } catch (error) {
      await archivedInvoice?.cleanupIfUnreferenced();
      throw error;
    }
  });
}

export async function forcePrepareOrder(id: string, actor: Actor) {
  if (!isDatabaseId(id)) return null;
  return withTransaction(async (client) => {
    await serializeOrderMutations(client);
    const identity = await client.query<{
      provider: string;
      external_account_id: string;
      external_order_id: string;
    }>("SELECT provider, external_account_id, external_order_id FROM orders WHERE id = $1", [id]);
    if (!identity.rows[0]) return null;
    const source = identity.rows[0];
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `order:${source.provider}:${source.external_account_id}:${source.external_order_id}`,
    ]);
    const order = await client.query<{
      id: string;
      customer_id: string;
      billing_case_id: string | null;
      customer_snapshot: Record<string, unknown>;
      local_order_date: string;
      currency: string;
      cancelled_at: string | null;
      payment_status: OrderInput["paymentStatus"];
      historical: boolean;
      historical_reconciliation_outcome: "ALREADY_INVOICED" | "NOT_INVOICED" | null;
    }>(
      `SELECT orders.id, orders.customer_id, orders.billing_case_id,
              orders.normalized_snapshot_json -> 'customerSnapshot' AS customer_snapshot,
              orders.local_order_date::text,
              orders.currency, orders.cancelled_at, orders.payment_status,
              orders.historical_reconciliation_outcome,
              coalesce((orders.normalized_snapshot_json ->> 'historical')::boolean, false)
                AS historical
       FROM orders
       WHERE orders.id = $1
       FOR UPDATE OF orders`,
      [id],
    );
    const current = order.rows[0];
    if (!current) return null;
    if (current.billing_case_id) return current.billing_case_id;
    if (
      (current.historical && current.historical_reconciliation_outcome !== "NOT_INVOICED") ||
      current.cancelled_at ||
      current.payment_status === "REFUNDED"
    ) {
      throw new AppError("ORDER_NOT_PREPARABLE", 409);
    }
    return groupOrder(
      client,
      {
        id: current.id,
        customerId: current.customer_id,
        customerSnapshot: current.customer_snapshot,
        localOrderDate: current.local_order_date,
        currency: current.currency,
      },
      actor,
      true,
    );
  });
}
