import { createHash } from "node:crypto";

import { documentInputSchema, fiscalProfileSchema } from "../documents.ts";
import { validateFatturaXml } from "../fatturapa.server.ts";
import { AppError } from "../errors.ts";
import { getArubaInventoryHealth } from "./aruba-inventory-health.server.ts";
import { getArubaSettings } from "./aruba.server.ts";
import { getPool } from "./client.server.ts";
import { customerEmailPreview } from "./email.server.ts";
import { isDatabaseId } from "./database-id.ts";
import { readDocumentXml } from "./document-storage.server.ts";
import type { getInvoiceProjection } from "./documents.server.ts";

type InvoiceProjection = Extract<
  NonNullable<Awaited<ReturnType<typeof getInvoiceProjection>>>,
  { profileMissing: false }
>;

interface HistoricalInvoiceRow {
  id: string;
  revision: number;
  fiscal_profile_version: number;
  profile_status: "MOCK" | "AUDITED" | "RETIRED";
  fiscal_profile_snapshot_json: unknown;
  immutable_snapshot_json: unknown;
  draft_version: number;
  source_total_amount: number;
  difference_amount: number;
  difference_reason: string | null;
}

function joined(values: Array<string | undefined | null>) {
  return values.filter((value): value is string => Boolean(value)).join(" · ") || "—";
}

export function historicalInvoiceInput(snapshot: unknown) {
  return documentInputSchema.parse(snapshot);
}

export async function getHistoricalInvoiceProjection(
  caseId: string,
): Promise<InvoiceProjection | null> {
  if (!isDatabaseId(caseId)) return null;
  const result = await getPool().query<HistoricalInvoiceRow>(
    `SELECT documents.id, billing_cases.revision, documents.fiscal_profile_version,
            fiscal_profiles.status AS profile_status,
            documents.fiscal_profile_snapshot_json, documents.immutable_snapshot_json,
            documents.draft_version, documents.source_total_amount,
            documents.difference_amount, documents.difference_reason
     FROM billing_cases
     JOIN documents ON documents.billing_case_id = billing_cases.id
     JOIN fiscal_profiles ON fiscal_profiles.version = documents.fiscal_profile_version
     WHERE billing_cases.id = $1 AND billing_cases.status = 'CLOSED'
       AND documents.kind = 'INVOICE' AND documents.status = 'APPROVED'
       AND documents.origin = 'ARUBA_HISTORY'
     LIMIT 1`,
    [caseId],
  );
  const row = result.rows[0];
  if (!row) return null;
  const input = historicalInvoiceInput(row.immutable_snapshot_json);
  const profile = fiscalProfileSchema.parse(row.fiscal_profile_snapshot_json);
  const storedXml = await readDocumentXml(row.id);
  if (!storedXml) throw new AppError("DOCUMENT_STORAGE_FAILED", 500);
  const xml = storedXml.toString("utf8");
  await validateFatturaXml(xml);
  const digest = createHash("sha256").update(xml).digest("hex");
  const recipientName =
    input.recipient.businessName ??
    joined([input.recipient.firstName, input.recipient.lastName, input.recipient.displayName]);
  const recipientTaxes = joined(
    input.recipient.taxIdentifiers.map((identifier) =>
      joined([identifier.type, identifier.countryCode, identifier.value]),
    ),
  );
  const recipientAddress = joined([
    input.recipient.address.line1,
    input.recipient.address.line2,
    input.recipient.address.postalCode,
    input.recipient.address.city,
    input.recipient.address.province,
    input.recipient.address.countryCode,
  ]);
  const comparison = {
    recipient: [
      { field: "identity" as const, source: "—", draft: recipientName, projected: recipientName },
      { field: "taxes" as const, source: "—", draft: recipientTaxes, projected: recipientTaxes },
      {
        field: "address" as const,
        source: "—",
        draft: recipientAddress,
        projected: recipientAddress,
      },
      {
        field: "delivery" as const,
        source: "—",
        draft: joined([input.recipient.recipientCode, input.recipient.certifiedEmail]),
        projected: joined([input.recipient.recipientCode, input.recipient.certifiedEmail]),
      },
    ],
    lines: input.lines.map((line, index) => ({
      field: String(index + 1),
      source: "—",
      draft: joined([
        line.description,
        `${line.quantity} × ${(line.unitAmount / 100).toFixed(2)} €`,
      ]),
      projected: joined([
        line.description,
        `${line.quantity} × ${(line.unitAmount / 100).toFixed(2)} €`,
        profile.taxNature,
      ]),
    })),
    payment: [
      {
        field: "status" as const,
        source: "—",
        draft: `${input.paymentStatus} · ${input.paymentMethod}`,
        projected: `${profile.payment.condition} · ${input.paymentMethod}`,
      },
    ],
    notes: [
      {
        field: "causale" as const,
        source: "—",
        draft: input.causale ?? "—",
        projected: input.causale ?? "—",
      },
      {
        field: "notes" as const,
        source: "—",
        draft: input.notes ?? "—",
        projected: input.notes ?? "—",
      },
    ],
    technical: [
      {
        field: "document" as const,
        source: "Aruba",
        draft: joined([input.documentDate, profile.series]),
        projected: `TD01 · FPR12 · ${profile.series}`,
      },
      {
        field: "tax" as const,
        source: "Aruba",
        draft: `${profile.seller.taxRegime} · ${profile.taxNature}`,
        projected: `${profile.seller.taxRegime} · ${profile.taxNature} · ${profile.legalReference}`,
      },
    ],
  };
  const total = input.lines.reduce((sum, line) => sum + line.quantity * line.unitAmount, 0);
  const arubaSettings = await getArubaSettings();
  return {
    caseRevision: row.revision,
    profileMissing: false,
    profileVersion: row.fiscal_profile_version,
    profileStatus: row.profile_status,
    draftVersion: row.draft_version,
    documentDate: input.documentDate,
    lines: input.lines,
    sourceLines: [],
    grossTotal: row.source_total_amount,
    shopifyPaymentsFeeTotal: 0,
    sourceTotal: row.source_total_amount,
    total,
    difference: row.difference_amount,
    differenceReason: row.difference_reason ?? "",
    paymentStatus: input.paymentStatus,
    paymentMethod: input.paymentMethod,
    causale: input.causale ?? "",
    notes: input.notes ?? "",
    paymentPending: input.paymentStatus === "PENDING",
    requiresResave: false,
    projectionSha256: digest,
    xml,
    comparison,
    approved: true,
    arubaMode: arubaSettings.effectiveMode,
    arubaConfiguredMode: arubaSettings.mode.value,
    arubaDowngradeRequired: arubaSettings.mode.value !== arubaSettings.effectiveMode,
    arubaInventory: await getArubaInventoryHealth(),
    customerEmail: await customerEmailPreview(caseId),
  };
}
