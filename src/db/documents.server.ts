import { createHash } from "node:crypto";
import path from "node:path";

import type pg from "pg";

import { arubaModeSchema } from "../aruba.ts";
import {
  documentInputSchema,
  fatturaPaAddress,
  fatturaPaText,
  fiscalProfileSchema,
  foreignCustomerFallbackTaxCode,
  generateFatturaXml,
  projectFatturaXml,
  recipientFromCustomerSnapshot,
  type DocumentInput,
  type FiscalProfile,
} from "../documents.ts";
import { AppError } from "../errors.ts";
import { validateFatturaXml } from "../fatturapa.server.ts";
import { fiscalNumberLabel } from "../fiscal-number.ts";
import { getConfig } from "../config.server.ts";
import { escapeLike, PAGE_SIZE, pageOffset, paginate } from "../orders.ts";
import { isDatabaseId } from "./database-id.ts";
import { writeAudit } from "./audit.server.ts";
import { getArubaInventoryHealth, getLockedArubaInventoryHealth } from "./aruba-inbound.server.ts";
import { createArubaApiBatch } from "./aruba-api-outbound.server.ts";
import { getArubaSettings } from "./aruba.server.ts";
import {
  customerEmailChoiceSchema,
  customerEmailPreview,
  getCustomerEmailSettings,
  snapshotDocumentEmail,
} from "./email.server.ts";
import { getPool, withTransaction } from "./client.server.ts";
import {
  pendingPaymentSql,
  standardInvoiceApprovalCriteriaSql,
} from "./billing-case-sql.server.ts";
import {
  ensureDocumentStoragePath,
  loadStoredDocuments,
  materializeStoredXml,
  readDocumentXml,
  type StoredDocumentRow,
} from "./document-storage.server.ts";
import { serializeOrderMutations } from "./order-mutation-lock.server.ts";

interface FiscalActor {
  id: number;
  canApprove: boolean;
  requestId: string;
}

interface CaseOrder {
  id: string;
  provider: "SHOPIFY" | "EBAY";
  display_number: string;
  gross_amount: number;
  shopify_payments_fee_amount: number;
  deducted_shopify_payments_fee_amount: number;
  billable_amount: number;
  payment_status: string;
  payment_method: string | null;
  customer_snapshot_json: Record<string, unknown>;
}

interface CaseRow {
  id: string;
  revision: number;
  status: string;
  currency: "EUR";
  customer_snapshot_json: Record<string, unknown>;
  orders: CaseOrder[];
}

interface DraftRow {
  id: string;
  status: "DRAFT" | "APPROVED";
  document_date: string;
  fiscal_profile_version: number;
  source_total_amount: number;
  total_amount: number;
  difference_amount: number;
  difference_reason: string | null;
  payment_status: "PAID" | "PENDING";
  payment_method: "MP01" | "MP05" | "MP08";
  causale: string | null;
  notes: string | null;
  recipient_snapshot_json: DocumentInput["recipient"];
  draft_version: number;
  projection_sha256: string;
  lines: Array<{
    order_id: string;
    description: string;
    quantity: number;
    unit_amount: number;
  }>;
}

const romeDate = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Rome",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
const comparisonMoney = new Intl.NumberFormat("it-IT", {
  style: "currency",
  currency: "EUR",
});

function today(): string {
  return romeDate.format(new Date());
}

function sourceLine(order: CaseOrder) {
  const label = order.provider === "SHOPIFY" ? "Shopify" : "eBay";
  return {
    orderId: order.id,
    description: `Vendita beni usati - Ordine ${label} ${order.display_number}`,
    quantity: 1,
    unitAmount: order.billable_amount,
    grossAmount: order.gross_amount,
    shopifyPaymentsFeeAmount: order.deducted_shopify_payments_fee_amount,
  };
}

