import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import type pg from "pg";

import {
  canManuallyLinkCandidate,
  groupOrderCandidates,
  isArubaAmountMismatchCandidate,
  isEmissionConfirmed,
  normalizedMatchText,
  remoteInventoryDocumentSchema,
  selectAutomaticAmbiguousInvoiceMatches,
  selectOrderMatch,
  type AmbiguousInvoiceCandidate,
  type AmbiguousInvoiceMatch,
  type RemoteInventoryDocument,
} from "../aruba-inbound.ts";
import { arubaOrderCandidateFromSource } from "../aruba-order-candidate.ts";
import { ARUBA_IMPORT_MAX_BYTES, validateUntrustedXml } from "../aruba.ts";
import { getConfig } from "../config.server.ts";
import {
  acceptedCreditNoteFromXml,
  acceptedDocumentFiscalIdentity,
  acceptedFiscalDocumentEvidenceFromXml,
  acceptedInvoiceFromXml,
  fiscalProfileSchema,
  type FiscalProfile,
} from "../documents.ts";
import { AppError } from "../errors.ts";
import { refreshInvoiceDraftProjection } from "./invoice-draft-projection.server.ts";
import { serializeOrderMutations } from "./order-mutation-lock.server.ts";
import { arubaOrderCandidates } from "./aruba-reconciliation.server.ts";
import { reconcileRemoteDocument } from "./aruba-reconciliation.server.ts";
import {
  lockedRemoteMatch,
  markRemoteProfileConflict,
  type LockedRemoteMatch,
} from "./aruba-remote-match.server.ts";

function acceptedProfileMatches(
  profile: FiscalProfile,
  identity: ReturnType<typeof acceptedDocumentFiscalIdentity>,
) {
  return (
    profile.series === "FPR" &&
    profile.transmitter.countryCode === identity.transmitter.countryCode &&
    profile.transmitter.taxCode === identity.transmitter.taxCode &&
    profile.seller.vatCountryCode === identity.seller.vatCountryCode &&
    profile.seller.vatCode === identity.seller.vatCode &&
    (profile.seller.taxCode ?? null) === (identity.seller.taxCode ?? null) &&
    profile.seller.taxRegime === identity.seller.taxRegime &&
    profile.taxNature === identity.taxNature &&
    profile.legalReference === identity.legalReference &&
    profile.payment.condition === identity.payment.condition
  );
}

function remoteFiscalIdentityMatches(
  remote: {
    document_type: "TD01" | "TD04";
    fiscal_year: number;
    series: string | null;
    fiscal_number: string | null;
    document_date: string;
    total_amount: number;
  },
  identity: ReturnType<typeof acceptedDocumentFiscalIdentity>,
) {
  return (
    remote.document_type === identity.type &&
    remote.fiscal_year === identity.year &&
    remote.document_date === identity.documentDate &&
    remote.total_amount === identity.totalAmount &&
    (!remote.series || normalizedMatchText(remote.series) === "FPR") &&
    (!remote.fiscal_number || Number(remote.fiscal_number) === identity.number)
  );
}

export async function latestObservedRemote(client: pg.PoolClient, remoteDocumentId: string) {
  const latest = await client.query<{ payload: unknown }>(
    `SELECT coalesce(observations.payload_json, document.value) AS payload
     FROM aruba_remote_documents remote
     JOIN aruba_remote_observations observations ON observations.remote_document_id = remote.id
     LEFT JOIN aruba_sync_pages pages
       ON pages.sync_session_id = observations.sync_session_id
      AND pages.stream = observations.stream
      AND pages.scan_ordinal = observations.scan_ordinal
      AND pages.page_ordinal = observations.page_ordinal
     LEFT JOIN LATERAL jsonb_array_elements(pages.documents_json) document(value) ON
       document.value ->> 'remoteId' = remote.remote_id
     WHERE remote.id = $1 AND coalesce(observations.payload_json, document.value) IS NOT NULL
     ORDER BY observations.observed_at DESC, observations.id DESC LIMIT 1`,
    [remoteDocumentId],
  );
  const parsed = remoteInventoryDocumentSchema.safeParse(latest.rows[0]?.payload);
  if (!parsed.success) throw new AppError("ARUBA_INVENTORY_BLOCKED", 409);
  return parsed.data;
}

async function activeFiscalProfile(client: pg.PoolClient) {
  const result = await client.query<{ version: number; profile_json: unknown }>(
    `SELECT version, profile_json FROM fiscal_profiles
     WHERE status IN ('MOCK', 'AUDITED') FOR SHARE`,
  );
  const row = result.rows[0];
  const parsed = fiscalProfileSchema.safeParse(row?.profile_json);
  return row && parsed.success ? { version: row.version, profile: parsed.data } : null;
}

function acceptedRecipientName(
  recipient: ReturnType<typeof acceptedInvoiceFromXml>["input"]["recipient"],
) {
  return (
    recipient.businessName ??
    recipient.displayName ??
    [recipient.firstName, recipient.lastName].filter(Boolean).join(" ")
  );
}

