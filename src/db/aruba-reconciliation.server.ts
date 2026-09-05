import type pg from "pg";

import {
  ARUBA_MATCHER_VERSION,
  groupOrderCandidates,
  isArubaAmountMismatchCandidate,
  normalizedMatchText,
  selectOrderMatch,
  type ArubaOrderCandidate,
  type CandidateEvaluation,
  type RemoteInventoryDocument,
} from "../aruba-inbound.ts";
import {
  arubaOrderCandidateFromSource,
  type ArubaOrderCandidateSource,
} from "../aruba-order-candidate.ts";
import {
  arubaAccountReference as accountReference,
  arubaRuntimeEnvironment as environment,
} from "./aruba-inventory-context.server.ts";
import { effectiveApprovedInvoiceSql } from "./billing-case-sql.server.ts";
import { recomputeBillingCaseStatus } from "./billing-case-status.server.ts";

interface InboundOrderCandidateRow extends ArubaOrderCandidateSource {
  invoice_document_id: string | null;
  refund_ids: string[];
  refund_amounts: number[];
  refund_dates: string[];
}

function uniqueRefundSubset(
  refunds: Array<{ id: string; amount: number }>,
  target: number,
): { status: "UNIQUE"; ids: string[] } | { status: "AMBIGUOUS" } | { status: "NONE" } {
  const sums = new Map<number, string[] | null>([[0, []]]);
  for (const refund of refunds.slice(0, 100)) {
    for (const [sum, selected] of [...sums.entries()].toReversed()) {
      if (sum + refund.amount > target) continue;
      const next = sum + refund.amount;
      if (selected === null) {
        sums.set(next, null);
        continue;
      }
      const candidate = [...selected, refund.id];
      if (!sums.has(next)) sums.set(next, candidate);
      else if (JSON.stringify(sums.get(next)) !== JSON.stringify(candidate)) sums.set(next, null);
    }
  }
  const selected = sums.get(target);
  return selected === undefined
    ? { status: "NONE" }
    : selected === null
      ? { status: "AMBIGUOUS" }
      : { status: "UNIQUE", ids: selected };
}

