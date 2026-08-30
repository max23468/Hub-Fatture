import { arubaModeSchema } from "../aruba.ts";
import { AppError } from "../errors.ts";
import { getPool } from "./client.server.ts";
import { isDatabaseId } from "./database-id.ts";
import { standardInvoiceApprovalCriteriaSql } from "./billing-case-sql.server.ts";
import {
  customerEmailChoiceSchema,
  customerEmailPreview,
  getCustomerEmailSettings,
} from "./email.server.ts";
import { approveInvoice } from "./documents.server.ts";

interface FiscalActor {
  id: number;
  canApprove: boolean;
  requestId: string;
}

function integer(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 2_147_483_647) {
    throw new AppError("CONFLICT_REVISION", 409);
  }
  return parsed;
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