export function officialEvidence(
  remote: RemoteInventoryDocument,
  xml: string,
): RemoteInventoryDocument {
  const evidence = acceptedFiscalDocumentEvidenceFromXml(xml, {
    type: remote.documentType,
    year: remote.fiscalYear,
    documentDate: remote.documentDate,
    totalAmount: remote.totalAmount,
    series: remote.series,
    fiscalNumber: remote.fiscalNumber,
  });
  const identity = evidence.identity;
  if (
    remote.documentType !== identity.type ||
    remote.fiscalYear !== identity.year ||
    remote.documentDate !== identity.documentDate ||
    remote.totalAmount !== identity.totalAmount ||
    (remote.series && normalizedMatchText(remote.series) !== "FPR") ||
    (remote.fiscalNumber && Number(remote.fiscalNumber) !== identity.number)
  ) {
    throw new AppError("ARUBA_INVENTORY_CONFLICT", 409);
  }
  const recipient = evidence.recipient;
  const authoritativeRecipient = {
    recipientName: acceptedRecipientName(recipient),
    recipientTaxId: recipient.taxIdentifiers[0]?.value ?? null,
    recipientTaxIdentifiers: recipient.taxIdentifiers.map((identifier) => ({
      type: identifier.type,
      countryCode: identifier.countryCode ?? null,
      value: identifier.value,
    })),
    recipientCountryCode: recipient.address.countryCode,
    recipientAddress: [
      recipient.address.line1,
      recipient.address.postalCode,
      recipient.address.city,
      recipient.address.countryCode,
    ].join(" "),
  };
  if (identity.type === "TD04") {
    return {
      ...remote,
      ...authoritativeRecipient,
      xmlSha256: createHash("sha256").update(xml).digest("hex"),
      orderReferences: evidence.orderReferences,
      paymentMethod: evidence.paymentMethod,
    };
  }
  return {
    ...remote,
    ...authoritativeRecipient,
    xmlSha256: createHash("sha256").update(xml).digest("hex"),
    orderReferences: evidence.orderReferences,
    paymentMethod: evidence.paymentMethod,
  };
}

async function regenerateResidualInvoiceDraft(client: pg.PoolClient, caseId: string) {
  const updated = await client.query<{ id: string }>(
    `WITH totals AS (
       SELECT documents.id,
              coalesce(sum(document_orders.amount), 0)::integer AS amount
       FROM documents
       LEFT JOIN document_orders ON document_orders.document_id = documents.id
       WHERE documents.billing_case_id = $1 AND documents.kind = 'INVOICE'
         AND documents.status = 'DRAFT'
       GROUP BY documents.id
     )
     UPDATE documents SET source_total_amount = totals.amount,
       total_amount = totals.amount, difference_amount = 0, difference_reason = NULL,
       draft_version = draft_version + 1, projection_sha256 = repeat('0', 64),
       document_date = (CURRENT_TIMESTAMP AT TIME ZONE 'Europe/Rome')::date,
       updated_at = now()
     FROM totals WHERE documents.id = totals.id RETURNING documents.id`,
    [caseId],
  );
  if (updated.rows[0]) await refreshInvoiceDraftProjection(client, caseId);
}

async function rematchPostIssueCreditNotes(client: pg.PoolClient, orderIds: string[]) {
  const candidates = await client.query<{ id: string }>(
    `SELECT DISTINCT remote.id::text
     FROM aruba_remote_documents AS remote
     JOIN aruba_document_matches AS matches ON matches.remote_document_id = remote.id
     WHERE remote.environment = $2 AND remote.account_reference = $3
       AND remote.document_type = 'TD04' AND remote.remote_status <> 'REJECTED'
       AND matches.method <> 'MANUAL'
       AND matches.status NOT IN ('ERROR', 'UNKNOWN_REMOTE_STATE')
       AND EXISTS (
         SELECT 1 FROM refunds
         WHERE refunds.order_id = ANY($1::bigint[]) AND refunds.status = 'COMPLETED'
           AND refunds.amount > 0 AND NOT refunds.applied_before_issue
           AND refunds.completed_at IS NOT NULL
           AND (refunds.completed_at AT TIME ZONE 'Europe/Rome')::date
             BETWEEN remote.document_date - 31 AND remote.document_date
       )
     ORDER BY remote.id::text`,
    [
      orderIds,
      getConfig().APP_ENV === "production" ? "PRODUCTION" : "MOCK",
      getConfig().ARUBA_ACCOUNT_REFERENCE,
    ],
  );
  for (const remote of candidates.rows) {
    // react-doctor-disable-next-line react-doctor/async-await-in-loop -- Le TD04 condividono il lock inventario e dipendono dalla fattura appena materializzata.
    const observed = await latestObservedRemote(client, remote.id);
    // react-doctor-disable-next-line react-doctor/async-await-in-loop -- Ogni documento usa il proprio XML ufficiale quando disponibile.
    const official = await loadLatestOfficialXml(client, remote.id);
    // react-doctor-disable-next-line react-doctor/async-await-in-loop -- Il ricalcolo seriale evita candidati obsoleti dopo la riclassificazione dei rimborsi.
    await reconcileRemoteDocument(
      client,
      remote.id,
      official ? officialEvidence(observed, official.xml) : observed,
      Boolean(official),
    );
  }
}