export async function arubaOrderCandidates(client: pg.PoolClient, remote: RemoteInventoryDocument) {
  const normalizedOrderReferences = remote.orderReferences
    .map(normalizedMatchText)
    .filter((reference): reference is string => Boolean(reference));
  // react-doctor-disable-next-line react-doctor/raw-sql-injection-risk -- Il predicato interpolato è una costante SQL interna senza input esterno.
  const result = await client.query<InboundOrderCandidateRow>(
    `SELECT orders.id, orders.provider, orders.display_number, orders.local_order_date::text,
            orders.billing_case_id, invoice.document_id::text AS invoice_document_id,
            '{}'::text[] AS refund_ids, '{}'::integer[] AS refund_amounts,
            '{}'::text[] AS refund_dates,
            (orders.gross_amount - orders.deducted_shopify_payments_fee_amount - coalesce((
              SELECT sum(refunds.amount) FROM refunds
              WHERE refunds.order_id = orders.id AND refunds.status = 'COMPLETED'
                AND refunds.amount > 0 AND refunds.completed_at IS NOT NULL
                AND (refunds.completed_at AT TIME ZONE 'Europe/Rome')::date < $1::date
            ), 0))::integer AS billable_amount,
            EXISTS (
              SELECT 1 FROM refunds
              WHERE refunds.order_id = orders.id AND refunds.status = 'COMPLETED'
                AND refunds.amount > 0 AND (
                  refunds.completed_at IS NULL OR
                  (refunds.completed_at AT TIME ZONE 'Europe/Rome')::date = $1::date
                )
            ) AS refund_timing_ambiguous,
            EXISTS (
              SELECT 1 FROM payments
              WHERE payments.order_id = orders.id AND payments.status = 'PAID'
                AND (payments.paid_at AT TIME ZONE 'Europe/Rome')::date = $1::date
                AND (lower(payments.method) LIKE '%bonifico%'
                  OR lower(payments.method) LIKE '%bank%transfer%')
            ) AS bank_transfer_paid_on_document_date,
            coalesce(nullif(billing_cases.customer_snapshot_json ->> 'displayName', ''),
              customers.display_name) AS recipient_name,
            coalesce(billing_cases.customer_snapshot_json -> 'taxIdentifiers',
              (SELECT jsonb_agg(jsonb_build_object(
                        'type', order_tax_identifiers.type,
                        'countryCode', coalesce(order_tax_identifiers.country_code,
                          orders.normalized_snapshot_json #>> '{customerSnapshot,billingAddress,countryCode}'),
                        'value', order_tax_identifiers.normalized_value))
                      FROM order_tax_identifiers WHERE order_tax_identifiers.order_id = orders.id),
              '[]')
              AS recipient_tax_identifiers,
            coalesce(billing_cases.customer_snapshot_json #>> '{billingAddress,countryCode}',
              orders.normalized_snapshot_json #>> '{customerSnapshot,billingAddress,countryCode}')
              AS recipient_country_code,
            concat_ws(' ',
              coalesce(billing_cases.customer_snapshot_json #>> '{billingAddress,line1}',
                orders.normalized_snapshot_json #>> '{customerSnapshot,billingAddress,line1}'),
              coalesce(billing_cases.customer_snapshot_json #>> '{billingAddress,postalCode}',
                orders.normalized_snapshot_json #>> '{customerSnapshot,billingAddress,postalCode}'),
              coalesce(billing_cases.customer_snapshot_json #>> '{billingAddress,city}',
                orders.normalized_snapshot_json #>> '{customerSnapshot,billingAddress,city}'),
              coalesce(billing_cases.customer_snapshot_json #>> '{billingAddress,countryCode}',
                orders.normalized_snapshot_json #>> '{customerSnapshot,billingAddress,countryCode}')
            ) AS recipient_address
     FROM orders
     JOIN customers ON customers.id = orders.customer_id
     LEFT JOIN billing_cases ON billing_cases.id = orders.billing_case_id
     LEFT JOIN LATERAL (
       SELECT document_orders.document_id
       FROM document_orders JOIN documents ON documents.id = document_orders.document_id
       WHERE document_orders.order_id = orders.id AND document_orders.document_kind = 'INVOICE'
         AND ${effectiveApprovedInvoiceSql("documents")}
       ORDER BY documents.id DESC LIMIT 1
     ) AS invoice ON true
     WHERE (
         orders.local_order_date BETWEEN $1::date - 31 AND $1::date + 31
         OR regexp_replace(upper(orders.display_number), '[^A-Z0-9]', '', 'g')
           = ANY($2::text[])
       )
       AND orders.trigger_status NOT IN ('CANCELLED_NO_DOCUMENT', 'REFUNDED_BEFORE_ISSUE')
     ORDER BY orders.id`,
    [remote.documentDate, normalizedOrderReferences],
  );
  return result.rows;
}