function casePaymentStatus(caseRow: CaseRow): "PAID" | "PENDING" {
  return caseRow.orders.some((order) => order.payment_status === "PENDING") ? "PENDING" : "PAID";
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

async function loadCase(client: pg.Pool | pg.PoolClient, id: string, lock = false) {
  // Il frammento interpolato è una costante interna che riceve soltanto l'alias SQL fisso.
  // react-doctor-disable-next-line react-doctor/raw-sql-injection-risk
  const result = await client.query<CaseRow>(
    `SELECT billing_cases.id, billing_cases.revision, billing_cases.status,
            billing_cases.currency, billing_cases.customer_snapshot_json,
            coalesce(case_orders.orders, '[]') AS orders
     FROM billing_cases
     LEFT JOIN LATERAL (
       SELECT jsonb_agg(jsonb_build_object(
         'id', orders.id::text,
         'provider', orders.provider,
         'display_number', orders.display_number,
         'gross_amount', orders.gross_amount,
         'shopify_payments_fee_amount', orders.shopify_payments_fee_amount,
         'deducted_shopify_payments_fee_amount', orders.deducted_shopify_payments_fee_amount,
         'billable_amount', orders.billable_amount - CASE
           WHEN billing_cases.status IN ('DRAFT', 'READY', 'NEEDS_REVIEW') THEN coalesce((
             SELECT sum(refunds.amount) FROM refunds
             WHERE refunds.order_id = orders.id AND refunds.applied_before_issue
           ), 0)
           ELSE 0
         END,
         'payment_status', CASE
           WHEN ${pendingPaymentSql("orders")} THEN 'PENDING'
           WHEN orders.payment_status = 'REFUNDED' THEN 'REFUNDED'
           ELSE 'PAID'
         END,
         'payment_method', (
           SELECT payments.method FROM payments
           WHERE payments.order_id = orders.id
           ORDER BY payments.paid_at DESC NULLS LAST, payments.id DESC LIMIT 1
         ),
         'customer_snapshot_json', orders.normalized_snapshot_json -> 'customer'
       ) ORDER BY orders.id) AS orders
       FROM orders WHERE orders.billing_case_id = billing_cases.id
     ) AS case_orders ON true
     WHERE billing_cases.id = $1
     ${lock ? "FOR UPDATE OF billing_cases" : ""}`,
    [id],
  );
  return result.rows[0] ?? null;
}

async function loadDraft(client: pg.Pool | pg.PoolClient, caseId: string, lock = false) {
  const result = await client.query<DraftRow>(
    `SELECT documents.*, documents.document_date::text,
            coalesce((
              SELECT jsonb_agg(jsonb_build_object(
                'order_id', document_lines.order_id::text,
                'description', document_lines.description,
                'quantity', document_lines.quantity,
                'unit_amount', document_lines.unit_amount
              ) ORDER BY document_lines.line_number)
              FROM document_lines WHERE document_lines.document_id = documents.id
            ), '[]') AS lines
     FROM documents
     WHERE billing_case_id = $1 AND kind = 'INVOICE'
     ${lock ? "FOR UPDATE" : ""}`,
    [caseId],
  );
  return result.rows[0] ?? null;
}

async function loadProfile(client: pg.Pool | pg.PoolClient, version?: number) {
  const result = await client.query<{
    version: number;
    status: "MOCK" | "AUDITED" | "RETIRED";
    profile_json: FiscalProfile;
  }>(
    version
      ? "SELECT version, status, profile_json FROM fiscal_profiles WHERE version = $1"
      : `SELECT version, status, profile_json FROM fiscal_profiles
         WHERE status IN ('MOCK', 'AUDITED') LIMIT 1`,
    version ? [version] : [],
  );
  const row = result.rows[0];
  if (!row) return null;
  const parsed = fiscalProfileSchema.safeParse(row.profile_json);
  if (!parsed.success) throw new AppError("DOCUMENT_FISCAL_PROFILE_MISSING", 409);
  return { ...row, profile_json: parsed.data };
}

export async function getFiscalProfileSettings() {
  const result = await getPool().query<{
    version: number;
    status: "MOCK" | "AUDITED";
    profile_json: FiscalProfile;
    audited_at: Date | null;
  }>(
    `SELECT version, status, profile_json, audited_at FROM fiscal_profiles
     WHERE status IN ('MOCK', 'AUDITED') LIMIT 1`,
  );
  const row = result.rows[0];
  if (!row) return null;
  const profile = fiscalProfileSchema.safeParse(row.profile_json);
  if (!profile.success) throw new AppError("DOCUMENT_FISCAL_PROFILE_MISSING", 409);
  return {
    version: row.version,
    status: row.status,
    auditedAt: row.audited_at?.toISOString() ?? null,
    businessName: profile.data.seller.businessName,
    taxRegime: profile.data.seller.taxRegime,
    taxNature: profile.data.taxNature,
    legalReference: profile.data.legalReference,
    series: profile.data.series,
    cadence: profile.data.numbering.cadence,
    sharedByInvoiceAndCreditNote: profile.data.numbering.sharedByInvoiceAndCreditNote,
  };
}

function documentInput(
  caseRow: CaseRow,
  draft: DraftRow | null,
  profile: FiscalProfile,
): DocumentInput {
  const sourcePaymentStatus = casePaymentStatus(caseRow);
  const parsed = documentInputSchema.safeParse({
    kind: "INVOICE",
    documentDate: draft?.status === "APPROVED" ? draft.document_date : today(),
    recipient: recipientFromCustomerSnapshot(caseRow.customer_snapshot_json),
    lines:
      draft?.lines.map((line) => ({
        orderId: line.order_id,
        description: line.description,
        quantity: line.quantity,
        unitAmount: line.unit_amount,
      })) ?? caseRow.orders.map(sourceLine),
    paymentStatus: draft?.payment_status ?? sourcePaymentStatus,
    paymentMethod: draft?.payment_method ?? profile.payment.invoiceMethod,
    causale: draft?.causale ?? undefined,
    notes: draft?.notes ?? undefined,
  });
  if (!parsed.success) throw new AppError("DOCUMENT_INVALID", 422);
  return parsed.data;
}

function joined(values: Array<string | undefined>): string {
  return values.filter(Boolean).join(" · ") || "—";
}

function recipientIdentity(value: DocumentInput["recipient"]): string {
  return (
    value.businessName ??
    ([value.firstName, value.lastName].filter(Boolean).join(" ") || value.displayName || "—")
  );
}

function projectedRecipientIdentity(value: DocumentInput["recipient"]): string {
  if (value.businessName || value.displayName) {
    return fatturaPaText(value.businessName ?? value.displayName!, 80);
  }
  return joined([
    value.firstName ? fatturaPaText(value.firstName, 60) : undefined,
    value.lastName ? fatturaPaText(value.lastName, 60) : undefined,
  ]);
}

function recipientAddress(value: DocumentInput["recipient"], projected = false): string {
  const street = projected
    ? fatturaPaAddress(value.address.line1, value.address.line2)
    : joined([value.address.line1, value.address.line2]);
  return joined([
    street,
    joined([
      projected && value.address.countryCode !== "IT" ? "00000" : value.address.postalCode,
      projected ? fatturaPaText(value.address.city, 60) : value.address.city,
    ]),
    value.address.countryCode === "IT"
      ? projected
        ? value.address.province?.toUpperCase()
        : value.address.province
      : undefined,
    value.address.countryCode,
  ]);
}

function recipientTaxes(value: DocumentInput["recipient"]): string {
  return joined(
    value.taxIdentifiers.map((identifier) =>
      joined([identifier.type, identifier.countryCode, identifier.value]),
    ),
  );
}

function projectedRecipientTaxes(value: DocumentInput["recipient"]): string {
  const vat =
    value.taxIdentifiers.find((identifier) => identifier.type === "PARTITA_IVA") ??
    (value.kind === "EU"
      ? {
          countryCode: value.address.countryCode,
          type: "PARTITA_IVA" as const,
          value: foreignCustomerFallbackTaxCode,
        }
      : undefined);
  const fiscalCode = value.taxIdentifiers.find(
    (identifier) => identifier.type === "CODICE_FISCALE",
  );
  return joined([
    vat
      ? joined(["PARTITA_IVA", vat.countryCode ?? value.address.countryCode, vat.value])
      : undefined,
    fiscalCode ? joined(["CODICE_FISCALE", fiscalCode.value]) : undefined,
  ]);
}

export function recipientComparison(value: DocumentInput["recipient"]) {
  const destinationCode = value.kind === "EU" ? "XXXXXXX" : (value.recipientCode ?? "0000000");
  return [
    {
      field: "identity" as const,
      source: recipientIdentity(value),
      draft: recipientIdentity(value),
      projected: projectedRecipientIdentity(value),
    },
    {
      field: "taxes" as const,
      source: recipientTaxes(value),
      draft: recipientTaxes(value),
      projected: projectedRecipientTaxes(value),
    },
    {
      field: "address" as const,
      source: recipientAddress(value),
      draft: recipientAddress(value),
      projected: recipientAddress(value, true),
    },
    {
      field: "delivery" as const,
      source: joined([value.recipientCode, value.certifiedEmail]),
      draft: joined([value.recipientCode, value.certifiedEmail]),
      projected: joined([
        `SdI ${destinationCode}`,
        destinationCode === "0000000" ? value.certifiedEmail : undefined,
      ]),
    },
  ];
}

function paymentStatus(value: string): string {
  return (
    {
      PAID: "Pagato",
      PENDING: "In attesa",
      REFUNDED: "Rimborsato",
    }[value] ?? "Da verificare"
  );
}

function sourceRecipients(
  orders: CaseOrder[],
  pick: (value: DocumentInput["recipient"]) => string,
) {
  return joined([
    ...new Set(
      orders.map((order) =>
        pick(recipientFromCustomerSnapshot(order.customer_snapshot_json, false)),
      ),
    ),
  ]);
}

function money(cents: number): string {
  return comparisonMoney.format(cents / 100);
}

function invoiceComparison(caseRow: CaseRow, input: DocumentInput, profile: FiscalProfile) {
  const destinationCode =
    input.recipient.kind === "EU" ? "XXXXXXX" : (input.recipient.recipientCode ?? "0000000");
  const sourceById = new Map(caseRow.orders.map((order) => [order.id, sourceLine(order)]));
  return {
    recipient: [
      {
        field: "identity" as const,
        source: sourceRecipients(caseRow.orders, recipientIdentity),
        draft: recipientIdentity(input.recipient),
        projected: projectedRecipientIdentity(input.recipient),
      },
      {
        field: "taxes" as const,
        source: sourceRecipients(caseRow.orders, recipientTaxes),
        draft: recipientTaxes(input.recipient),
        projected: projectedRecipientTaxes(input.recipient),
      },
      {
        field: "address" as const,
        source: sourceRecipients(caseRow.orders, recipientAddress),
        draft: recipientAddress(input.recipient),
        projected: recipientAddress(input.recipient, true),
      },
      {
        field: "delivery" as const,
        source: sourceRecipients(caseRow.orders, (value) =>
          joined([value.recipientCode, value.certifiedEmail]),
        ),
        draft: joined([input.recipient.recipientCode, input.recipient.certifiedEmail]),
        projected: joined([
          `SdI ${destinationCode}`,
          destinationCode === "0000000" ? input.recipient.certifiedEmail : undefined,
        ]),
      },
    ],
    lines: input.lines.map((line, index) => {
      const source = sourceById.get(line.orderId ?? "");
      return {
        field: String(index + 1),
        source: source
          ? joined([
              source.description,
              `Totale ordine ${money(source.grossAmount)}`,
              source.shopifyPaymentsFeeAmount
                ? `Commissione Shopify Payments −${money(source.shopifyPaymentsFeeAmount)}`
                : undefined,
              `Fatturabile ${money(source.unitAmount)}`,
            ])
          : "—",
        draft: joined([
          line.description,
          `${line.quantity} × ${money(line.unitAmount)}`,
          money(line.quantity * line.unitAmount),
        ]),
        projected: joined([
          fatturaPaText(line.description, 1000),
          `${line.quantity} × ${money(line.unitAmount)}`,
          money(line.quantity * line.unitAmount),
          profile.taxNature,
        ]),
      };
    }),
    payment: [
      {
        field: "status" as const,
        source: joined(
          caseRow.orders.map(
            (order) =>
              `${order.provider === "SHOPIFY" ? "Shopify" : "eBay"} ${order.display_number}: ${paymentStatus(order.payment_status)} · ${order.payment_method ?? "modalità non disponibile"}`,
          ),
        ),
        draft: `${paymentStatus(input.paymentStatus)} · ${input.paymentMethod}`,
        projected: `${profile.payment.condition} · ${input.paymentMethod}`,
      },
    ],
    notes: [
      {
        field: "causale" as const,
        source: "—",
        draft: input.causale ?? "—",
        projected: input.causale ? fatturaPaText(input.causale, 200) : "—",
      },
      {
        field: "notes" as const,
        source: "—",
        draft: input.notes ?? "—",
        projected: input.notes ? fatturaPaText(input.notes, 200) : "—",
      },
    ],
    technical: [
      {
        field: "document" as const,
        source: joined(
          caseRow.orders.map(
            (order) =>
              `${order.provider === "SHOPIFY" ? "Shopify" : "eBay"} ${order.display_number}`,
          ),
        ),
        draft: joined([input.documentDate, profile.series]),
        projected: `TD01 · FPR12 · ${profile.series}`,
      },
      {
        field: "tax" as const,
        source: "—",
        draft: `${profile.seller.taxRegime} · ${profile.taxNature}`,
        projected: `${profile.seller.taxRegime} · ${profile.taxNature} · ${profile.legalReference}`,
      },
    ],
  };
}

export async function getInvoiceProjection(caseId: string) {
  if (!isDatabaseId(caseId)) return null;
  const caseRow = await loadCase(getPool(), caseId);
  if (!caseRow) return null;
  const draft = await loadDraft(getPool(), caseId);
  const profile = await loadProfile(getPool(), draft?.fiscal_profile_version);
  if (!profile) {
    return { caseRevision: caseRow.revision, profileMissing: true as const };
  }
  const input = documentInput(caseRow, draft, profile.profile_json);
  const projected = projectFatturaXml(profile.profile_json, input);
  const approvedXml = draft?.status === "APPROVED" ? await readDocumentXml(draft.id) : null;
  const projection = approvedXml
    ? {
        xml: approvedXml.toString("utf8"),
        sha256: createHash("sha256").update(approvedXml).digest("hex"),
      }
    : projected;
  await validateFatturaXml(projection.xml);
  const grossTotal = caseRow.orders.reduce((sum, order) => sum + order.gross_amount, 0);
  const shopifyPaymentsFeeTotal = caseRow.orders.reduce(
    (sum, order) => sum + order.deducted_shopify_payments_fee_amount,
    0,
  );
  const sourceTotal = caseRow.orders.reduce((sum, order) => sum + order.billable_amount, 0);
  const total = input.lines.reduce((sum, line) => sum + line.quantity * line.unitAmount, 0);
  const arubaSettings = await getArubaSettings();
  return {
    caseRevision: caseRow.revision,
    profileMissing: false as const,
    profileVersion: profile.version,
    profileStatus: profile.status,
    draftVersion: draft?.draft_version ?? 0,
    documentDate: input.documentDate,
    lines: input.lines,
    sourceLines: caseRow.orders.map(sourceLine),
    grossTotal,
    shopifyPaymentsFeeTotal,
    sourceTotal,
    total,
    difference: total - sourceTotal,
    differenceReason: draft?.difference_reason ?? "",
    paymentStatus: input.paymentStatus,
    paymentMethod: input.paymentMethod,
    causale: input.causale ?? "",
    notes: input.notes ?? "",
    paymentPending: input.paymentStatus === "PENDING",
    requiresResave: Boolean(
      draft &&
      draft.status === "DRAFT" &&
      (draft.document_date !== input.documentDate || draft.projection_sha256 !== projected.sha256),
    ),
    projectionSha256: projection.sha256,
    xml: projection.xml,
    comparison: invoiceComparison(caseRow, input, profile.profile_json),
    approved: draft?.status === "APPROVED",
    arubaMode: arubaSettings.effectiveMode,
    arubaConfiguredMode: arubaSettings.mode.value,
    arubaDowngradeRequired: arubaSettings.mode.value !== arubaSettings.effectiveMode,
    arubaInventory: await getArubaInventoryHealth(),
    customerEmail: await customerEmailPreview(caseId),
  };
}

function documentAuditSnapshot(input: DocumentInput): Record<string, unknown> {
  return {
    recipient: input.recipient,
    lines: input.lines,
    paymentStatus: input.paymentStatus,
    paymentMethod: input.paymentMethod,
    causale: input.causale ?? null,
    notes: input.notes ?? null,
  };
}

function draftAuditSnapshot(draft: DraftRow): Record<string, unknown> {
  return {
    recipient: draft.recipient_snapshot_json,
    lines: draft.lines.map((line) => ({
      orderId: line.order_id,
      description: line.description,
      quantity: line.quantity,
      unitAmount: line.unit_amount,
    })),
    paymentStatus: draft.payment_status,
    paymentMethod: draft.payment_method,
    causale: draft.causale,
    notes: draft.notes,
  };
}

function sourceAuditSnapshot(caseRow: CaseRow, profile: FiscalProfile): Record<string, unknown> {
  return {
    recipients: caseRow.orders.map((order) => ({
      orderId: order.id,
      recipient: recipientFromCustomerSnapshot(order.customer_snapshot_json, false),
    })),
    lines: caseRow.orders.map(sourceLine),
    paymentStatus: casePaymentStatus(caseRow),
    paymentMethod: profile.payment.invoiceMethod,
    causale: null,
    notes: null,
  };
}

export async function saveInvoiceDraft(
  caseId: string,
  raw: {
    caseRevision: unknown;
    draftVersion: unknown;
    lines: unknown;
    differenceReason: unknown;
    paymentStatus: unknown;
    paymentMethod: unknown;
    causale: unknown;
    notes: unknown;
  },
  actor: FiscalActor,
) {
  if (!isDatabaseId(caseId)) return null;
  const caseRevision = integer(raw.caseRevision);
  const draftVersion = integer(raw.draftVersion);
  const differenceReason = stringValue(raw.differenceReason);
  const causale = stringValue(raw.causale);
  const notes = stringValue(raw.notes);
  return withTransaction(async (client) => {
    const caseRow = await loadCase(client, caseId, true);
    if (!caseRow) return null;
    if (caseRow.revision !== caseRevision) throw new AppError("CONFLICT_REVISION", 409);
    if (!["DRAFT", "READY", "NEEDS_REVIEW"].includes(caseRow.status)) {
      throw new AppError("BILLING_CASE_NOT_EDITABLE", 409);
    }
    const current = await loadDraft(client, caseId, true);
    if (current?.status === "APPROVED") throw new AppError("BILLING_CASE_NOT_EDITABLE", 409);
    if ((current?.draft_version ?? 0) !== draftVersion) {
      throw new AppError("CONFLICT_REVISION", 409);
    }
    const profile = await loadProfile(client);
    if (!profile) throw new AppError("DOCUMENT_FISCAL_PROFILE_MISSING", 409);
    const documentDate = today();
    const parsed = documentInputSchema.safeParse({
      kind: "INVOICE",
      documentDate,
      recipient: recipientFromCustomerSnapshot(caseRow.customer_snapshot_json),
      lines: raw.lines,
      paymentStatus: raw.paymentStatus,
      paymentMethod: raw.paymentMethod,
      causale,
      notes,
    });
    if (!parsed.success || !sameOrders(parsed.data.lines, caseRow.orders)) {
      throw new AppError("DOCUMENT_INVALID", 422);
    }
    const sourceTotal = caseRow.orders.reduce((sum, order) => sum + order.billable_amount, 0);
    const total = parsed.data.lines.reduce((sum, line) => sum + line.quantity * line.unitAmount, 0);
    if (total !== sourceTotal && !differenceReason) throw new AppError("DOCUMENT_INVALID", 422);
    const projection = projectFatturaXml(profile.profile_json, parsed.data);
    await validateFatturaXml(projection.xml);
    const nextVersion = draftVersion + 1;
    const document = await client.query<{ id: string }>(
      current
        ? `UPDATE documents SET document_date = $2, fiscal_profile_version = $3,
             total_amount = $4, source_total_amount = $5, difference_amount = $6,
             difference_reason = $7, draft_version = $8, projection_sha256 = $9,
             payment_status = $10, payment_method = $11, causale = $12, notes = $13,
             recipient_snapshot_json = $14,
             updated_at = now()
           WHERE id = $1 RETURNING id`
        : `INSERT INTO documents
             (billing_case_id, kind, status, document_type, series, document_date,
              fiscal_profile_version, currency, total_amount, source_total_amount,
              difference_amount, difference_reason, draft_version, projection_sha256,
              payment_status, payment_method, causale, notes, recipient_snapshot_json)
           VALUES ($1, 'INVOICE', 'DRAFT', 'TD01', 'FPR', $2, $3, 'EUR', $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
           RETURNING id`,
      [
        current?.id ?? caseId,
        parsed.data.documentDate,
        profile.version,
        total,
        sourceTotal,
        total - sourceTotal,
        differenceReason ?? null,
        nextVersion,
        projection.sha256,
        parsed.data.paymentStatus,
        parsed.data.paymentMethod,
        parsed.data.causale ?? null,
        parsed.data.notes ?? null,
        JSON.stringify(parsed.data.recipient),
      ],
    );
    const documentId = document.rows[0]!.id;
    if (current) {
      await client.query("DELETE FROM document_lines WHERE document_id = $1", [documentId]);
      await client.query("DELETE FROM document_orders WHERE document_id = $1", [documentId]);
    }
    const ordersById = new Map(caseRow.orders.map((order) => [order.id, order]));
    for (const [index, line] of parsed.data.lines.entries()) {
      const order = ordersById.get(line.orderId!)!;
      await client.query(
        `INSERT INTO document_orders (document_id, document_kind, order_id, amount)
         VALUES ($1, 'INVOICE', $2, $3)`,
        [documentId, line.orderId, order.billable_amount],
      );
      await client.query(
        `INSERT INTO document_lines
          (document_id, order_id, line_number, description, quantity, unit_amount,
           total_amount, tax_nature)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'N5')`,
        [
          documentId,
          line.orderId,
          index + 1,
          line.description,
          line.quantity,
          line.unitAmount,
          line.quantity * line.unitAmount,
        ],
      );
    }
    await client.query(
      `UPDATE billing_cases SET revision = revision + 1, fiscal_profile_version = $2,
       updated_at = now() WHERE id = $1`,
      [caseId, profile.version],
    );
    await writeAudit(client, {
      actorType: "ADMIN",
      actorId: String(actor.id),
      action: "DOCUMENT_DRAFT_SAVED",
      eventClass: "CRITICAL",
      entityType: "DOCUMENT",
      entityId: documentId,
      metadata: {
        billingCaseId: caseId,
        documentKind: "INVOICE",
        fiscalProfileVersion: profile.version,
      },
      before: {
        imported: sourceAuditSnapshot(caseRow, profile.profile_json),
        previous: current
          ? draftAuditSnapshot(current)
          : sourceAuditSnapshot(caseRow, profile.profile_json),
      },
      after: { current: documentAuditSnapshot(parsed.data) },
      reason: differenceReason ?? null,
      requestId: actor.requestId,
    });
    return documentId;
  });
}

function sameOrders(lines: DocumentInput["lines"], orders: CaseOrder[]): boolean {
  const ids = lines.map((line) => line.orderId);
  const uniqueIds = new Set(ids);
  return (
    ids.length === orders.length &&
    uniqueIds.size === ids.length &&
    orders.every((order) => uniqueIds.has(order.id))
  );
}

function integer(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 2_147_483_647) {
    throw new AppError("CONFLICT_REVISION", 409);
  }
  return parsed;
}

