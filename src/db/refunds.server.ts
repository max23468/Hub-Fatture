import { createHash } from "node:crypto";
import path from "node:path";

import type pg from "pg";

import {
  documentInputSchema,
  fatturaPaText,
  fiscalNumberLabel,
  fiscalProfileSchema,
  generateFatturaXml,
  projectFatturaXml,
  type DocumentInput,
  type FiscalProfile,
} from "../documents.ts";
import { AppError } from "../errors.ts";
import { creditableRemainder } from "../refunds.ts";
import { validateFatturaXml } from "../fatturapa.server.ts";
import { writeAudit } from "./audit.server.ts";
import { createArubaBatch, getArubaSettings } from "./aruba.server.ts";
import { assertJobLease, renewLockedJobLease, type ClaimedJob } from "./connectors.server.ts";
import { getPool, withTransaction } from "./client.server.ts";
import { customerEmailPreview, snapshotDocumentEmail } from "./email.server.ts";
import {
  materializeDocumentStorage,
  readDocumentXml,
  recipientComparison,
} from "./documents.server.ts";
import { isDatabaseId } from "./order-commands.server.ts";

interface Actor {
  id: number;
  canApprove: boolean;
  requestId: string;
}

interface CreditRow {
  id: string;
  billing_case_id: string;
  status: "DRAFT" | "APPROVED";
  document_date: string;
  series: string;
  fiscal_year: number | null;
  fiscal_number: number | null;
  fiscal_profile_version: number;
  recipient_snapshot_json: DocumentInput["recipient"];
  total_amount: number;
  draft_version: number;
  projection_sha256: string;
  invoice_id: string;
  invoice_date: string;
  invoice_series: string;
  invoice_year: number;
  invoice_number: number;
  invoice_total: number;
  credited_amount: number;
  profile_json: FiscalProfile;
  lines: Array<{
    order_id: string;
    description: string;
    quantity: number;
    unit_amount: number;
  }>;
  refunds: Array<{
    id: string;
    order_id: string;
    provider: "SHOPIFY" | "EBAY";
    external_account_id: string;
    external_order_id: string;
    external_refund_id: string;
    display_number: string;
    amount: number;
  }>;
}

function creditInput(row: CreditRow): DocumentInput {
  return documentInputSchema.parse({
    kind: "CREDIT_NOTE",
    documentDate: row.document_date,
    recipient: row.recipient_snapshot_json,
    lines: row.lines.map((line) => ({
      orderId: line.order_id,
      description: line.description,
      quantity: line.quantity,
      unitAmount: line.unit_amount,
    })),
    paymentStatus: "PAID",
    paymentMethod: row.profile_json.payment.creditNoteMethod,
    relatedInvoice: {
      number: fiscalNumberLabel(row.invoice_series, row.invoice_year, row.invoice_number),
      date: row.invoice_date,
    },
  });
}