async function creditNoteCandidates(client: pg.PoolClient, remote: RemoteInventoryDocument) {
  // react-doctor-disable-next-line react-doctor/raw-sql-injection-risk -- Il predicato interpolato è una costante SQL interna senza input esterno.
  const result = await client.query<InboundOrderCandidateRow>(
    `SELECT orders.id, orders.provider, orders.display_number,
            coalesce(refundable.refund_date, invoice.document_date)::text AS local_order_date,
            orders.billing_case_id, invoice.document_id::text AS invoice_document_id,
            refundable.amount::integer AS billable_amount, refundable.refund_ids,
            refundable.refund_amounts, refundable.refund_dates,
            false AS refund_timing_ambiguous,
            false AS bank_transfer_paid_on_document_date,
            customers.display_name AS recipient_name,
            coalesce((SELECT jsonb_agg(jsonb_build_object(
                        'type', order_tax_identifiers.type,
                        'countryCode', coalesce(order_tax_identifiers.country_code,
                          orders.normalized_snapshot_json #>> '{customerSnapshot,billingAddress,countryCode}'),
                        'value', order_tax_identifiers.normalized_value))
                      FROM order_tax_identifiers WHERE order_tax_identifiers.order_id = orders.id), '[]')
              AS recipient_tax_identifiers,
            orders.normalized_snapshot_json #>> '{customerSnapshot,billingAddress,countryCode}'
              AS recipient_country_code,
            concat_ws(' ',
              orders.normalized_snapshot_json #>> '{customerSnapshot,billingAddress,line1}',
              orders.normalized_snapshot_json #>> '{customerSnapshot,billingAddress,postalCode}',
              orders.normalized_snapshot_json #>> '{customerSnapshot,billingAddress,city}',
              orders.normalized_snapshot_json #>> '{customerSnapshot,billingAddress,countryCode}'
            ) AS recipient_address
     FROM orders
     JOIN customers ON customers.id = orders.customer_id
     JOIN LATERAL (
       SELECT document_orders.document_id, documents.document_date
       FROM document_orders JOIN documents ON documents.id = document_orders.document_id
       WHERE document_orders.order_id = orders.id AND document_orders.document_kind = 'INVOICE'
         AND ${effectiveApprovedInvoiceSql("documents")}
       ORDER BY documents.id DESC LIMIT 1
     ) AS invoice ON true
     JOIN LATERAL (
       SELECT sum(refunds.amount)::integer AS amount,
              max(refunds.completed_at)::date AS refund_date,
              array_agg(refunds.id::text ORDER BY refunds.id) AS refund_ids,
              array_agg(refunds.amount::integer ORDER BY refunds.id) AS refund_amounts,
              array_agg(refunds.completed_at::date::text ORDER BY refunds.id) AS refund_dates
       FROM refunds
       WHERE refunds.order_id = orders.id AND refunds.status = 'COMPLETED'
         AND NOT refunds.applied_before_issue AND refunds.amount > 0
         AND refunds.completed_at::date BETWEEN $1::date - 31 AND $1::date AND (
           refunds.credit_document_id IS NULL OR EXISTS (
             SELECT 1 FROM documents credit
             WHERE credit.id = refunds.credit_document_id
               AND credit.kind = 'CREDIT_NOTE' AND (
                 credit.status = 'DRAFT' OR (
                   credit.status = 'APPROVED' AND credit.document_type = 'TD04'
                   AND credit.fiscal_year = $2
                   AND lower(btrim(credit.series)) = lower(btrim($3))
                   AND credit.fiscal_number = CASE
                     WHEN $4 ~ '^[0-9]+$' THEN $4::integer
                   END
                   AND credit.total_amount = $5
                 )
               )
           )
         )
     ) AS refundable ON refundable.amount > 0
     WHERE coalesce(refundable.refund_date, invoice.document_date)
       BETWEEN $1::date - 31 AND $1::date + 31
     ORDER BY orders.id`,
    [
      remote.documentDate,
      remote.fiscalYear,
      remote.series,
      remote.fiscalNumber,
      remote.totalAmount,
    ],
  );
  return result.rows;
}

async function submittedCreditNoteCandidates(client: pg.PoolClient, documentId: string) {
  const result = await client.query<InboundOrderCandidateRow>(
    `SELECT orders.id, orders.provider, orders.display_number,
            max(refunds.completed_at)::date::text AS local_order_date,
            orders.billing_case_id, links.related_document_id::text AS invoice_document_id,
            sum(refunds.amount)::integer AS billable_amount,
            array_agg(refunds.id::text ORDER BY refunds.id) AS refund_ids,
            array_agg(refunds.amount::integer ORDER BY refunds.id) AS refund_amounts,
            array_agg(refunds.completed_at::date::text ORDER BY refunds.id) AS refund_dates,
            false AS refund_timing_ambiguous,
            false AS bank_transfer_paid_on_document_date,
            customers.display_name AS recipient_name,
            coalesce((SELECT jsonb_agg(jsonb_build_object(
                        'type', order_tax_identifiers.type,
                        'countryCode', coalesce(order_tax_identifiers.country_code,
                          orders.normalized_snapshot_json #>> '{customerSnapshot,billingAddress,countryCode}'),
                        'value', order_tax_identifiers.normalized_value))
                      FROM order_tax_identifiers WHERE order_tax_identifiers.order_id = orders.id), '[]')
              AS recipient_tax_identifiers,
            orders.normalized_snapshot_json #>> '{customerSnapshot,billingAddress,countryCode}'
              AS recipient_country_code,
            concat_ws(' ',
              orders.normalized_snapshot_json #>> '{customerSnapshot,billingAddress,line1}',
              orders.normalized_snapshot_json #>> '{customerSnapshot,billingAddress,postalCode}',
              orders.normalized_snapshot_json #>> '{customerSnapshot,billingAddress,city}',
              orders.normalized_snapshot_json #>> '{customerSnapshot,billingAddress,countryCode}'
            ) AS recipient_address
     FROM document_orders
     JOIN orders ON orders.id = document_orders.order_id
     JOIN customers ON customers.id = orders.customer_id
     JOIN refunds ON refunds.order_id = orders.id AND refunds.credit_document_id = $1
       AND refunds.status = 'COMPLETED' AND NOT refunds.applied_before_issue
     JOIN document_links AS links ON links.document_id = $1
       AND links.relation_type = 'CREDIT_NOTE_FOR_INVOICE'
     WHERE document_orders.document_id = $1 AND document_orders.document_kind = 'CREDIT_NOTE'
     GROUP BY orders.id, orders.provider, orders.display_number, orders.billing_case_id,
              links.related_document_id, customers.display_name, orders.normalized_snapshot_json
     ORDER BY orders.id`,
    [documentId],
  );
  return result.rows;
}