async function materializeDefaultInvoiceDraft(
  client: pg.PoolClient,
  caseRow: CaseRow,
  profile: Awaited<ReturnType<typeof loadProfile>> & {},
  expectedProjection: string,
  actor: FiscalActor,
): Promise<DraftRow> {
  const input = documentInput(caseRow, null, profile.profile_json);
  const projection = projectFatturaXml(profile.profile_json, input);
  await validateFatturaXml(projection.xml);
  if (projection.sha256 !== expectedProjection) {
    throw new AppError("DOCUMENT_PROJECTION_STALE", 409);
  }
  const sourceTotal = caseRow.orders.reduce((sum, order) => sum + order.billable_amount, 0);
  const total = input.lines.reduce((sum, line) => sum + line.quantity * line.unitAmount, 0);
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO documents
       (billing_case_id, kind, status, document_type, series, document_date,
        fiscal_profile_version, currency, total_amount, source_total_amount,
        difference_amount, difference_reason, draft_version, projection_sha256,
        payment_status, payment_method, causale, notes, recipient_snapshot_json)
     VALUES ($1, 'INVOICE', 'DRAFT', 'TD01', $2, $3, $4, 'EUR', $5, $6, $7,
       NULL, 1, $8, $9, $10, $11, $12, $13)
     RETURNING id`,
    [
      caseRow.id,
      profile.profile_json.series,
      input.documentDate,
      profile.version,
      total,
      sourceTotal,
      total - sourceTotal,
      projection.sha256,
      input.paymentStatus,
      input.paymentMethod,
      input.causale ?? null,
      input.notes ?? null,
      JSON.stringify(input.recipient),
    ],
  );
  const documentId = inserted.rows[0]!.id;
  const ordersById = new Map(caseRow.orders.map((order) => [order.id, order]));
  for (const [index, line] of input.lines.entries()) {
    const order = ordersById.get(line.orderId!);
    if (!order) throw new AppError("DOCUMENT_PROJECTION_STALE", 409);
    await client.query(
      `INSERT INTO document_orders (document_id, document_kind, order_id, amount)
       VALUES ($1, 'INVOICE', $2, $3)`,
      [documentId, line.orderId, order.billable_amount],
    );
    await client.query(
      `INSERT INTO document_lines
        (document_id, order_id, line_number, description, quantity, unit_amount,
         total_amount, tax_nature)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'N5')`,
      [
        documentId,
        line.orderId,
        index + 1,
        line.description,
        line.quantity,
        line.unitAmount,
        line.quantity * line.unitAmount,
      ],
    );
  }
  await writeAudit(client, {
    actorType: "ADMIN",
    actorId: String(actor.id),
    action: "DOCUMENT_DRAFT_SAVED",
    eventClass: "CRITICAL",
    entityType: "DOCUMENT",
    entityId: documentId,
    metadata: {
      billingCaseId: caseRow.id,
      documentKind: "INVOICE",
      fiscalProfileVersion: profile.version,
    },
    before: { imported: sourceAuditSnapshot(caseRow, profile.profile_json) },
    after: { current: documentAuditSnapshot(input) },
    requestId: actor.requestId,
  });
  const draft = await loadDraft(client, caseRow.id, true);
  if (!draft) throw new AppError("DOCUMENT_PROJECTION_STALE", 409);
  return draft;
}

export async function approveInvoice(
  caseId: string,
  raw: {
    caseRevision: unknown;
    draftVersion: unknown;
    projectionSha256: unknown;
    confirmPending: boolean;
    confirmDifference: boolean;
    arubaMode?: unknown;
    confirmArubaDowngrade?: boolean;
    emailChoice: unknown;
    emailModeVersion: unknown;
  },
  actor: FiscalActor,
) {
  if (!actor.canApprove) throw new AppError("DOCUMENT_APPROVAL_FORBIDDEN", 403);
  if (!isDatabaseId(caseId)) return null;
  const caseRevision = integer(raw.caseRevision);
  const draftVersion = integer(raw.draftVersion);
  const expectedProjection = String(raw.projectionSha256 ?? "");
  let committed: {
    id: string;
    fiscalNumber: string;
    batchId: string;
    xml: string;
    storage: StoredDocumentRow;
  } | null;
  try {
    committed = await withTransaction(async (client) => {
      await client.query(
        "SELECT pg_advisory_xact_lock_shared(hashtext('setting:shopify_payment_fee_mode'))",
      );
      const inventory = await getLockedArubaInventoryHealth(client);
      if (inventory.blocking) throw new AppError("ARUBA_INVENTORY_BLOCKED", 409);
      await serializeOrderMutations(client);
      await client.query("SELECT pg_advisory_xact_lock(hashtext('fiscal-profile'))");
      const caseRow = await loadCase(client, caseId, true);
      if (!caseRow) return null;
      if (caseRow.status !== "READY") throw new AppError("DOCUMENT_NOT_APPROVABLE", 409);
      if (caseRow.revision !== caseRevision) throw new AppError("CONFLICT_REVISION", 409);
      let draft = await loadDraft(client, caseId, true);
      if (draft && (draft.status !== "DRAFT" || draft.draft_version !== draftVersion)) {
        throw new AppError("CONFLICT_REVISION", 409);
      }
      if (!draft && draftVersion !== 0) throw new AppError("CONFLICT_REVISION", 409);
      const profile = await loadProfile(client, draft?.fiscal_profile_version);
      if (!profile || profile.status === "RETIRED") {
        throw new AppError("DOCUMENT_FISCAL_PROFILE_MISSING", 409);
      }
      if (getConfig().APP_ENV === "production" && profile.status !== "AUDITED") {
        throw new AppError("DOCUMENT_FISCAL_PROFILE_MISSING", 409);
      }
      draft ??= await materializeDefaultInvoiceDraft(
        client,
        caseRow,
        profile,
        expectedProjection,
        actor,
      );
      const input = documentInput(caseRow, draft, profile.profile_json);
      if (!sameOrders(input.lines, caseRow.orders)) {
        throw new AppError("DOCUMENT_PROJECTION_STALE", 409);
      }
      const projected = projectFatturaXml(profile.profile_json, input);
      await validateFatturaXml(projected.xml);
      if (
        projected.sha256 !== expectedProjection ||
        draft.projection_sha256 !== expectedProjection
      ) {
        throw new AppError("DOCUMENT_PROJECTION_STALE", 409);
      }
      const paymentPending = input.paymentStatus === "PENDING";
      const amountDifferent = draft.difference_amount !== 0;
      if (paymentPending && !raw.confirmPending) {
        throw new AppError("DOCUMENT_NOT_APPROVABLE", 409);
      }
      if (amountDifferent && !raw.confirmDifference) {
        throw new AppError("DOCUMENT_NOT_APPROVABLE", 409);
      }
      const year = Number(input.documentDate.slice(0, 4));
      const series = profile.profile_json.series;
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        `fiscal-number:${series}:${year}`,
      ]);
      const sequence = await client.query<{ next: number }>(
        `SELECT greatest(coalesce(max(fiscal_number), 0), $3::integer) + 1 AS next
         FROM documents WHERE status = 'APPROVED' AND series = $1 AND fiscal_year = $2`,
        [
          series,
          year,
          profile.profile_json.numbering.lastObservedYear === year
            ? profile.profile_json.numbering.lastObservedNumber
            : 0,
        ],
      );
      const fiscalNumber = Number(sequence.rows[0]!.next);
      const xml = generateFatturaXml(profile.profile_json, input, {
        year,
        number: fiscalNumber,
      });
      await validateFatturaXml(xml);
      const sha256 = createHash("sha256").update(xml).digest("hex");
      const relativePath = path.posix.join(
        "invoices",
        String(year),
        `${series}-${String(fiscalNumber).padStart(4, "0")}-${String(year).slice(-2)}.xml`,
      );
      ensureDocumentStoragePath(relativePath);
      const storage = await client.query<{ id: string }>(
        `INSERT INTO storage_objects
          (kind, relative_path, sha256, size_bytes, content_type)
         VALUES ('INVOICE_XML', $1, $2, $3, 'application/xml') RETURNING id`,
        [relativePath, sha256, Buffer.byteLength(xml)],
      );
      const approvedAt = new Date().toISOString();
      const snapshot = {
        generatorVersion: 2,
        kind: input.kind,
        documentDate: input.documentDate,
        recipient: input.recipient,
        lines: input.lines,
        paymentStatus: input.paymentStatus,
        paymentMethod: input.paymentMethod,
        causale: input.causale,
        notes: input.notes,
        sourceTotal: draft.source_total_amount,
        total: draft.total_amount,
        difference: draft.difference_amount,
        differenceReason: draft.difference_reason,
      };
      await snapshotDocumentEmail(client, draft.id, raw.emailChoice, raw.emailModeVersion);
      await client.query(
        `UPDATE documents SET status = 'APPROVED', fiscal_year = $2, fiscal_number = $3,
           document_date = $4, approved_at = $5, pending_payment_confirmed_at = $6,
           amount_difference_confirmed_at = $7, xml_sha256 = $8,
           immutable_snapshot_json = $9, fiscal_profile_snapshot_json = $10,
           storage_object_id = $11, updated_at = now()
         WHERE id = $1`,
        [
          draft.id,
          year,
          fiscalNumber,
          input.documentDate,
          approvedAt,
          paymentPending && raw.confirmPending ? approvedAt : null,
          amountDifferent && raw.confirmDifference ? approvedAt : null,
          sha256,
          JSON.stringify(snapshot),
          JSON.stringify(profile.profile_json),
          storage.rows[0]!.id,
        ],
      );
      await client.query(
        `UPDATE billing_cases SET status = 'APPROVED', revision = revision + 1,
         updated_at = now() WHERE id = $1`,
        [caseId],
      );
      await client.query(
        `UPDATE orders SET trigger_status = 'INVOICED' WHERE billing_case_id = $1`,
        [caseId],
      );
      const label = fiscalNumberLabel(series, year, fiscalNumber);
      const batchId = await createArubaApiBatch(
        client,
        [
          {
            id: draft.id,
            revision: draft.draft_version,
            sha256,
            filename: path.posix.basename(relativePath),
            sizeBytes: Buffer.byteLength(xml),
            fiscalNumber: label,
            documentDate: input.documentDate,
            totalAmount: draft.total_amount,
          },
        ],
        actor,
        raw.arubaMode,
        raw.confirmArubaDowngrade,
      );
      await writeAudit(client, {
        actorType: "ADMIN",
        actorId: String(actor.id),
        action: "DOCUMENT_NUMBERED",
        eventClass: "CRITICAL",
        entityType: "DOCUMENT",
        entityId: draft.id,
        metadata: {
          billingCaseId: caseId,
          documentKind: "INVOICE",
          fiscalNumber: label,
          fiscalProfileVersion: profile.version,
        },
        requestId: actor.requestId,
      });
      if (paymentPending && raw.confirmPending) {
        await writeAudit(client, {
          actorType: "ADMIN",
          actorId: String(actor.id),
          action: "DOCUMENT_PENDING_PAYMENT_CONFIRMED",
          eventClass: "CRITICAL",
          entityType: "DOCUMENT",
          entityId: draft.id,
          metadata: {
            billingCaseId: caseId,
            documentKind: "INVOICE",
            fiscalNumber: label,
          },
          requestId: actor.requestId,
        });
      }
      if (amountDifferent && raw.confirmDifference) {
        await writeAudit(client, {
          actorType: "ADMIN",
          actorId: String(actor.id),
          action: "DOCUMENT_AMOUNT_DIFFERENCE_CONFIRMED",
          eventClass: "CRITICAL",
          entityType: "DOCUMENT",
          entityId: draft.id,
          metadata: {
            billingCaseId: caseId,
            documentKind: "INVOICE",
            fiscalNumber: label,
          },
          reason: draft.difference_reason,
          requestId: actor.requestId,
        });
      }
      await writeAudit(client, {
        actorType: "ADMIN",
        actorId: String(actor.id),
        action: "DOCUMENT_APPROVED",
        eventClass: "CRITICAL",
        entityType: "DOCUMENT",
        entityId: draft.id,
        metadata: {
          billingCaseId: caseId,
          documentKind: "INVOICE",
          fiscalNumber: label,
          fiscalProfileVersion: profile.version,
        },
        requestId: actor.requestId,
      });
      return {
        id: draft.id,
        fiscalNumber: label,
        batchId,
        xml,
        storage: {
          id: draft.id,
          origin: "HUB",
          billing_case_id: caseId,
          series,
          fiscal_year: year,
          fiscal_number: fiscalNumber,
          immutable_snapshot_json: snapshot,
          fiscal_profile_snapshot_json: profile.profile_json,
          relative_path: relativePath,
          sha256,
          size_bytes: Buffer.byteLength(xml),
        },
      };
    });
  } catch (error) {
    if (error instanceof AppError) throw error;
    const recovered = await loadStoredDocuments("AND documents.billing_case_id = $1", caseId).catch(
      () => [],
    );
    if (!recovered[0]) throw error;
    await materializeStoredXml(recovered[0]);
    return {
      id: recovered[0].id,
      fiscalNumber: fiscalNumberLabel(
        recovered[0].series,
        recovered[0].fiscal_year,
        recovered[0].fiscal_number,
      ),
    };
  }
  if (!committed) return null;
  try {
    await materializeStoredXml(committed.storage, committed.xml);
    return {
      id: committed.id,
      fiscalNumber: committed.fiscalNumber,
      batchId: committed.batchId,
      storagePending: false,
    };
  } catch {
    return {
      id: committed.id,
      fiscalNumber: committed.fiscalNumber,
      batchId: committed.batchId,
      storagePending: true,
    };
  }
}

export async function activateFiscalProfile(
  rawProfile: unknown,
  sourceXmlSha256: string,
  actor: FiscalActor,
) {
  if (!actor.canApprove) throw new AppError("DOCUMENT_APPROVAL_FORBIDDEN", 403);
  const profile = fiscalProfileSchema.safeParse(rawProfile);
  if (!profile.success || !/^[0-9a-f]{64}$/.test(sourceXmlSha256)) {
    throw new AppError("DOCUMENT_INVALID", 422);
  }
  return withTransaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('fiscal-profile'))");
    const active = (
      await client.query<{ profile_json: unknown }>(
        "SELECT profile_json FROM fiscal_profiles WHERE status IN ('MOCK', 'AUDITED')",
      )
    ).rows[0];
    const previous = fiscalProfileSchema.safeParse(active?.profile_json);
    if (
      previous.success &&
      previous.data.series === profile.data.series &&
      (previous.data.numbering.lastObservedYear > profile.data.numbering.lastObservedYear ||
        (previous.data.numbering.lastObservedYear === profile.data.numbering.lastObservedYear &&
          previous.data.numbering.lastObservedNumber > profile.data.numbering.lastObservedNumber))
    ) {
      throw new AppError("DOCUMENT_INVALID", 422);
    }
    await client.query(
      "UPDATE fiscal_profiles SET status = 'RETIRED' WHERE status IN ('MOCK', 'AUDITED')",
    );
    const version = Number(
      (
        await client.query<{ version: number }>(
          "SELECT coalesce(max(version), 0) + 1 AS version FROM fiscal_profiles",
        )
      ).rows[0]!.version,
    );
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO fiscal_profiles
        (version, status, profile_json, source_xml_sha256, audited_at)
       VALUES ($1, 'AUDITED', $2, $3, now()) RETURNING id`,
      [version, JSON.stringify(profile.data), sourceXmlSha256],
    );
    await writeAudit(client, {
      actorType: "ADMIN",
      actorId: String(actor.id),
      action: "FISCAL_PROFILE_ACTIVATED",
      eventClass: "CRITICAL",
      entityType: "FISCAL_PROFILE",
      entityId: inserted.rows[0]!.id,
      metadata: {
        fiscalProfileVersion: version,
        lastObservedYear: profile.data.numbering.lastObservedYear,
        lastObservedNumber: profile.data.numbering.lastObservedNumber,
      },
      requestId: actor.requestId,
    });
    return version;
  });
}