async function loadCredit(client: pg.Pool | pg.PoolClient, id: string, lock = false) {
  const result = await client.query<CreditRow>(
    `SELECT credit.id, credit.billing_case_id, credit.status, credit.document_date::text,
            credit.series, credit.fiscal_year, credit.fiscal_number,
            credit.fiscal_profile_version, credit.recipient_snapshot_json,
            credit.total_amount, credit.draft_version, credit.projection_sha256,
            invoice.id AS invoice_id, invoice.document_date::text AS invoice_date,
            invoice.series AS invoice_series, invoice.fiscal_year AS invoice_year,
            invoice.fiscal_number AS invoice_number, invoice.total_amount AS invoice_total,
            balances.credited_amount, profiles.profile_json,
            coalesce((
              SELECT jsonb_agg(jsonb_build_object(
                'order_id', lines.order_id::text, 'description', lines.description,
                'quantity', lines.quantity, 'unit_amount', lines.unit_amount
              ) ORDER BY lines.line_number)
              FROM document_lines AS lines WHERE lines.document_id = credit.id
            ), '[]') AS lines,
            coalesce((
              SELECT jsonb_agg(jsonb_build_object(
                'id', refunds.id::text, 'order_id', refunds.order_id::text,
                'provider', refunds.provider,
                'external_account_id', refunds.external_account_id,
                'external_order_id', refunds.external_order_id,
                'external_refund_id', refunds.external_refund_id,
                'display_number', orders.display_number, 'amount', refunds.amount
              ) ORDER BY refunds.id)
              FROM refunds JOIN orders ON orders.id = refunds.order_id
              WHERE refunds.credit_document_id = credit.id
            ), '[]') AS refunds
     FROM documents AS credit
     JOIN document_links AS links ON links.document_id = credit.id
     JOIN documents AS invoice ON invoice.id = links.related_document_id
     JOIN credit_note_balances AS balances ON balances.invoice_document_id = invoice.id
     JOIN fiscal_profiles AS profiles ON profiles.version = credit.fiscal_profile_version
     WHERE credit.id = $1 AND credit.kind = 'CREDIT_NOTE'
     ${lock ? "FOR UPDATE OF credit, invoice, balances" : ""}`,
    [id],
  );
  const row = result.rows[0];
  if (!row) return null;
  const profile = fiscalProfileSchema.safeParse(row.profile_json);
  if (!profile.success) throw new AppError("DOCUMENT_FISCAL_PROFILE_MISSING", 409);
  return { ...row, profile_json: profile.data };
}

const comparisonMoney = new Intl.NumberFormat("it-IT", {
  style: "currency",
  currency: "EUR",
});

function creditComparison(row: CreditRow, input: DocumentInput) {
  const refundsByOrder = Map.groupBy(row.refunds, (refund) => refund.order_id);
  return {
    recipient: recipientComparison(input.recipient),
    lines: input.lines.map((line, index) => ({
      field: String(index + 1),
      source:
        refundsByOrder
          .get(line.orderId ?? "")
          ?.map(
            (refund) =>
              `${refund.provider} · profilo ${refund.external_account_id} · ordine ${refund.external_order_id} · rimborso ${refund.external_refund_id} · ${comparisonMoney.format(refund.amount / 100)}`,
          )
          .join("; ") ?? "—",
      draft: `${line.description} · 1 × ${comparisonMoney.format(line.unitAmount / 100)}`,
      projected: `${fatturaPaText(line.description, 1000)} · 1 × ${comparisonMoney.format(line.unitAmount / 100)} · ${row.profile_json.taxNature}`,
    })),
    payment: [
      {
        field: "status" as const,
        source: "Rimborso completato",
        draft: `Pagato · ${input.paymentMethod}`,
        projected: `${row.profile_json.payment.condition} · ${input.paymentMethod}`,
      },
    ],
    notes: [
      {
        field: "relatedInvoice" as const,
        source: `${input.relatedInvoice!.number} del ${input.relatedInvoice!.date}`,
        draft: `${input.relatedInvoice!.number} del ${input.relatedInvoice!.date}`,
        projected: `DatiFattureCollegate · ${input.relatedInvoice!.number} · ${input.relatedInvoice!.date}`,
      },
    ],
    technical: [
      {
        field: "document" as const,
        source: "Rimborsi completati",
        draft: `${input.documentDate} · ${row.series}`,
        projected: `TD04 · FPR12 · ${row.series}`,
      },
      {
        field: "tax" as const,
        source: "—",
        draft: `${row.profile_json.seller.taxRegime} · ${row.profile_json.taxNature}`,
        projected: `${row.profile_json.seller.taxRegime} · ${row.profile_json.taxNature} · ${row.profile_json.legalReference}`,
      },
    ],
  };
}