async function materializeExternalInvoice(
  client: pg.PoolClient,
  remote: LockedRemoteMatch,
  storageObjectId: string,
  xml: string,
) {
  if (!remote.order_id || remote.match_status !== "MATCHED") return null;
  const imported = acceptedInvoiceFromXml(xml, new Date().toISOString());
  const identity = acceptedDocumentFiscalIdentity(xml);
  const profile = await activeFiscalProfile(client);
  if (
    !profile ||
    !remoteFiscalIdentityMatches(remote, identity) ||
    !acceptedProfileMatches(profile.profile, identity)
  ) {
    throw new AppError("ARUBA_PROFILE_CONFLICT", 409);
  }
  const evidenceRemote: RemoteInventoryDocument = {
    remoteId: remote.remote_id,
    documentType: "TD01",
    fiscalYear: remote.fiscal_year,
    series: remote.series,
    fiscalNumber: remote.fiscal_number,
    documentDate: remote.document_date,
    recipientName: acceptedRecipientName(imported.input.recipient),
    recipientTaxId: imported.input.recipient.taxIdentifiers[0]?.value ?? null,
    recipientTaxIdentifiers: imported.input.recipient.taxIdentifiers.map((identifier) => ({
      type: identifier.type,
      countryCode: identifier.countryCode ?? null,
      value: identifier.value,
    })),
    recipientCountryCode: imported.input.recipient.address.countryCode,
    recipientAddress: [
      imported.input.recipient.address.line1,
      imported.input.recipient.address.postalCode,
      imported.input.recipient.address.city,
      imported.input.recipient.address.countryCode,
    ].join(" "),
    totalAmount: imported.totalAmount,
    currency: "EUR",
    status: remote.remote_status,
    providerObservedAt: null,
    xmlSha256: createHash("sha256").update(xml).digest("hex"),
    orderReferences: imported.references,
    paymentMethod: imported.input.paymentMethod,
  };
  const candidates = await arubaOrderCandidates(client, evidenceRemote);
  const individualCandidates = candidates.map((candidate) =>
    arubaOrderCandidateFromSource(candidate),
  );
  const groupedCandidates = groupOrderCandidates(individualCandidates).filter(
    (candidate) => (candidate.orderIds?.length ?? 1) > 1,
  );
  const verified = selectOrderMatch(evidenceRemote, [
    ...individualCandidates,
    ...groupedCandidates,
  ]);
  const selectedEvaluation =
    remote.match_status === "MATCHED" && remote.order_id
      ? verified.evaluations.find(
          (candidate) =>
            candidate.candidateId === remote.order_id &&
            (candidate.compatible ||
              (remote.match_method === "MANUAL" &&
                (canManuallyLinkCandidate(candidate) ||
                  isArubaAmountMismatchCandidate(candidate)))),
        )
      : verified.status === "MATCHED"
        ? verified.evaluations.find((candidate) => candidate.compatible)
        : null;
  if (selectedEvaluation?.candidateId !== remote.order_id) {
    throw new AppError("ARUBA_PROFILE_CONFLICT", 409);
  }
  const matchedOrderIds = selectedEvaluation.orderIds;
  const matchedOrderIdSet = new Set(matchedOrderIds);
  await serializeOrderMutations(client);
  const order = await client.query<{
    id: string;
    customer_id: string;
    billing_case_id: string | null;
    customer_snapshot: Record<string, unknown>;
    canonical_billable_amount: number;
  }>(
    `SELECT orders.id, orders.customer_id, orders.billing_case_id,
            (orders.gross_amount - orders.deducted_shopify_payments_fee_amount - coalesce((
              SELECT sum(refunds.amount) FROM refunds
              WHERE refunds.order_id = orders.id AND refunds.status = 'COMPLETED'
                AND refunds.amount > 0 AND refunds.completed_at IS NOT NULL
                AND (refunds.completed_at AT TIME ZONE 'Europe/Rome')::date < $2::date
            ), 0))::integer AS canonical_billable_amount,
            orders.normalized_snapshot_json -> 'customerSnapshot' AS customer_snapshot
     FROM orders WHERE orders.id = ANY($1::bigint[]) ORDER BY orders.id FOR UPDATE`,
    [matchedOrderIds, imported.documentDate],
  );
  const manualAmountMismatch =
    remote.match_method === "MANUAL" && isArubaAmountMismatchCandidate(selectedEvaluation);
  const sourceTotalAmount = order.rows.reduce(
    (sum, item) => sum + item.canonical_billable_amount,
    0,
  );
  const differenceAmount = imported.totalAmount - sourceTotalAmount;
  const currentOrder = order.rows[0];
  if (
    !currentOrder ||
    order.rows.length !== matchedOrderIds.length ||
    (!manualAmountMismatch && sourceTotalAmount !== imported.totalAmount) ||
    (manualAmountMismatch && sourceTotalAmount === imported.totalAmount) ||
    new Set(order.rows.map((item) => item.customer_id)).size !== 1 ||
    new Set(order.rows.map((item) => item.billing_case_id)).size !== 1
  ) {
    throw new AppError("ARUBA_PROFILE_CONFLICT", 409);
  }
  const digest = createHash("sha256").update(xml).digest("hex");
  const existing = await client.query<{
    id: string;
    origin: string;
    xml_sha256: string;
  }>(
    `SELECT id, origin, xml_sha256 FROM documents
     WHERE series = $1 AND fiscal_year = $2 AND fiscal_number = $3 FOR UPDATE`,
    [profile.profile.series, imported.year, imported.number],
  );
  let documentId = existing.rows[0]?.id ?? null;
  if (existing.rows[0] && existing.rows[0].xml_sha256 !== digest) {
    throw new AppError("ARUBA_INVENTORY_CONFLICT", 409);
  }
  const priorInvoiceLinks = await client.query<{ document_id: string }>(
    `SELECT document_orders.document_id
     FROM document_orders
     JOIN documents ON documents.id = document_orders.document_id
     WHERE document_orders.order_id = ANY($1::bigint[])
       AND document_orders.document_kind = 'INVOICE' AND documents.status = 'APPROVED'
     FOR UPDATE OF document_orders`,
    [matchedOrderIds],
  );
  if (priorInvoiceLinks.rows.some((link) => !documentId || link.document_id !== documentId)) {
    throw new AppError("ARUBA_INVENTORY_CONFLICT", 409);
  }
  if (documentId && existing.rows[0]?.origin === "HUB") {
    const localLink = await client.query<{ order_id: string }>(
      `SELECT order_id FROM document_orders
       WHERE document_id = $1 AND document_kind = 'INVOICE' FOR UPDATE`,
      [documentId],
    );
    if (
      localLink.rows.length !== matchedOrderIds.length ||
      localLink.rows.some((row) => !matchedOrderIdSet.has(row.order_id))
    ) {
      throw new AppError("ARUBA_INVENTORY_CONFLICT", 409);
    }
    await client.query(
      `UPDATE aruba_document_matches SET document_id = $2, billing_case_id =
         (SELECT billing_case_id FROM documents WHERE id = $2), updated_at = now()
       WHERE remote_document_id = $1`,
      [remote.id, documentId],
    );
    await client.query(
      `UPDATE aruba_remote_documents SET origin = 'HUB_SUBMISSION' WHERE id = $1`,
      [remote.id],
    );
    return documentId;
  }
  if (!documentId) {
    const historicalCase = await client.query<{ id: string }>(
      `INSERT INTO billing_cases
        (customer_id, local_order_date, currency, status, customer_snapshot_json,
         fiscal_profile_version)
       VALUES ($1, $2, 'EUR', 'CLOSED', $3, $4) RETURNING id`,
      [
        currentOrder.customer_id,
        imported.documentDate,
        JSON.stringify(currentOrder.customer_snapshot),
        profile.version,
      ],
    );
    const snapshot = {
      generatorVersion: 2,
      ...imported.input,
      sourceTotal: sourceTotalAmount,
      total: imported.totalAmount,
      difference: differenceAmount,
      differenceReason: manualAmountMismatch ? remote.decision_reason : null,
    };
    const document = await client.query<{ id: string }>(
      `INSERT INTO documents
        (billing_case_id, kind, status, document_type, series, fiscal_year, fiscal_number,
         document_date, fiscal_profile_version, currency, total_amount, source_total_amount,
         difference_amount, difference_reason, projection_sha256, approved_at, xml_sha256,
         immutable_snapshot_json, fiscal_profile_snapshot_json, storage_object_id,
         payment_status, payment_method, recipient_snapshot_json, origin)
       VALUES ($1, 'INVOICE', 'APPROVED', 'TD01', $2, $3, $4, $5, $6, 'EUR',
         $7, $8, $9, $10, $11, now(), $11, $12, $13, $14, 'PAID', $15, $16, 'ARUBA_HISTORY')
       RETURNING id`,
      [
        historicalCase.rows[0]!.id,
        profile.profile.series,
        imported.year,
        imported.number,
        imported.documentDate,
        profile.version,
        imported.totalAmount,
        sourceTotalAmount,
        differenceAmount,
        manualAmountMismatch ? remote.decision_reason : null,
        digest,
        JSON.stringify(snapshot),
        JSON.stringify(imported.profile),
        storageObjectId,
        imported.input.paymentMethod,
        JSON.stringify(imported.input.recipient),
      ],
    );
    documentId = document.rows[0]!.id;
  }
  const alreadyLinked = await client.query<{ order_id: string }>(
    `SELECT order_id FROM document_orders
     WHERE document_id = $1 AND document_kind = 'INVOICE' FOR UPDATE`,
    [documentId],
  );
  if (alreadyLinked.rows.some((row) => !matchedOrderIdSet.has(row.order_id))) {
    throw new AppError("ARUBA_INVENTORY_CONFLICT", 409);
  }
  await client.query(
    `DELETE FROM document_lines
     WHERE order_id = ANY($1::bigint[]) AND document_id IN (
       SELECT id FROM documents WHERE kind = 'INVOICE' AND status = 'DRAFT'
     )`,
    [matchedOrderIds],
  );
  await client.query(
    `UPDATE refunds SET applied_before_issue =
       ((completed_at AT TIME ZONE 'Europe/Rome')::date < $2::date), updated_at = now()
     WHERE order_id = ANY($1::bigint[]) AND status = 'COMPLETED' AND amount > 0
       AND completed_at IS NOT NULL
       AND (completed_at AT TIME ZONE 'Europe/Rome')::date <> $2::date`,
    [matchedOrderIds, imported.documentDate],
  );
  await client.query(
    `INSERT INTO jobs (type, payload_json)
     SELECT 'process_refund', jsonb_build_object('refundId', refunds.id::text)
     FROM refunds
     WHERE refunds.order_id = ANY($1::bigint[]) AND refunds.status = 'COMPLETED'
       AND refunds.amount > 0 AND NOT refunds.applied_before_issue
       AND refunds.credit_document_id IS NULL
     ON CONFLICT DO NOTHING`,
    [matchedOrderIds],
  );
  await client.query(
    `DELETE FROM document_orders
     WHERE order_id = ANY($1::bigint[]) AND document_kind = 'INVOICE'
       AND document_id IN (SELECT id FROM documents WHERE status = 'DRAFT')`,
    [matchedOrderIds],
  );
  await client.query(
    `INSERT INTO document_orders (document_id, document_kind, order_id, amount)
     SELECT $1, 'INVOICE', source.order_id, source.amount
     FROM unnest($2::bigint[], $3::integer[]) AS source(order_id, amount)
     ON CONFLICT (document_id, order_id) DO NOTHING`,
    [
      documentId,
      order.rows.map((item) => item.id),
      order.rows.map((item) => item.canonical_billable_amount),
    ],
  );
  await rematchPostIssueCreditNotes(client, matchedOrderIds);
  const previousCaseId = currentOrder.billing_case_id;
  await client.query(
    `UPDATE orders SET trigger_status = 'INVOICED', billing_case_id = NULL
     WHERE id = ANY($1::bigint[])`,
    [matchedOrderIds],
  );
  if (previousCaseId) {
    const remaining = await client.query<{ count: string }>(
      `SELECT count(*) FROM orders WHERE billing_case_id = $1`,
      [previousCaseId],
    );
    if (Number(remaining.rows[0]!.count) === 0) {
      await client.query(
        `DELETE FROM documents WHERE billing_case_id = $1 AND kind = 'INVOICE' AND status = 'DRAFT'`,
        [previousCaseId],
      );
      await client.query(
        `UPDATE billing_cases SET status = 'CLOSED', revision = revision + 1, updated_at = now()
         WHERE id = $1 AND status IN ('DRAFT', 'READY', 'NEEDS_REVIEW')`,
        [previousCaseId],
      );
    } else {
      await regenerateResidualInvoiceDraft(client, previousCaseId);
      await client.query(
        `UPDATE billing_cases SET revision = revision + 1, updated_at = now()
         WHERE id = $1 AND status IN ('DRAFT', 'READY', 'NEEDS_REVIEW')`,
        [previousCaseId],
      );
    }
  }
  await client.query(
    `UPDATE aruba_document_matches SET document_id = $2, billing_case_id =
       (SELECT billing_case_id FROM documents WHERE id = $2), updated_at = now()
     WHERE remote_document_id = $1`,
    [remote.id, documentId],
  );
  await client.query(`UPDATE aruba_remote_documents SET origin = 'ARUBA_EXTERNAL' WHERE id = $1`, [
    remote.id,
  ]);
  return documentId;
}