interface SubmittedDocument {
  id: string;
  document_type: "TD01" | "TD04";
  fiscal_year: number;
  series: string;
  fiscal_number: number;
  document_date: string;
  total_amount: number;
}

async function submittedDocumentForRemote(client: pg.PoolClient, remote: RemoteInventoryDocument) {
  const result = await client.query<SubmittedDocument>(
    `SELECT documents.id, documents.document_type, documents.fiscal_year, documents.series,
            documents.fiscal_number, documents.document_date::text, documents.total_amount
     FROM aruba_submissions
     JOIN documents ON documents.id = aruba_submissions.document_id
     JOIN aruba_batches ON aruba_batches.id = aruba_submissions.batch_id
     WHERE aruba_submissions.remote_id = $1 AND aruba_submissions.environment = $2
       AND aruba_batches.account_reference = $3 AND aruba_submissions.status <> 'REMOVED'
       AND documents.status = 'APPROVED'
     ORDER BY aruba_submissions.id DESC LIMIT 1`,
    [remote.remoteId, environment(), accountReference()],
  );
  return result.rows[0] ?? null;
}

function submittedDocumentMatchesRemote(
  submitted: SubmittedDocument,
  remote: RemoteInventoryDocument,
) {
  return (
    submitted.document_type === remote.documentType &&
    submitted.fiscal_year === remote.fiscalYear &&
    normalizedMatchText(submitted.series) === normalizedMatchText(remote.series) &&
    submitted.fiscal_number === Number(remote.fiscalNumber) &&
    submitted.document_date === remote.documentDate &&
    submitted.total_amount === remote.totalAmount
  );
}

