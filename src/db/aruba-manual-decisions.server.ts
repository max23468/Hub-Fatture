import type pg from "pg";
import { z } from "zod";

import {
  canManuallyLinkCandidate,
  isArubaAmountMismatchCandidate,
  isEmissionConfirmed,
  type ArubaRemoteStatus,
} from "../aruba-inbound.ts";
import { AppError } from "../errors.ts";
import { writeAudit } from "./audit.server.ts";
import { recomputeBillingCaseStatus } from "./billing-case-status.server.ts";
import { withTransaction } from "./client.server.ts";
import { isDatabaseId } from "./database-id.ts";
import { materializeLatestOfficialXml } from "./aruba-document-materialization.server.ts";
import {
  arubaAccountReference as accountReference,
  arubaRuntimeEnvironment as environment,
  lockArubaInventory,
  type ArubaReadActor,
} from "./aruba-inventory-context.server.ts";

type ManualCandidate = {
  candidateId?: string;
  orderIds?: string[];
  compatible?: boolean;
  reviewable?: boolean;
  potential?: boolean;
  issuedInvoiceDocumentId?: string | null;
  refundIds?: string[];
  signals?: {
    provider?: boolean;
    nearDate?: boolean;
    recipient?: boolean;
    total?: boolean;
  };
};

function isActionable(candidate: ManualCandidate) {
  return canManuallyLinkCandidate({
    compatible: Boolean(candidate.compatible),
    reviewable: Boolean(candidate.reviewable),
  });
}

function requiresManualDecision(candidate: ManualCandidate) {
  return (
    isActionable(candidate) ||
    (candidate.signals ? isArubaAmountMismatchCandidate({ signals: candidate.signals }) : false)
  );
}

function candidateOrderIds(
  candidates: ManualCandidate[],
  predicate: (candidate: ManualCandidate) => boolean = () => true,
) {
  const ids = new Set<string>();
  for (const candidate of candidates) {
    if (!predicate(candidate)) continue;
    if (candidate.candidateId) ids.add(candidate.candidateId);
    for (const orderId of candidate.orderIds ?? []) ids.add(orderId);
  }
  return [...ids];
}

async function affectedCases(client: pg.PoolClient, orderIds: string[]) {
  return orderIds.length
    ? client.query<{ id: string }>(
        `SELECT DISTINCT billing_case_id::text AS id
         FROM orders
         WHERE id = ANY($1::bigint[]) AND billing_case_id IS NOT NULL`,
        [orderIds],
      )
    : { rows: [] };
}