async function materializeExternalCreditNote(
  client: pg.PoolClient,
  remote: LockedRemoteMatch,
  storageObjectId: string,
  xml: string,
) {
  if (
    !remote.order_id ||
    !remote.related_invoice_document_id ||
    remote.match_status !== "MATCHED"
  ) {
    return null;
  }
  const imported = acceptedCreditNoteFromXml(xml);
  const identity = acceptedDocumentFiscalIdentity(xml);
  const profile = await activeFiscalProfile(client);
  if (
    !profile ||
    !remoteFiscalIdentityMatches(remote, identity) ||
    !acceptedProfileMatches(profile.profile, identity)
  ) {
    throw new AppError("ARUBA_PROFILE_CONFLICT", 409);
  }
  await serializeOrderMutations(client);
  const invoice = await client.query<{
    id: string;
    billing_case_id: string;
    series: string;
    fiscal_year: number;
    fiscal_number: number;
    document_date: string;
    recipient_snapshot_json: unknown;
  }>(
    `SELECT id, billing_case_id, series, fiscal_year, fiscal_number,
            document_date::text, recipient_snapshot_json
     FROM documents WHERE id = $1 AND kind = 'INVOICE' AND status = 'APPROVED' FOR UPDATE`,
    [remote.related_invoice_document_id],
  );
  const sourceInvoice = invoice.rows[0];
  if (!sourceInvoice) throw new AppError("ARUBA_PROFILE_CONFLICT", 409);
  const invoiceLabel = `${sourceInvoice.series} ${String(sourceInvoice.fiscal_number).padStart(4, "0")}/${String(sourceInvoice.fiscal_year).slice(-2)}`;
  if (
    imported.linkedInvoices.length > 0 &&
    !imported.linkedInvoices.some(
      (linked) =>
        linked.number === invoiceLabel &&
        (!linked.date || linked.date === sourceInvoice.document_date),
    )
  ) {
    throw new AppError("ARUBA_PROFILE_CONFLICT", 409);
  }
  if (!remote.refund_ids.length) throw new AppError("ARUBA_PROFILE_CONFLICT", 409);
  const refunds = await client.query<{
    id: string;
    amount: number;
    order_id: string;
    credit_document_id: string | null;
  }>(
    `SELECT refunds.id, refunds.amount, refunds.order_id, refunds.credit_document_id
     FROM refunds
     JOIN document_orders AS invoice_order
       ON invoice_order.document_id = $2 AND invoice_order.document_kind = 'INVOICE'
      AND invoice_order.order_id = refunds.order_id
     WHERE refunds.id = ANY($1::bigint[]) AND refunds.status = 'COMPLETED'
       AND refunds.amount > 0
     ORDER BY refunds.id FOR UPDATE OF refunds`,
    [remote.refund_ids, sourceInvoice.id],
  );
  const refundTotal = refunds.rows.reduce((sum, refund) => sum + refund.amount, 0);
  const assignedDraftIds = [
    ...new Set(refunds.rows.flatMap((refund) => refund.credit_document_id ?? [])),
  ];
  let assignedDocumentId: string | null = null;
  if (assignedDraftIds.length === 1) {
    const assignedDocument = await client.query<{ id: string }>(
      `SELECT documents.id FROM documents
       JOIN document_links ON document_links.document_id = documents.id
       WHERE documents.id = $1 AND documents.kind = 'CREDIT_NOTE'
         AND documents.status IN ('DRAFT', 'APPROVED')
         AND document_links.related_document_id = $2
         AND document_links.relation_type = 'CREDIT_NOTE_FOR_INVOICE'
       FOR UPDATE OF documents`,
      [assignedDraftIds[0], sourceInvoice.id],
    );
    assignedDocumentId = assignedDocument.rows[0]?.id ?? null;
  }
  if (
    refunds.rowCount !== remote.refund_ids.length ||
    refundTotal !== imported.totalAmount ||
    assignedDraftIds.length > 1 ||
    (assignedDraftIds.length === 1 && !assignedDocumentId)
  ) {
    throw new AppError("ARUBA_PROFILE_CONFLICT", 409);
  }
  const digest = createHash("sha256").update(xml).digest("hex");
  const existing = await client.query<{
    id: string;
    origin: string;
    xml_sha256: string;
  }>(
    `SELECT id, origin, xml_sha256 FROM documents
     WHERE series = $1 AND fiscal_year = $2 AND fiscal_number = $3 FOR UPDATE`,
    [profile.profile.series, imported.year, imported.number],
  );
  let documentId = existing.rows[0]?.id ?? assignedDocumentId;
  if (existing.rows[0] && existing.rows[0].xml_sha256 !== digest) {
    throw new AppError("ARUBA_INVENTORY_CONFLICT", 409);
  }
  if (existing.rows[0] && assignedDocumentId && existing.rows[0].id !== assignedDocumentId) {
    throw new AppError("ARUBA_INVENTORY_CONFLICT", 409);
  }
  if (documentId && existing.rows[0]?.origin === "HUB") {
    const localLink = await client.query<{ order_id: string }>(
      `SELECT order_id FROM document_orders
       WHERE document_id = $1 AND document_kind = 'CREDIT_NOTE' FOR UPDATE`,
      [documentId],
    );
    const matchedOrderIds = new Set(refunds.rows.map((refund) => refund.order_id));
    if (
      localLink.rows.length !== matchedOrderIds.size ||
      localLink.rows.some((row) => !matchedOrderIds.has(row.order_id))
    ) {
      throw new AppError("ARUBA_INVENTORY_CONFLICT", 409);
    }
    await client.query(
      `UPDATE aruba_document_matches SET document_id = $2, updated_at = now()
       WHERE remote_document_id = $1`,
      [remote.id, documentId],
    );
    await client.query(
      `UPDATE aruba_remote_documents SET origin = 'HUB_SUBMISSION' WHERE id = $1`,
      [remote.id],
    );
    return documentId;
  }
  const shouldAdoptDraft = !existing.rows[0];
  if (!documentId) {
    const draft = await client.query<{ id: string }>(
      `INSERT INTO documents
        (billing_case_id, kind, status, document_type, series, document_date,
         fiscal_profile_version, currency, total_amount, source_total_amount,
         difference_amount, draft_version, projection_sha256, payment_status,
         payment_method, recipient_snapshot_json)
       VALUES ($1, 'CREDIT_NOTE', 'DRAFT', 'TD04', $2, $3, $4, 'EUR', $5, $5,
         0, 1, $6, 'PAID', $7, $8) RETURNING id`,
      [
        sourceInvoice.billing_case_id,
        profile.profile.series,
        imported.documentDate,
        profile.version,
        imported.totalAmount,
        digest,
        identity.payment.method,
        JSON.stringify(sourceInvoice.recipient_snapshot_json),
      ],
    );
    documentId = draft.rows[0]!.id;
    await client.query(
      `INSERT INTO document_links (document_id, related_document_id, relation_type)
       VALUES ($1, $2, 'CREDIT_NOTE_FOR_INVOICE')`,
      [documentId, sourceInvoice.id],
    );
    await client.query(
      `INSERT INTO document_orders (document_id, document_kind, order_id, amount)
       SELECT $1, 'CREDIT_NOTE', refunds.order_id, sum(refunds.amount)::integer
       FROM refunds WHERE refunds.id = ANY($2::bigint[])
       GROUP BY refunds.order_id`,
      [documentId, refunds.rows.map((refund) => refund.id)],
    );
    await client.query(
      `UPDATE refunds SET credit_document_id = $2, updated_at = now()
       WHERE id = ANY($1::bigint[])
         AND (credit_document_id IS NULL OR credit_document_id = $2)`,
      [refunds.rows.map((refund) => refund.id), documentId],
    );
  }
  if (shouldAdoptDraft) {
    const linkedOrders = await client.query<{
      order_id: string;
      amount: number;
    }>(
      `SELECT order_id, amount FROM document_orders
       WHERE document_id = $1 AND document_kind = 'CREDIT_NOTE' FOR UPDATE`,
      [documentId],
    );
    const matchedOrderIds = new Set(refunds.rows.map((refund) => refund.order_id));
    if (
      linkedOrders.rows.length !== matchedOrderIds.size ||
      linkedOrders.rows.some((row) => !matchedOrderIds.has(row.order_id)) ||
      linkedOrders.rows.reduce((sum, row) => sum + row.amount, 0) !== imported.totalAmount
    ) {
      throw new AppError("ARUBA_PROFILE_CONFLICT", 409);
    }
    const snapshot = {
      generatorVersion: 2,
      kind: "CREDIT_NOTE",
      documentDate: imported.documentDate,
      recipient: sourceInvoice.recipient_snapshot_json,
      lines: imported.lines.map((line) => ({
        ...line,
        orderId: remote.order_id,
      })),
      paymentStatus: "PAID",
      paymentMethod: identity.payment.method,
      relatedInvoice: {
        number: invoiceLabel,
        date: sourceInvoice.document_date,
      },
      sourceTotal: imported.totalAmount,
      total: imported.totalAmount,
      difference: 0,
      differenceReason: null,
    };
    await client.query(
      `UPDATE documents SET status = 'APPROVED', origin = 'ARUBA_HISTORY',
         fiscal_year = $2, fiscal_number = $3, document_date = $4,
         approved_at = coalesce(approved_at, now()), xml_sha256 = $5,
         immutable_snapshot_json = $6, fiscal_profile_snapshot_json = $7,
         storage_object_id = $8, payment_method = $9, updated_at = now()
       WHERE id = $1`,
      [
        documentId,
        imported.year,
        imported.number,
        imported.documentDate,
        digest,
        JSON.stringify(snapshot),
        JSON.stringify(profile.profile),
        storageObjectId,
        identity.payment.method,
      ],
    );
  }
  await client.query(
    `UPDATE aruba_document_matches SET document_id = $2, updated_at = now()
     WHERE remote_document_id = $1`,
    [remote.id, documentId],
  );
  await client.query(`UPDATE aruba_remote_documents SET origin = 'ARUBA_EXTERNAL' WHERE id = $1`, [
    remote.id,
  ]);
  return documentId;
}