export async function reconcileRemoteDocument(
  client: pg.PoolClient,
  remoteId: string,
  remote: RemoteInventoryDocument,
  official = false,
) {
  const previous = await client.query<{
    method: string;
    signals_json: Record<string, unknown>;
    status: string;
    billing_case_id: string | null;
    candidates_json: Array<{
      candidateId?: string;
      orderIds?: string[];
      potential?: boolean;
      compatible?: boolean;
      reviewable?: boolean;
      issuedInvoiceDocumentId?: string | null;
      signals?: Partial<CandidateEvaluation["signals"]>;
    }>;
  }>(
    `SELECT method, status, billing_case_id::text, candidates_json, signals_json
     FROM aruba_document_matches WHERE remote_document_id = $1 FOR UPDATE`,
    [remoteId],
  );
  const collision = await client.query(
    `SELECT 1 FROM aruba_remote_documents remote
     JOIN aruba_deduplication_conflicts conflicts
       ON conflicts.environment = remote.environment
      AND conflicts.account_reference = remote.account_reference
      AND (conflicts.existing_remote_document_id = remote.id
        OR conflicts.incoming_remote_id = remote.remote_id)
     WHERE remote.id = $1 AND conflicts.resolved_at IS NULL LIMIT 1`,
    [remoteId],
  );
  const identityCollision = Boolean(collision.rows[0]);
  const submitted = await submittedDocumentForRemote(client, remote);
  const submittedMatches = Boolean(submitted && submittedDocumentMatchesRemote(submitted, remote));
  const candidates =
    remote.documentType === "TD04"
      ? await creditNoteCandidates(client, remote)
      : await arubaOrderCandidates(client, remote);
  if (remote.documentType === "TD04" && submitted?.document_type === "TD04" && submittedMatches) {
    candidates.push(...(await submittedCreditNoteCandidates(client, submitted.id)));
  }
  const individualCandidates = candidates.map((candidate) => {
    const refundSubset =
      remote.documentType === "TD04"
        ? uniqueRefundSubset(
            candidate.refund_ids.map((id, index) => ({
              id,
              amount: candidate.refund_amounts[index] ?? 0,
            })),
            remote.totalAmount,
          )
        : { status: "UNIQUE" as const, ids: [] };
    const selectedRefundIds = new Set(refundSubset.status === "UNIQUE" ? refundSubset.ids : []);
    return {
      ...candidate,
      selected_refund_ids: refundSubset.status === "UNIQUE" ? refundSubset.ids : null,
      selected_refund_date:
        refundSubset.status === "UNIQUE"
          ? candidate.refund_dates
              .filter((_, index) => selectedRefundIds.has(candidate.refund_ids[index]!))
              .toSorted()
              .at(-1)
          : null,
      refund_subset_ambiguous: refundSubset.status === "AMBIGUOUS",
      match_amount:
        remote.documentType === "TD04" && refundSubset.status !== "NONE"
          ? remote.totalAmount
          : remote.documentType === "TD04"
            ? remote.totalAmount + 1
            : candidate.billable_amount,
    };
  });
  const evaluatedCandidates: Array<{
    source: InboundOrderCandidateRow & {
      selected_refund_ids?: string[] | null;
      selected_refund_date?: string | null;
      refund_subset_ambiguous?: boolean;
      match_amount?: number;
    };
    matchCandidate: ArubaOrderCandidate & { billingCaseId?: string | null };
  }> = individualCandidates.map((candidate) => ({
    source: candidate,
    matchCandidate: arubaOrderCandidateFromSource(candidate, {
      billingCaseId: remote.documentType === "TD01" ? candidate.billing_case_id : null,
      billableAmount: candidate.match_amount,
    }),
  }));
  for (const candidate of evaluatedCandidates) {
    if (candidate.source.selected_refund_date) {
      candidate.matchCandidate.localOrderDate = candidate.source.selected_refund_date;
    }
  }
  const matchCandidates = evaluatedCandidates.map((candidate) => candidate.matchCandidate);
  const candidatesById = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const groupedOrderCandidates = groupOrderCandidates(matchCandidates).filter(
    (candidate) => (candidate.orderIds?.length ?? 1) > 1,
  );
  if (remote.documentType === "TD01") {
    for (const grouped of groupedOrderCandidates) {
      const anchor = candidatesById.get(grouped.id)!;
      evaluatedCandidates.push({ source: anchor, matchCandidate: grouped });
    }
  } else {
    const byInvoice = new Map<string, InboundOrderCandidateRow[]>();
    for (const candidate of candidates) {
      if (!candidate.invoice_document_id) continue;
      byInvoice.set(candidate.invoice_document_id, [
        ...(byInvoice.get(candidate.invoice_document_id) ?? []),
        candidate,
      ]);
    }
    for (const invoiceCandidates of byInvoice.values()) {
      if (invoiceCandidates.length < 2) continue;
      const refundOwners = new Map<string, InboundOrderCandidateRow>();
      const refunds = invoiceCandidates.flatMap((candidate) =>
        candidate.refund_ids.map((id, index) => {
          refundOwners.set(id, candidate);
          return { id, amount: candidate.refund_amounts[index] ?? 0 };
        }),
      );
      const refundSubset = uniqueRefundSubset(refunds, remote.totalAmount);
      if (refundSubset.status !== "UNIQUE") continue;
      const selectedRefundIds = refundSubset.ids;
      const selectedRefundIdSet = new Set(selectedRefundIds);
      const selectedByOrder = new Map<string, number>();
      for (const refundId of selectedRefundIds) {
        const owner = refundOwners.get(refundId)!;
        const refundIndex = owner.refund_ids.indexOf(refundId);
        selectedByOrder.set(
          owner.id,
          (selectedByOrder.get(owner.id) ?? 0) + (owner.refund_amounts[refundIndex] ?? 0),
        );
      }
      if (selectedByOrder.size < 2) continue;
      const selectedCandidates = [];
      for (const candidate of invoiceCandidates) {
        const selectedAmount = selectedByOrder.get(candidate.id);
        if (selectedAmount === undefined) continue;
        selectedCandidates.push(
          arubaOrderCandidateFromSource(candidate, {
            billingCaseId: candidate.invoice_document_id,
            localOrderDate:
              candidate.refund_dates
                .filter((_, index) => selectedRefundIdSet.has(candidate.refund_ids[index]!))
                .toSorted()
                .at(-1) ?? candidate.local_order_date,
            billableAmount: selectedAmount,
          }),
        );
      }
      const grouped = groupOrderCandidates(selectedCandidates)[0]!;
      const anchor = invoiceCandidates.find((candidate) => candidate.id === grouped.id)!;
      evaluatedCandidates.push({
        source: {
          ...anchor,
          selected_refund_ids: selectedRefundIds,
          match_amount: remote.totalAmount,
        },
        matchCandidate: grouped,
      });
    }
  }
  const match = selectOrderMatch(
    remote,
    evaluatedCandidates.map((candidate) => candidate.matchCandidate),
  );
  const compatibleSubsetAmbiguous = match.evaluations.some(
    (evaluation, index) =>
      evaluation.compatible && evaluatedCandidates[index]!.source.refund_subset_ambiguous,
  );
  let status: string =
    remote.status === "UNKNOWN"
      ? "UNKNOWN_REMOTE_STATE"
      : compatibleSubsetAmbiguous
        ? "AMBIGUOUS"
        : match.status;
  if (submitted && !submittedMatches) status = "PROFILE_CONFLICT";
  if (identityCollision) status = "UNKNOWN_REMOTE_STATE";
  const compatibleIndex =
    status === "MATCHED" ? match.evaluations.findIndex((evaluation) => evaluation.compatible) : -1;
  const selected = compatibleIndex >= 0 ? evaluatedCandidates[compatibleIndex]!.source : null;
  const reviewCandidates = match.evaluations
    .map((evaluation, index) =>
      evaluation.compatible ||
      evaluation.reviewable ||
      evaluation.potential ||
      isArubaAmountMismatchCandidate({
        ...evaluation,
        issuedInvoiceDocumentId:
          remote.documentType === "TD01"
            ? evaluatedCandidates[index]!.source.invoice_document_id
            : null,
      })
        ? evaluatedCandidates[index]!.source
        : null,
    )
    .filter((candidate): candidate is (typeof evaluatedCandidates)[number]["source"] =>
      Boolean(candidate),
    );
  let documentId: string | null = null;
  if (selected) {
    documentId = submitted?.id ?? null;
    if (remote.documentType === "TD01" && selected.invoice_document_id) {
      // react-doctor-disable-next-line react-doctor/raw-sql-injection-risk -- Il predicato interpolato è una costante SQL interna senza input esterno.
      const linked = await client.query<{
        id: string;
        series: string;
        fiscal_year: number;
        fiscal_number: number;
        document_date: string;
        total_amount: number;
      }>(
        `SELECT id, series, fiscal_year, fiscal_number, document_date::text, total_amount
         FROM documents WHERE id = $1 AND kind = 'INVOICE'
           AND ${effectiveApprovedInvoiceSql("documents")}`,
        [selected.invoice_document_id],
      );
      const existingInvoice = linked.rows[0];
      const sameFiscalIdentity = Boolean(
        existingInvoice &&
        remote.series &&
        remote.fiscalNumber &&
        normalizedMatchText(existingInvoice.series) === normalizedMatchText(remote.series) &&
        existingInvoice.fiscal_year === remote.fiscalYear &&
        existingInvoice.fiscal_number === Number(remote.fiscalNumber) &&
        existingInvoice.document_date === remote.documentDate &&
        existingInvoice.total_amount === remote.totalAmount,
      );
      if (documentId === selected.invoice_document_id || sameFiscalIdentity) {
        documentId = selected.invoice_document_id;
      } else {
        status = "PROFILE_CONFLICT";
        documentId = null;
      }
    }
  }
  if (!official && status === "MATCHED") {
    status = "UNMATCHED";
    documentId = null;
  }
  const confirmedSelected = status === "MATCHED" ? selected : null;
  const actionableCandidateObserved = match.evaluations.some(
    (evaluation) => evaluation.compatible || evaluation.reviewable,
  );
  if (previous.rows[0]?.method === "MANUAL" && previous.rows[0].status === "MATCHED") {
    if (remote.status === "REJECTED" && previous.rows[0].billing_case_id) {
      await recomputeBillingCaseStatus(client, previous.rows[0].billing_case_id, true);
    }
    return;
  }
  if (
    (previous.rows[0]?.method === "MANUAL" &&
      previous.rows[0].status === "UNMATCHED" &&
      !actionableCandidateObserved) ||
    previous.rows[0]?.status === "ERROR" ||
    (previous.rows[0]?.status === "UNKNOWN_REMOTE_STATE" && remote.status === "UNKNOWN")
  ) {
    return;
  }
  await client.query(
    `INSERT INTO aruba_document_matches
      (remote_document_id, status, method, matcher_version, document_id, order_id,
       billing_case_id, related_invoice_document_id, refund_ids, signals_json, candidates_json)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (remote_document_id) DO UPDATE SET
       status = EXCLUDED.status, method = EXCLUDED.method,
       matcher_version = EXCLUDED.matcher_version, document_id = EXCLUDED.document_id,
       order_id = EXCLUDED.order_id, billing_case_id = EXCLUDED.billing_case_id,
       related_invoice_document_id = EXCLUDED.related_invoice_document_id,
       refund_ids = EXCLUDED.refund_ids,
       signals_json = EXCLUDED.signals_json, candidates_json = EXCLUDED.candidates_json,
       updated_at = now()`,
    [
      remoteId,
      status,
      confirmedSelected ? "AUTOMATIC" : "NONE",
      ARUBA_MATCHER_VERSION,
      documentId,
      confirmedSelected?.id ?? null,
      confirmedSelected?.billing_case_id ?? null,
      confirmedSelected?.invoice_document_id ?? null,
      confirmedSelected?.selected_refund_ids ?? [],
      JSON.stringify(
        identityCollision
          ? {
              ...previous.rows[0]?.signals_json,
              providerIdentityCollision: true,
              identityCollisionCandidatesVerified:
                !previous.rows[0]?.signals_json.remoteObservationConflict &&
                (!submitted || submittedMatches),
            }
          : compatibleIndex >= 0
            ? match.evaluations[compatibleIndex]!.signals
            : {},
      ),
      JSON.stringify(
        match.evaluations.map((evaluation, index) => ({
          ...evaluation,
          issuedInvoiceDocumentId:
            remote.documentType === "TD01"
              ? evaluatedCandidates[index]!.source.invoice_document_id
              : null,
          refundIds: evaluatedCandidates[index]!.source.selected_refund_ids ?? [],
        })),
      ),
    ],
  );
  const reviewCaseIds = [
    ...new Set(
      reviewCandidates
        .map((candidate) => candidate.billing_case_id)
        .filter((caseId): caseId is string => Boolean(caseId)),
    ),
  ];
  const previousOrderIdSet = new Set<string>();
  for (const candidate of previous.rows[0]?.candidates_json ?? []) {
    if (
      !candidate.potential &&
      !candidate.compatible &&
      !candidate.reviewable &&
      !(candidate.signals && isArubaAmountMismatchCandidate({ signals: candidate.signals }))
    )
      continue;
    if (candidate.candidateId) previousOrderIdSet.add(candidate.candidateId);
    for (const orderId of candidate.orderIds ?? []) previousOrderIdSet.add(orderId);
  }
  const previousCases = previousOrderIdSet.size
    ? await client.query<{ id: string }>(
        `SELECT DISTINCT billing_case_id::text AS id
         FROM orders
         WHERE id = ANY($1::bigint[]) AND billing_case_id IS NOT NULL`,
        [[...previousOrderIdSet]],
      )
    : { rows: [] };
  const affectedCaseIds = [
    ...new Set([
      ...reviewCaseIds,
      ...previousCases.rows.map((billingCase) => billingCase.id),
      ...(previous.rows[0]?.billing_case_id ? [previous.rows[0].billing_case_id] : []),
    ]),
  ];
  for (const billingCaseId of affectedCaseIds) {
    // react-doctor-disable-next-line react-doctor/async-await-in-loop -- Dipende dal match precedente.
    await recomputeBillingCaseStatus(client, billingCaseId, true);
  }
}