export async function refreshCreditNoteDraft(client: pg.PoolClient, documentId: string) {
  await client.query("DELETE FROM document_lines WHERE document_id = $1", [documentId]);
  await client.query("DELETE FROM document_orders WHERE document_id = $1", [documentId]);
  const lines = await client.query<{
    order_id: string;
    provider: "SHOPIFY" | "EBAY";
    display_number: string;
    amount: number;
  }>(
    `SELECT refunds.order_id, orders.provider, orders.display_number,
            sum(refunds.amount)::integer AS amount
     FROM refunds JOIN orders ON orders.id = refunds.order_id
     WHERE refunds.credit_document_id = $1
     GROUP BY refunds.order_id, orders.provider, orders.display_number
     ORDER BY refunds.order_id`,
    [documentId],
  );
  if (!lines.rows.length) {
    await client.query("DELETE FROM document_links WHERE document_id = $1", [documentId]);
    await client.query(
      "DELETE FROM documents WHERE id = $1 AND kind = 'CREDIT_NOTE' AND status = 'DRAFT'",
      [documentId],
    );
    return 0;
  }
  for (const [index, line] of lines.rows.entries()) {
    await client.query(
      `INSERT INTO document_orders (document_id, document_kind, order_id, amount)
       VALUES ($1, 'CREDIT_NOTE', $2, $3)`,
      [documentId, line.order_id, line.amount],
    );
    await client.query(
      `INSERT INTO document_lines
        (document_id, order_id, line_number, description, quantity, unit_amount,
         total_amount, tax_nature)
       VALUES ($1, $2, $3, $4, 1, $5, $5, 'N5')`,
      [
        documentId,
        line.order_id,
        index + 1,
        `Rimborso ordine ${line.provider === "SHOPIFY" ? "Shopify" : "eBay"} ${line.display_number}`,
        line.amount,
      ],
    );
  }
  const total = lines.rows.reduce((sum, line) => sum + line.amount, 0);
  const draft = await loadCredit(client, documentId, true);
  if (!draft || draft.status !== "DRAFT") throw new AppError("CREDIT_NOTE_NOT_ALLOWED", 409);
  const input = creditInput({ ...draft, total_amount: total });
  const projection = projectFatturaXml(draft.profile_json, input);
  await validateFatturaXml(projection.xml);
  await client.query(
    `UPDATE documents SET total_amount = $2, source_total_amount = $2,
       difference_amount = 0, difference_reason = NULL,
       document_date = $3, draft_version = CASE WHEN total_amount = 0 THEN 1 ELSE draft_version + 1 END,
       projection_sha256 = $4, updated_at = now() WHERE id = $1`,
    [documentId, total, input.documentDate, projection.sha256],
  );
  return total;
}