export interface DocumentListFilters {
  query?: string;
  kind?: "INVOICE" | "CREDIT_NOTE";
  status?: "DRAFT" | "APPROVED";
  arubaStatus?: string;
  transmission?: "TO_SEND" | "RECONCILIATION_REQUIRED";
  dateFrom?: string;
  dateTo?: string;
  page?: number;
  sort?: { key: DocumentListSortKey; direction: "asc" | "desc" };
}

export type DocumentListSortKey = "documento" | "cliente" | "data" | "totale" | "stato" | "email";

interface DocumentListRow {
  id: string;
  billing_case_id: string;
  public_number: string;
  kind: "INVOICE" | "CREDIT_NOTE";
  origin: "HUB" | "ARUBA_HISTORY";
  status: "DRAFT" | "APPROVED";
  series: string;
  fiscal_year: number | null;
  fiscal_number: number | null;
  document_date: string;
  total_amount: number;
  customer_name: string;
  xml_sha256: string | null;
  aruba_batch_id: string | null;
  aruba_status: string | null;
  historical_order_id: string | null;
}

const documentRowsSql = `
  SELECT documents.id, documents.billing_case_id, billing_cases.public_number,
         documents.kind, documents.origin, documents.status,
         documents.series, documents.fiscal_year, documents.fiscal_number,
         documents.document_date::text, documents.total_amount, documents.xml_sha256,
         billing_cases.customer_snapshot_json ->> 'displayName' AS customer_name,
         aruba_current.id AS aruba_batch_id, aruba_current.status AS aruba_status,
         (SELECT email_deliveries.status
          FROM email_deliveries
          WHERE email_deliveries.document_id = documents.id
          ORDER BY email_deliveries.created_at DESC, email_deliveries.id DESC
          LIMIT 1) AS email_status,
         (SELECT document_orders.order_id::text FROM document_orders
          WHERE document_orders.document_id = documents.id LIMIT 1) AS historical_order_id
  FROM documents
  JOIN billing_cases ON billing_cases.id = documents.billing_case_id
  LEFT JOIN LATERAL (
    SELECT aruba_batches.id, aruba_batches.status
    FROM aruba_batch_documents
    JOIN aruba_batches ON aruba_batches.id = aruba_batch_documents.batch_id
    WHERE aruba_batch_documents.document_id = documents.id
    ORDER BY aruba_batches.created_at DESC LIMIT 1
  ) AS aruba_current ON true`;