export async function materializeMatchedExternalDocument(
  client: pg.PoolClient,
  remoteDocumentId: string,
  storageObjectId: string,
  xml: string,
) {
  const remote = await lockedRemoteMatch(client, remoteDocumentId);
  if (!remote || !isEmissionConfirmed(remote.remote_status)) return null;
  if (remote.match_method === "MANUAL" && remote.match_status === "UNMATCHED") return null;
  let identity: ReturnType<typeof acceptedDocumentFiscalIdentity>;
  try {
    identity = acceptedDocumentFiscalIdentity(xml);
  } catch {
    await markRemoteProfileConflict(client, remote);
    return null;
  }
  const profile = await activeFiscalProfile(client);
  if (!profile || !acceptedProfileMatches(profile.profile, identity)) {
    await markRemoteProfileConflict(client, remote);
    return null;
  }
  return remote.document_type === "TD01"
    ? materializeExternalInvoice(client, remote, storageObjectId, xml)
    : materializeExternalCreditNote(client, remote, storageObjectId, xml);
}

export async function loadLatestOfficialXml(client: pg.PoolClient, remoteDocumentId: string) {
  const official = await client.query<{
    id: string;
    storage_object_id: string;
    relative_path: string;
    sha256: string;
    size_bytes: number;
  }>(
    `SELECT files.id, files.storage_object_id, storage.relative_path, storage.sha256,
            storage.size_bytes
     FROM aruba_files AS files
     JOIN storage_objects AS storage ON storage.id = files.storage_object_id
     WHERE files.remote_document_id = $1 AND files.kind = 'ARUBA_XML'
     ORDER BY files.imported_at DESC LIMIT 1`,
    [remoteDocumentId],
  );
  const file = official.rows[0];
  if (!file) return null;
  if (file.size_bytes > ARUBA_IMPORT_MAX_BYTES) {
    throw new AppError("ARUBA_IMPORT_INVALID", 409);
  }
  const root = path.resolve(getConfig().DOCUMENT_STORAGE_ROOT);
  const absolutePath = path.resolve(root, file.relative_path);
  if (!absolutePath.startsWith(`${root}${path.sep}`)) {
    throw new AppError("DOCUMENT_STORAGE_FAILED", 500);
  }
  const bytes = await readFile(absolutePath);
  if (
    bytes.byteLength !== file.size_bytes ||
    createHash("sha256").update(bytes).digest("hex") !== file.sha256
  ) {
    throw new AppError("DOCUMENT_STORAGE_FAILED", 500);
  }
  return {
    fileId: file.id,
    storageObjectId: file.storage_object_id,
    xml: validateUntrustedXml(bytes),
  };
}