export async function processRefund(refundId: string, job?: ClaimedJob) {
  if (!isDatabaseId(refundId)) throw new AppError("REFUND_NEEDS_REVIEW", 422);
  return withTransaction(async (client) => {
    if (job) await assertJobLease(client, job);
    const refund = await client.query<{
      id: string;
      status: string;
      amount: number | null;
      order_id: string;
      provider: "SHOPIFY" | "EBAY";
      display_number: string;
      invoice_id: string | null;
      billing_case_id: string | null;
      invoice_total: number | null;
      recipient: DocumentInput["recipient"] | null;
      profile_version: number | null;
      series: string | null;
      credit_document_id: string | null;
      applied_before_issue: boolean;
      historical_reconciliation_outcome: string | null;
    }>(
      `SELECT refunds.id, refunds.status, refunds.amount, refunds.order_id, refunds.provider,
              refunds.credit_document_id, refunds.applied_before_issue,
              orders.historical_reconciliation_outcome,
              orders.display_number, invoice.id AS invoice_id,
              invoice.billing_case_id, invoice.total_amount AS invoice_total,
              invoice.recipient_snapshot_json AS recipient,
              invoice.fiscal_profile_version AS profile_version, invoice.series
       FROM refunds
       JOIN orders ON orders.id = refunds.order_id
       LEFT JOIN document_orders AS invoice_order
         ON invoice_order.order_id = refunds.order_id AND invoice_order.document_kind = 'INVOICE'
       LEFT JOIN documents AS invoice
         ON invoice.id = invoice_order.document_id AND invoice.status = 'APPROVED'
       WHERE refunds.id = $1 FOR UPDATE OF refunds`,
      [refundId],
    );
    const source = refund.rows[0];
    if (!source) return null;
    if (source.applied_before_issue) return null;
    if (source.credit_document_id) return source.credit_document_id;
    if (source.status === "AMBIGUOUS" || source.amount === null || source.amount <= 0) {
      const alreadyAudited = await client.query(
        `SELECT 1 FROM audit_events
         WHERE action = 'REFUND_NEEDS_REVIEW' AND entity_type = 'REFUND' AND entity_id = $1 LIMIT 1`,
        [source.id],
      );
      if (!alreadyAudited.rows[0]) {
        await writeAudit(client, {
          actorType: "SYSTEM",
          action: "REFUND_NEEDS_REVIEW",
          eventClass: "CRITICAL",
          entityType: "REFUND",
          entityId: source.id,
          metadata: { provider: source.provider, reviewRequired: true },
          requestId: `process-refund:${source.id}`,
        });
      }
      if (job) await renewLockedJobLease(client, job);
      return null;
    }
    if (
      source.status === "COMPLETED" &&
      !source.invoice_id &&
      source.historical_reconciliation_outcome === "ALREADY_INVOICED"
    ) {
      const alreadyAudited = await client.query(
        `SELECT 1 FROM audit_events
         WHERE action = 'REFUND_NEEDS_REVIEW' AND entity_type = 'REFUND' AND entity_id = $1 LIMIT 1`,
        [source.id],
      );
      if (!alreadyAudited.rows[0]) {
        await writeAudit(client, {
          actorType: "SYSTEM",
          action: "REFUND_NEEDS_REVIEW",
          eventClass: "CRITICAL",
          entityType: "REFUND",
          entityId: source.id,
          metadata: { provider: source.provider, reviewRequired: true },
          requestId: `process-refund:${source.id}`,
        });
      }
      if (job) await renewLockedJobLease(client, job);
      return null;
    }
    if (source.status !== "COMPLETED" || !source.invoice_id) return null;
    const issued = await client.query(
      `SELECT 1 FROM documents WHERE id = $1 AND origin = 'ARUBA_HISTORY'
       UNION ALL
       SELECT 1 FROM aruba_submissions
       WHERE document_id = $1 AND status IN ('DELIVERED', 'NOT_DELIVERED') LIMIT 1`,
      [source.invoice_id],
    );
    if (!issued.rows[0]) return null;
    const balance = await client.query<{ invoice_total: number; credited_amount: number }>(
      `SELECT invoice_total, credited_amount FROM credit_note_balances
       WHERE invoice_document_id = $1 FOR UPDATE`,
      [source.invoice_id],
    );
    const currentBalance = balance.rows[0];
    if (!currentBalance) throw new AppError("CREDIT_NOTE_NOT_ALLOWED", 409);
    if (
      source.amount >
      creditableRemainder(currentBalance.invoice_total, currentBalance.credited_amount)
    ) {
      throw new AppError("CREDIT_NOTE_LIMIT_EXCEEDED", 409);
    }
    let credit = await client.query<{ id: string }>(
      `SELECT documents.id FROM documents
       JOIN document_links ON document_links.document_id = documents.id
       WHERE documents.kind = 'CREDIT_NOTE' AND documents.status = 'DRAFT'
         AND document_links.related_document_id = $1
       FOR UPDATE OF documents`,
      [source.invoice_id],
    );
    let documentId = credit.rows[0]?.id;
    if (!documentId) {
      const created = await client.query<{ id: string }>(
        `INSERT INTO documents
          (billing_case_id, kind, status, document_type, series, document_date,
           fiscal_profile_version, currency, total_amount, source_total_amount,
           difference_amount, draft_version, projection_sha256, payment_status,
           payment_method, recipient_snapshot_json)
         VALUES ($1, 'CREDIT_NOTE', 'DRAFT', 'TD04', $2,
           (CURRENT_TIMESTAMP AT TIME ZONE 'Europe/Rome')::date, $3, 'EUR', 0, 0, 0, 1,
           repeat('0', 64), 'PAID', 'MP05', $4)
         RETURNING id`,
        [
          source.billing_case_id,
          source.series,
          source.profile_version,
          JSON.stringify(source.recipient),
        ],
      );
      documentId = created.rows[0]!.id;
      await client.query(
        `INSERT INTO document_links (document_id, related_document_id, relation_type)
         VALUES ($1, $2, 'CREDIT_NOTE_FOR_INVOICE')`,
        [documentId, source.invoice_id],
      );
    }
    await client.query(
      `UPDATE refunds SET credit_document_id = $2, updated_at = now()
       WHERE id = $1 AND credit_document_id IS NULL`,
      [source.id, documentId],
    );
    const total = await refreshCreditNoteDraft(client, documentId);
    await writeAudit(client, {
      actorType: "SYSTEM",
      action: "REFUND_CREDIT_NOTE_LINKED",
      eventClass: "CRITICAL",
      entityType: "REFUND",
      entityId: source.id,
      metadata: { provider: source.provider, documentKind: "CREDIT_NOTE" },
      after: { creditDocumentId: documentId, total },
      requestId: `process-refund:${source.id}`,
    });
    if (job) await renewLockedJobLease(client, job);
    return documentId;
  });
}

