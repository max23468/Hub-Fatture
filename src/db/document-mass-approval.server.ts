import { ensureFreshArubaInventory } from "./aruba-inventory-health.server.ts";
import { arubaModeSchema } from "../aruba.ts";
import { AppError } from "../errors.ts";
import { getPool } from "./client.server.ts";
import { isDatabaseId } from "./database-id.ts";
import { parseDatabaseRevision } from "./database-revision.ts";
import { standardInvoiceApprovalCandidateSql } from "./billing-case-sql.server.ts";
import {
  customerEmailChoiceSchema,
  customerEmailPreview,
  getCustomerEmailSettings,
} from "./email.server.ts";
import { approveInvoice, getStandardInvoiceApprovalProjection } from "./documents.server.ts";

interface FiscalActor {
  id: number;
  canApprove: boolean;
  requestId: string;
}

async function mapWithConcurrency<T, Result>(
  values: T[],
  concurrency: number,
  mapper: (value: T) => Promise<Result>,
) {
  const mapped: Result[] = [];
  for (let index = 0; index < values.length; index += concurrency) {
    mapped.push(...(await Promise.all(values.slice(index, index + concurrency).map(mapper))));
  }
  return mapped;
}

export async function listMassApprovalCandidates() {
  const [result, emailSettings] = await Promise.all([
    getPool().query<{
      billing_case_id: string;
      case_revision: number;
      draft_version: number | null;
      projection_sha256: string | null;
      public_number: string;
      customer_name: string;
      total_amount: number | null;
      fiscal_profile_version: number | null;
    }>(
      `SELECT billing_cases.id AS billing_case_id, billing_cases.revision AS case_revision,
            documents.draft_version, documents.projection_sha256, billing_cases.public_number,
            billing_cases.customer_snapshot_json ->> 'displayName' AS customer_name,
            documents.total_amount, documents.fiscal_profile_version
     FROM billing_cases
     LEFT JOIN documents ON documents.billing_case_id = billing_cases.id
       AND documents.kind = 'INVOICE'
     LEFT JOIN fiscal_profiles ON fiscal_profiles.version = documents.fiscal_profile_version
     WHERE ${standardInvoiceApprovalCandidateSql()}
     ORDER BY billing_cases.id
     LIMIT 100`,
    ),
    getCustomerEmailSettings(),
  ]);
  const candidates = await mapWithConcurrency(result.rows, 4, async (row) => {
    const projection = row.projection_sha256
      ? {
          caseRevision: row.case_revision,
          draftVersion: row.draft_version!,
          projectionSha256: row.projection_sha256,
          totalAmount: row.total_amount!,
          fiscalProfileVersion: row.fiscal_profile_version!,
        }
      : await getStandardInvoiceApprovalProjection(row.billing_case_id);
    if (!projection) return null;
    return {
      billing_case_id: row.billing_case_id,
      case_revision: projection.caseRevision,
      draft_version: projection.draftVersion,
      projection_sha256: projection.projectionSha256,
      public_number: row.public_number,
      customer_name: row.customer_name,
      total_amount: projection.totalAmount,
      fiscal_profile_version: projection.fiscalProfileVersion,
      customerEmail: await customerEmailPreview(row.billing_case_id, emailSettings),
    };
  });
  return candidates.filter((candidate) => candidate !== null);
}

function approvalCandidate(value: string) {
  const match = /^(\d+):(\d+):(\d+):([0-9a-f]{64})$/.exec(value);
  if (!match || !isDatabaseId(match[1]!)) throw new AppError("DOCUMENT_INVALID", 422);
  return {
    caseId: match[1]!,
    caseRevision: parseDatabaseRevision(match[2]),
    draftVersion: parseDatabaseRevision(match[3]),
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
  await ensureFreshArubaInventory(actor);
  const outcomes = await Promise.all(
    candidates.map(async (candidate) => {
      try {
        const result = await approveInvoice(
          candidate.caseId,
          {
            caseRevision: candidate.caseRevision,
            draftVersion: candidate.draftVersion,
            projectionSha256: candidate.projectionSha256,
            confirmApproval: true,
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
          approved: result !== null,
          storagePending: result?.storagePending ?? false,
        };
      } catch (error) {
        if (!(error instanceof AppError)) throw error;
        return {
          approved: false,
          storagePending: false,
          refreshing: error.code === "ARUBA_INVENTORY_REFRESHING",
        };
      }
    }),
  );
  // Nessuna numerazione è avvenuta: la stessa conferma può attendere ancora.
  // Un esito parziale o un altro errore richiede invece una nuova decisione sulle residue.
  if (outcomes.every((outcome) => "refreshing" in outcome && outcome.refreshing)) {
    throw new AppError("ARUBA_INVENTORY_REFRESHING", 409);
  }
  const approved = outcomes.filter((outcome) => outcome.approved).length;
  return {
    approved,
    failed: candidates.length - approved,
    storagePending: outcomes.filter((outcome) => outcome.storagePending).length,
  };
}