export async function materializeLatestOfficialXml(
  client: pg.PoolClient,
  remoteDocumentId: string,
  required = false,
) {
  const official = await loadLatestOfficialXml(client, remoteDocumentId);
  if (!official) {
    if (required) throw new AppError("ARUBA_IMPORT_INVALID", 409);
    return null;
  }
  const documentId = await materializeMatchedExternalDocument(
    client,
    remoteDocumentId,
    official.storageObjectId,
    official.xml,
  );
  if (documentId) {
    await client.query(`UPDATE aruba_files SET document_id = $2 WHERE id = $1`, [
      official.fileId,
      documentId,
    ]);
  }
  return documentId;
}

export async function reconcileAutomaticAmbiguousInvoices(
  client: pg.PoolClient,
  touchedRemoteDocumentIds: string[],
) {
  if (!touchedRemoteDocumentIds.length) return [];
  const result = await client.query<
    Omit<AmbiguousInvoiceMatch, "candidates"> & {
      candidates: AmbiguousInvoiceCandidate[];
    }
  >(
    `SELECT remote.id::text AS "remoteId", remote.fiscal_year AS "fiscalYear",
            remote.series, remote.fiscal_number AS "fiscalNumber",
            remote.document_date::text AS "documentDate", remote.total_amount AS "totalAmount",
            remote.recipient_name_normalized AS "recipientName",
            remote.recipient_tax_id_normalized AS "recipientTaxId",
            coalesce((
              SELECT jsonb_agg(candidate || jsonb_build_object(
                'displayNumber', orders.display_number,
                'localOrderDate', orders.local_order_date::text
              ) ORDER BY orders.local_order_date, orders.display_number, orders.id)
              FROM jsonb_array_elements(matches.candidates_json) candidate
              JOIN orders ON orders.id::text = candidate ->> 'candidateId'
              WHERE coalesce((candidate ->> 'compatible')::boolean, false)
                AND jsonb_array_length(coalesce(candidate -> 'orderIds', '[]')) = 1
                AND NOT EXISTS (
                  SELECT 1 FROM aruba_document_matches claimed
                  WHERE claimed.status = 'MATCHED' AND claimed.order_id = orders.id
                    AND claimed.remote_document_id <> remote.id
                )
            ), '[]') AS candidates
     FROM aruba_document_matches matches
     JOIN aruba_remote_documents remote ON remote.id = matches.remote_document_id
     WHERE matches.status = 'AMBIGUOUS' AND matches.method = 'NONE'
       AND remote.document_type = 'TD01'
       AND remote.remote_status IN ('DELIVERED', 'NOT_DELIVERED')
       AND remote.series IS NOT NULL AND remote.fiscal_number IS NOT NULL
       AND remote.recipient_name_normalized IS NOT NULL
       AND remote.recipient_tax_id_normalized IS NOT NULL
       AND EXISTS (SELECT 1 FROM aruba_files files
         WHERE files.remote_document_id = remote.id AND files.kind = 'ARUBA_XML')
       AND NOT EXISTS (
         SELECT 1
         FROM aruba_document_matches sibling_matches
         JOIN aruba_remote_documents sibling
           ON sibling.id = sibling_matches.remote_document_id
         WHERE sibling.id <> remote.id
           AND sibling_matches.status = 'AMBIGUOUS' AND sibling_matches.method = 'NONE'
           AND sibling.document_type = 'TD01'
           AND sibling.fiscal_year = remote.fiscal_year
           AND lower(btrim(sibling.series)) = lower(btrim(remote.series))
           AND sibling.document_date = remote.document_date
           AND sibling.total_amount = remote.total_amount
           AND sibling.recipient_name_normalized = remote.recipient_name_normalized
           AND sibling.recipient_tax_id_normalized = remote.recipient_tax_id_normalized
           AND NOT EXISTS (SELECT 1 FROM aruba_files sibling_files
             WHERE sibling_files.remote_document_id = sibling.id
               AND sibling_files.kind = 'ARUBA_XML')
       )`,
  );
  const touched = new Set(touchedRemoteDocumentIds);
  const fingerprint = (entry: AmbiguousInvoiceMatch) =>
    JSON.stringify([
      entry.fiscalYear,
      normalizedMatchText(entry.series),
      entry.documentDate,
      entry.totalAmount,
      normalizedMatchText(entry.recipientName),
      normalizedMatchText(entry.recipientTaxId),
    ]);
  const touchedFingerprints = new Set<string>();
  for (const entry of result.rows) {
    if (touched.has(entry.remoteId)) touchedFingerprints.add(fingerprint(entry));
  }
  const entries = result.rows.filter((entry) => touchedFingerprints.has(fingerprint(entry)));
  const matches = selectAutomaticAmbiguousInvoiceMatches(entries);
  const materialized: string[] = [];
  for (const match of matches) {
    // react-doctor-disable-next-line react-doctor/async-await-in-loop -- La coorte viene riservata e materializzata sotto lo stesso lock inventario.
    const updated = await client.query<{ id: string }>(
      `UPDATE aruba_document_matches matches SET
         status = 'MATCHED', method = 'AUTOMATIC', order_id = $2,
         billing_case_id = (SELECT billing_case_id FROM orders WHERE id = $2),
         signals_json = matches.signals_json || '{"automaticAmbiguousCohort":true}'::jsonb,
         updated_at = now()
       WHERE matches.remote_document_id = $1 AND matches.status = 'AMBIGUOUS'
         AND matches.method = 'NONE'
         AND EXISTS (
           SELECT 1 FROM jsonb_array_elements(matches.candidates_json) candidate
           WHERE candidate ->> 'candidateId' = $2
             AND coalesce((candidate ->> 'compatible')::boolean, false)
         )
         AND NOT EXISTS (
           SELECT 1 FROM aruba_document_matches claimed
           WHERE claimed.status = 'MATCHED' AND claimed.order_id = $2
             AND claimed.remote_document_id <> matches.remote_document_id
         )
       RETURNING matches.remote_document_id::text AS id`,
      [match.remoteId, match.candidateId],
    );
    if (!updated.rows[0]) throw new AppError("ARUBA_INVENTORY_CONFLICT", 409);
    // react-doctor-disable-next-line react-doctor/async-await-in-loop -- Ogni XML ufficiale deve chiudere la propria transazione fiscale prima del successivo.
    const documentId = await materializeLatestOfficialXml(client, match.remoteId, true);
    if (!documentId) throw new AppError("ARUBA_INVENTORY_CONFLICT", 409);
    materialized.push(documentId);
  }
  return materialized;
}