const documentListSortSql: Record<DocumentListSortKey, string> = {
  documento: `CASE
       WHEN fiscal_number IS NOT NULL AND fiscal_year IS NOT NULL
         THEN concat_ws(' ', series, lpad(fiscal_number::text, 10, '0'), fiscal_year::text)
       ELSE lpad(public_number, 10, '0')
     END`,
  cliente: "customer_name",
  data: "document_date",
  totale: "total_amount",
  stato: "concat_ws(' ', status, aruba_status)",
  email: "email_status",
};

export async function listDocuments(filters: DocumentListFilters = {}) {
  const query = filters.query?.trim();
  const sort = filters.sort ?? { key: "data", direction: "desc" };
  const orderBy = documentListSortSql[sort.key];
  const direction = sort.direction === "asc" ? "ASC" : "DESC";
  // Colonna e direzione provengono esclusivamente dalle allowlist di modulo;
  // i valori della richiesta restano nei parametri $1-$8.
  // react-doctor-disable-next-line react-doctor/raw-sql-injection-risk
  const result = await getPool().query<
    {
      id: string;
    } & DocumentListRow
  >(
    `WITH document_rows AS (${documentRowsSql})
     SELECT * FROM document_rows
     WHERE ($1::text IS NULL OR customer_name ILIKE $1 ESCAPE '\\'
              OR public_number ILIKE $1 ESCAPE '\\'
              OR fiscal_number::text ILIKE $1 ESCAPE '\\'
              OR concat_ws(' ', series, lpad(fiscal_number::text, 4, '0'),
                   right(fiscal_year::text, 2)) ILIKE $1 ESCAPE '\\')
       AND ($2::text IS NULL OR kind = $2)
       AND ($3::text IS NULL OR status = $3)
       AND ($4::text IS NULL OR aruba_status = $4
            OR ($4 = 'NOT_PREPARED' AND status = 'APPROVED' AND origin = 'HUB'
                AND aruba_status IS NULL))
       AND ($5::text IS NULL OR
            ($5 = 'TO_SEND' AND status = 'APPROVED' AND origin = 'HUB'
             AND (aruba_status IS NULL OR aruba_status IN
                  ('PREPARED', 'HELPER_ACTIVE', 'VALIDATION_FAILED', 'READY_ASSISTED')))
            OR ($5 = 'RECONCILIATION_REQUIRED'
                AND aruba_status = 'RECONCILIATION_REQUIRED'))
       AND ($6::date IS NULL OR document_date::date >= $6)
       AND ($7::date IS NULL OR document_date::date <= $7)
     ORDER BY ${orderBy} ${direction} NULLS LAST, document_date DESC, id DESC
     LIMIT ${PAGE_SIZE + 1} OFFSET $8`,
    [
      query ? `%${escapeLike(query)}%` : null,
      filters.kind ?? null,
      filters.status ?? null,
      filters.arubaStatus ?? null,
      filters.transmission ?? null,
      filters.dateFrom ?? null,
      filters.dateTo ?? null,
      pageOffset(filters.page),
    ],
  );
  const page = paginate(result.rows);
  return {
    ...page,
    rows: page.rows.map((row) => ({
      ...row,
      fiscal_label:
        row.fiscal_year && row.fiscal_number
          ? fiscalNumberLabel(row.series, row.fiscal_year, row.fiscal_number)
          : null,
    })),
  };
}