export async function resolveArubaDocumentMatch(
  remoteDocumentId: string,
  orderId: string,
  rawReason: unknown,
  rawAmountMismatchConfirmation: unknown,
  actor: ArubaReadActor,
) {
  const reason = z.string().trim().min(10).max(500).safeParse(rawReason);
  if (!actor.canApprove) throw new AppError("ARUBA_READ_SESSION_FORBIDDEN", 403);
  if (!isDatabaseId(remoteDocumentId) || !isDatabaseId(orderId) || !reason.success) {
    throw new AppError("ARUBA_INVENTORY_INVALID", 422);
  }
  return withTransaction(async (client) => {
    await lockArubaInventory(client);
    const match = await client.query<{
      status: string;
      method: string | null;
      order_id: string | null;
      candidates_json: ManualCandidate[];
      remote_status: ArubaRemoteStatus;
      document_type: "TD01" | "TD04";
      has_xml: boolean;
    }>(
      `SELECT matches.status, matches.method, matches.order_id, matches.candidates_json,
              remote.remote_status, remote.document_type,
              EXISTS (SELECT 1 FROM aruba_files
                WHERE aruba_files.remote_document_id = remote.id
                  AND aruba_files.kind = 'ARUBA_XML') AS has_xml
       FROM aruba_document_matches AS matches
       JOIN aruba_remote_documents AS remote ON remote.id = matches.remote_document_id
       WHERE matches.remote_document_id = $1
         AND remote.environment = $2 AND remote.account_reference = $3
       FOR UPDATE OF matches, remote`,
      [remoteDocumentId, environment(), accountReference()],
    );
    const current = match.rows[0];
    const selectedCandidate = current?.candidates_json.find((candidate) => {
      if (candidate.candidateId !== orderId) return false;
      return (
        isActionable(candidate) ||
        (candidate.signals
          ? isArubaAmountMismatchCandidate({
              ...candidate,
              signals: candidate.signals,
            })
          : false)
      );
    });
    const amountMismatch = Boolean(
      selectedCandidate?.signals &&
      isArubaAmountMismatchCandidate({
        ...selectedCandidate,
        signals: selectedCandidate.signals,
      }),
    );
    if (
      !current ||
      !current.has_xml ||
      !isEmissionConfirmed(current.remote_status) ||
      !selectedCandidate ||
      (amountMismatch &&
        (current.document_type !== "TD01" || rawAmountMismatchConfirmation !== "confirmed"))
    ) {
      throw new AppError("ARUBA_PROFILE_CONFLICT", 409);
    }
    const invoice =
      current.document_type === "TD04"
        ? await client.query<{ document_id: string }>(
            `SELECT document_orders.document_id
             FROM document_orders JOIN documents ON documents.id = document_orders.document_id
             WHERE document_orders.order_id = $1 AND document_orders.document_kind = 'INVOICE'
               AND documents.status = 'APPROVED' ORDER BY documents.id DESC LIMIT 1`,
            [orderId],
          )
        : null;
    const cases = await affectedCases(client, candidateOrderIds(current.candidates_json));
    await client.query(
      `UPDATE aruba_document_matches SET status = 'MATCHED', method = 'MANUAL',
         order_id = $2, billing_case_id = (SELECT billing_case_id FROM orders WHERE id = $2),
         related_invoice_document_id = $3, refund_ids = $4, decided_by = $5, decision_reason = $6,
         decided_at = now(), updated_at = now() WHERE remote_document_id = $1`,
      [
        remoteDocumentId,
        orderId,
        invoice?.rows[0]?.document_id ?? null,
        selectedCandidate.refundIds ?? [],
        actor.id,
        reason.data,
      ],
    );
    const documentId = await materializeLatestOfficialXml(client, remoteDocumentId, true);
    for (const billingCase of cases.rows) {
      // react-doctor-disable-next-line react-doctor/async-await-in-loop -- La decisione e i ricalcoli condividono la stessa transazione.
      await recomputeBillingCaseStatus(client, billingCase.id, true);
    }
    await writeAudit(client, {
      actorType: "ADMIN",
      actorId: String(actor.id),
      action: "ARUBA_DOCUMENT_MATCH_RESOLVED",
      eventClass: "CRITICAL",
      entityType: "ARUBA_REMOTE_DOCUMENT",
      entityId: remoteDocumentId,
      before: { status: current.status, method: current.method, orderId: current.order_id },
      after: {
        status: "MATCHED",
        method: "MANUAL",
        orderId,
        documentId,
        amountMismatch,
      },
      reason: reason.data,
      requestId: actor.requestId,
    });
    return { matched: true, documentId };
  });
}