export async function getCreditNoteProjection(documentId: string) {
  if (!isDatabaseId(documentId)) return null;
  const row = await loadCredit(getPool(), documentId);
  if (!row) return null;
  const input = creditInput(row);
  const projected = projectFatturaXml(row.profile_json, input);
  await validateFatturaXml(projected.xml);
  const approvedXml = row.status === "APPROVED" ? await readDocumentXml(row.id) : null;
  const xml = approvedXml?.toString("utf8") ?? projected.xml;
  return {
    id: row.id,
    status: row.status,
    draftVersion: row.draft_version,
    projectionSha256: approvedXml
      ? createHash("sha256").update(approvedXml).digest("hex")
      : projected.sha256,
    xml,
    invoiceId: row.invoice_id,
    invoiceNumber: input.relatedInvoice!.number,
    invoiceDate: row.invoice_date,
    invoiceTotal: row.invoice_total,
    creditedAmount: row.credited_amount,
    remainder: creditableRemainder(row.invoice_total, row.credited_amount),
    total: row.total_amount,
    profileVersion: row.fiscal_profile_version,
    lines: input.lines,
    refunds: row.refunds,
    comparison: creditComparison(row, input),
    arubaMode: (await getArubaSettings()).effectiveMode,
    customerEmail: await customerEmailPreview(row.billing_case_id),
  };
}