export async function documentArchiveSummary() {
  const result = await getPool().query<{
    total: number;
    invoices: number;
    credit_notes: number;
    to_send: number;
    reconciliation_required: number;
  }>(
    `WITH document_rows AS (${documentRowsSql})
     SELECT count(*)::integer AS total,
            count(*) FILTER (WHERE kind = 'INVOICE')::integer AS invoices,
            count(*) FILTER (WHERE kind = 'CREDIT_NOTE')::integer AS credit_notes,
            count(*) FILTER (
              WHERE status = 'APPROVED' AND origin = 'HUB'
                AND (aruba_status IS NULL OR aruba_status IN
                     ('PREPARED', 'HELPER_ACTIVE', 'VALIDATION_FAILED', 'READY_ASSISTED'))
            )::integer AS to_send,
            count(*) FILTER (
              WHERE aruba_status = 'RECONCILIATION_REQUIRED'
            )::integer AS reconciliation_required
     FROM document_rows`,
  );
  return result.rows[0]!;
}

export async function listMassApprovalCandidates() {
  const [result, emailSettings] = await Promise.all([
    getPool().query<{
      billing_case_id: string;
      case_revision: number;
      draft_version: number;
      projection_sha256: string;
      public_number: string;
      customer_name: string;
      total_amount: number;
      fiscal_profile_version: number;
    }>(
      `SELECT billing_cases.id AS billing_case_id, billing_cases.revision AS case_revision,
            documents.draft_version, documents.projection_sha256, billing_cases.public_number,
            billing_cases.customer_snapshot_json ->> 'displayName' AS customer_name,
            documents.total_amount, documents.fiscal_profile_version
     FROM documents
     JOIN billing_cases ON billing_cases.id = documents.billing_case_id
     JOIN fiscal_profiles ON fiscal_profiles.version = documents.fiscal_profile_version
     WHERE ${standardInvoiceApprovalCriteriaSql()}
     ORDER BY billing_cases.id
     LIMIT 100`,
    ),
    getCustomerEmailSettings(),
  ]);
  return Promise.all(
    result.rows.map(async (row) => ({
      ...row,
      customerEmail: await customerEmailPreview(row.billing_case_id, emailSettings),
    })),
  );
}