export async function confirmArubaDocumentOutOfScope(
  remoteDocumentId: string,
  rawReason: unknown,
  rawCandidateRejection: unknown,
  actor: ArubaReadActor,
) {
  const reason = z.string().trim().min(20).max(500).safeParse(rawReason);
  if (!actor.canApprove) throw new AppError("ARUBA_READ_SESSION_FORBIDDEN", 403);
  if (!isDatabaseId(remoteDocumentId) || !reason.success) {
    throw new AppError("ARUBA_INVENTORY_INVALID", 422);
  }
  return withTransaction(async (client) => {
    await lockArubaInventory(client);
    const match = await client.query<{
      status: string;
      method: string | null;
      order_id: string | null;
      billing_case_id: string | null;
      document_id: string | null;
      related_invoice_document_id: string | null;
      candidates_json: ManualCandidate[];
      remote_status: ArubaRemoteStatus;
      origin: string;
      has_xml: boolean;
      has_hub_submission: boolean;
    }>(
      `SELECT matches.status, matches.method, matches.order_id, matches.billing_case_id,
              matches.document_id, matches.related_invoice_document_id, matches.candidates_json,
              remote.remote_status, remote.origin,
              EXISTS (SELECT 1 FROM aruba_files
                WHERE aruba_files.remote_document_id = remote.id
                  AND aruba_files.kind = 'ARUBA_XML') AS has_xml,
              EXISTS (
                SELECT 1 FROM aruba_submissions AS submissions
                JOIN aruba_batches AS batches ON batches.id = submissions.batch_id
                WHERE submissions.remote_id = remote.remote_id
                  AND submissions.environment = remote.environment
                  AND batches.account_reference = remote.account_reference
                  AND submissions.status <> 'REMOVED'
              ) AS has_hub_submission
       FROM aruba_document_matches AS matches
       JOIN aruba_remote_documents AS remote ON remote.id = matches.remote_document_id
       WHERE matches.remote_document_id = $1
         AND remote.environment = $2 AND remote.account_reference = $3
       FOR UPDATE OF matches, remote`,
      [remoteDocumentId, environment(), accountReference()],
    );
    const current = match.rows[0];
    const actionableCandidates = current?.candidates_json.filter(requiresManualDecision) ?? [];
    if (
      !current ||
      !["PROFILE_CONFLICT", "UNMATCHED", "AMBIGUOUS"].includes(current.status) ||
      (current.status === "UNMATCHED" && current.method === "MANUAL") ||
      !isEmissionConfirmed(current.remote_status) ||
      !current.has_xml ||
      current.has_hub_submission ||
      (actionableCandidates.length > 0 && rawCandidateRejection !== "confirmed") ||
      current.order_id ||
      current.billing_case_id ||
      current.document_id ||
      current.related_invoice_document_id
    ) {
      throw new AppError("ARUBA_PROFILE_CONFLICT", 409);
    }
    const rejectedOrderIds = candidateOrderIds(current.candidates_json, requiresManualDecision);
    const cases = await affectedCases(client, rejectedOrderIds);
    await client.query(
      `UPDATE aruba_document_matches SET status = 'UNMATCHED', method = 'MANUAL',
         order_id = NULL, billing_case_id = NULL, document_id = NULL,
         related_invoice_document_id = NULL, refund_ids = '{}', decided_by = $2,
         decision_reason = $3, decided_at = now(), updated_at = now()
       WHERE remote_document_id = $1`,
      [remoteDocumentId, actor.id, reason.data],
    );
    await client.query(
      `UPDATE aruba_remote_documents SET origin = 'ARUBA_EXTERNAL' WHERE id = $1`,
      [remoteDocumentId],
    );
    for (const billingCase of cases.rows) {
      // react-doctor-disable-next-line react-doctor/async-await-in-loop -- La decisione e i ricalcoli condividono la stessa transazione.
      await recomputeBillingCaseStatus(client, billingCase.id);
    }
    await writeAudit(client, {
      actorType: "ADMIN",
      actorId: String(actor.id),
      action: "ARUBA_DOCUMENT_CONFIRMED_OUT_OF_SCOPE",
      eventClass: "CRITICAL",
      entityType: "ARUBA_REMOTE_DOCUMENT",
      entityId: remoteDocumentId,
      before: {
        status: current.status,
        method: current.method,
        origin: current.origin,
        actionableCandidateCount: actionableCandidates.length,
        rejectedOrderIds,
      },
      after: { status: "UNMATCHED", method: "MANUAL", origin: "ARUBA_EXTERNAL" },
      reason: reason.data,
      requestId: actor.requestId,
    });
    return { outOfScope: true };
  });
}