export async function approveCreditNote(
  documentId: string,
  raw: {
    draftVersion: unknown;
    projectionSha256: unknown;
    confirmApproval: boolean;
    arubaMode: unknown;
    emailChoice: unknown;
    emailModeVersion: unknown;
  },
  actor: Actor,
) {
  if (!actor.canApprove) throw new AppError("DOCUMENT_APPROVAL_FORBIDDEN", 403);
  if (!isDatabaseId(documentId) || !raw.confirmApproval) {
    throw new AppError("DOCUMENT_NOT_APPROVABLE", 409);
  }
  const expectedVersion = Number(raw.draftVersion);
  const expectedProjection = String(raw.projectionSha256 ?? "");
  const committed = await withTransaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('fiscal-profile'))");
    const row = await loadCredit(client, documentId, true);
    if (!row || row.status !== "DRAFT" || row.draft_version !== expectedVersion) {
      throw new AppError("CONFLICT_REVISION", 409);
    }
    const input = creditInput(row);
    const projected = projectFatturaXml(row.profile_json, input);
    await validateFatturaXml(projected.xml);
    if (projected.sha256 !== expectedProjection || row.projection_sha256 !== expectedProjection) {
      throw new AppError("DOCUMENT_PROJECTION_STALE", 409);
    }
    const year = Number(input.documentDate.slice(0, 4));
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
      `fiscal-number:${row.series}:${year}`,
    ]);
    const sequence = await client.query<{ next: number }>(
      `SELECT greatest(coalesce(max(fiscal_number), 0), $3::integer) + 1 AS next
       FROM documents WHERE status = 'APPROVED' AND series = $1 AND fiscal_year = $2`,
      [
        row.series,
        year,
        row.profile_json.numbering.lastObservedYear === year
          ? row.profile_json.numbering.lastObservedNumber
          : 0,
      ],
    );
    const number = Number(sequence.rows[0]!.next);
    const xml = generateFatturaXml(row.profile_json, input, { year, number });
    await validateFatturaXml(xml);
    const sha256 = createHash("sha256").update(xml).digest("hex");
    const relativePath = path.posix.join(
      "credit-notes",
      String(year),
      `${row.series}-${String(number).padStart(4, "0")}-${String(year).slice(-2)}.xml`,
    );
    const storage = await client.query<{ id: string }>(
      `INSERT INTO storage_objects (kind, relative_path, sha256, size_bytes, content_type)
       VALUES ('CREDIT_NOTE_XML', $1, $2, $3, 'application/xml') RETURNING id`,
      [relativePath, sha256, Buffer.byteLength(xml)],
    );
    const snapshot = {
      generatorVersion: 2,
      ...input,
      sourceTotal: row.total_amount,
      total: row.total_amount,
      difference: 0,
      differenceReason: null,
    };
    await snapshotDocumentEmail(client, documentId, raw.emailChoice, raw.emailModeVersion);
    await client.query(
      `UPDATE documents SET status = 'APPROVED', fiscal_year = $2, fiscal_number = $3,
         document_date = $4, approved_at = now(), xml_sha256 = $5,
         immutable_snapshot_json = $6, fiscal_profile_snapshot_json = $7,
         storage_object_id = $8, updated_at = now() WHERE id = $1`,
      [
        documentId,
        year,
        number,
        input.documentDate,
        sha256,
        JSON.stringify(snapshot),
        JSON.stringify(row.profile_json),
        storage.rows[0]!.id,
      ],
    );
    const label = fiscalNumberLabel(row.series, year, number);
    const batchId = await createArubaBatch(
      client,
      [
        {
          id: documentId,
          revision: row.draft_version,
          sha256,
          filename: path.posix.basename(relativePath),
          sizeBytes: Buffer.byteLength(xml),
          fiscalNumber: label,
          documentDate: input.documentDate,
          totalAmount: row.total_amount,
        },
      ],
      actor,
      raw.arubaMode,
    );
    const audit = {
      actorType: "ADMIN" as const,
      actorId: String(actor.id),
      eventClass: "CRITICAL" as const,
      entityType: "DOCUMENT" as const,
      entityId: documentId,
      metadata: {
        documentKind: "CREDIT_NOTE" as const,
        fiscalNumber: label,
        fiscalProfileVersion: row.fiscal_profile_version,
      },
      requestId: actor.requestId,
    };
    await writeAudit(client, { ...audit, action: "DOCUMENT_NUMBERED" });
    await writeAudit(client, { ...audit, action: "DOCUMENT_APPROVED" });
    return { xml, label, batchId };
  });
  try {
    await materializeDocumentStorage(documentId, committed.xml);
    return { fiscalNumber: committed.label, batchId: committed.batchId, storagePending: false };
  } catch {
    return { fiscalNumber: committed.label, batchId: committed.batchId, storagePending: true };
  }
}