function approvalCandidate(value: string) {
  const match = /^(\d+):(\d+):(\d+):([0-9a-f]{64})$/.exec(value);
  if (!match || !isDatabaseId(match[1]!)) throw new AppError("DOCUMENT_INVALID", 422);
  return {
    caseId: match[1]!,
    caseRevision: integer(match[2]),
    draftVersion: integer(match[3]),
    projectionSha256: match[4]!,
  };
}

export async function approveInvoices(
  rawCandidates: string[],
  actor: FiscalActor,
  confirmApproval = false,
  rawArubaMode?: unknown,
  rawEmailChoices: Record<string, unknown> = {},
  rawEmailModeVersion?: unknown,
  confirmArubaDowngrade = false,
) {
  if (!actor.canApprove) throw new AppError("DOCUMENT_APPROVAL_FORBIDDEN", 403);
  if (!confirmApproval) throw new AppError("DOCUMENT_NOT_APPROVABLE", 409);
  if (!rawCandidates.length || rawCandidates.length > 100) {
    throw new AppError("DOCUMENT_INVALID", 422);
  }
  const arubaMode = arubaModeSchema.safeParse(rawArubaMode);
  if (!arubaMode.success) throw new AppError("DOCUMENT_NOT_APPROVABLE", 409);
  const candidates = [
    ...new Map(
      rawCandidates.map((value) => {
        const candidate = approvalCandidate(value);
        return [candidate.caseId, candidate] as const;
      }),
    ).values(),
  ].map((candidate) => {
    const emailChoice = customerEmailChoiceSchema.safeParse(rawEmailChoices[candidate.caseId]);
    if (!emailChoice.success) throw new AppError("DOCUMENT_NOT_APPROVABLE", 409);
    return { ...candidate, emailChoice: emailChoice.data };
  });
  const currentCandidates = await getPool().query<{
    billing_case_id: string;
    draft_version: number;
    projection_sha256: string;
  }>(
    `SELECT billing_cases.id AS billing_case_id, documents.draft_version,
            documents.projection_sha256
     FROM billing_cases
     JOIN documents ON documents.billing_case_id = billing_cases.id
       AND documents.kind = 'INVOICE' AND documents.status = 'DRAFT'
     WHERE billing_cases.id = ANY($1::bigint[]) AND billing_cases.status = 'READY'`,
    [candidates.map((candidate) => candidate.caseId)],
  );
  const currentByCase = new Map(
    currentCandidates.rows.map((candidate) => [candidate.billing_case_id, candidate]),
  );
  if (
    candidates.some((candidate) => {
      const current = currentByCase.get(candidate.caseId);
      return (
        !current ||
        current.draft_version !== candidate.draftVersion ||
        current.projection_sha256 !== candidate.projectionSha256
      );
    })
  ) {
    return { approved: 0, failed: candidates.length, storagePending: 0 };
  }
  const outcomes = await Promise.all(
    candidates.map(async (candidate) => {
      try {
        const result = await approveInvoice(
          candidate.caseId,
          {
            caseRevision: candidate.caseRevision,
            draftVersion: candidate.draftVersion,
            projectionSha256: candidate.projectionSha256,
            confirmPending: false,
            confirmDifference: false,
            arubaMode: arubaMode.data,
            confirmArubaDowngrade,
            emailChoice: candidate.emailChoice,
            emailModeVersion: rawEmailModeVersion,
          },
          actor,
        );
        return {
          approved: true,
          storagePending: result?.storagePending ?? false,
        };
      } catch (error) {
        if (!(error instanceof AppError)) throw error;
        return { approved: false, storagePending: false };
      }
    }),
  );
  const approved = outcomes.filter((outcome) => outcome.approved).length;
  return {
    approved,
    failed: candidates.length - approved,
    storagePending: outcomes.filter((outcome) => outcome.storagePending).length,
  };
}
