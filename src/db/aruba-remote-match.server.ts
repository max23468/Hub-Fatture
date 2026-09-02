import type pg from "pg";

import { isArubaAmountMismatchCandidate, type ArubaRemoteStatus } from "../aruba-inbound.ts";
import { getConfig } from "../config.server.ts";
import { recomputeBillingCaseStatus } from "./billing-case-status.server.ts";

export interface LockedRemoteMatch {
  id: string;
  remote_id: string;
  document_type: "TD01" | "TD04";
  fiscal_year: number;
  series: string | null;
  fiscal_number: string | null;
  document_date: string;
  total_amount: number;
  remote_status: ArubaRemoteStatus;
  xml_sha256: string | null;
  match_status: string;
  match_method: string;
  decision_reason: string | null;
  order_id: string | null;
  billing_case_id: string | null;
  document_id: string | null;
  related_invoice_document_id: string | null;
  refund_ids: string[];
  candidates_json: Array<{
    candidateId?: string;
    orderIds?: string[];
    potential?: boolean;
    compatible?: boolean;
    reviewable?: boolean;
    issuedInvoiceDocumentId?: string | null;
    signals?: {
      provider?: boolean;
      nearDate?: boolean;
      recipient?: boolean;
      total?: boolean;
    };
  }>;
}

export async function lockedRemoteMatch(client: pg.PoolClient, remoteDocumentId: string) {
  const environment = getConfig().APP_ENV === "production" ? "PRODUCTION" : "MOCK";
  const result = await client.query<LockedRemoteMatch>(
    `SELECT remote.id, remote.remote_id, remote.document_type, remote.fiscal_year,
            remote.series, remote.fiscal_number, remote.document_date::text,
            remote.total_amount, remote.remote_status, remote.xml_sha256,
            matches.status AS match_status, matches.method AS match_method,
            matches.decision_reason,
            matches.order_id, matches.billing_case_id::text, matches.document_id,
            matches.related_invoice_document_id, matches.refund_ids::text[],
            matches.candidates_json
     FROM aruba_remote_documents AS remote
     JOIN aruba_document_matches AS matches ON matches.remote_document_id = remote.id
     WHERE remote.id = $1 AND remote.environment = $2 AND remote.account_reference = $3
     FOR UPDATE OF remote, matches`,
    [remoteDocumentId, environment, getConfig().ARUBA_ACCOUNT_REFERENCE],
  );
  return result.rows[0] ?? null;
}

export async function markRemoteProfileConflict(client: pg.PoolClient, remote: LockedRemoteMatch) {
  await client.query(
    `UPDATE aruba_document_matches SET status = 'PROFILE_CONFLICT', method = 'NONE',
       document_id = NULL, updated_at = now() WHERE remote_document_id = $1`,
    [remote.id],
  );
  const orderIds = new Set<string>();
  for (const candidate of remote.candidates_json) {
    if (
      !candidate.potential &&
      !candidate.compatible &&
      !candidate.reviewable &&
      !(candidate.signals && isArubaAmountMismatchCandidate({ signals: candidate.signals }))
    )
      continue;
    if (candidate.candidateId) orderIds.add(candidate.candidateId);
    for (const orderId of candidate.orderIds ?? []) orderIds.add(orderId);
  }
  const candidateCases = orderIds.size
    ? await client.query<{ id: string }>(
        `SELECT DISTINCT billing_case_id::text AS id FROM orders
         WHERE id = ANY($1::bigint[]) AND billing_case_id IS NOT NULL`,
        [[...orderIds]],
      )
    : { rows: [] };
  const affectedCaseIds = new Set(candidateCases.rows.map((billingCase) => billingCase.id));
  if (remote.billing_case_id) affectedCaseIds.add(remote.billing_case_id);
  for (const billingCaseId of affectedCaseIds) {
    // react-doctor-disable-next-line react-doctor/async-await-in-loop -- Il conflitto e tutti i casi candidati condividono la stessa transazione.
    await recomputeBillingCaseStatus(client, billingCaseId, true);
  }
}
