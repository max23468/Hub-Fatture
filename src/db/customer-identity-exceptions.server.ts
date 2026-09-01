import type pg from "pg";

import {
  customerIdentityExceptionProposal,
  type CustomerIdentityExceptionProposal,
} from "../customer-identity-exception.ts";
import { AppError } from "../errors.ts";
import { orderInputSchema, type OrderInput } from "../orders.ts";
import { writeAudit } from "./audit.server.ts";
import { withTransaction } from "./client.server.ts";
import { isDatabaseId } from "./database-id.ts";

interface Actor {
  id: number;
  canApprove: boolean;
  requestId: string;
}

async function proposalForCustomer(
  client: pg.Pool | pg.PoolClient,
  customerId: string,
): Promise<CustomerIdentityExceptionProposal | null> {
  const result = await client.query<{ snapshot: unknown }>(
    `SELECT orders.raw_snapshot_json AS snapshot
     FROM orders
     JOIN customers ON customers.id = orders.customer_id
     LEFT JOIN billing_cases ON billing_cases.id = orders.billing_case_id
     WHERE orders.customer_id = $1 AND orders.provider = 'EBAY'
       AND customers.kind = 'PRIVATE_IT'
       AND coalesce(
         (orders.normalized_snapshot_json ->> 'customerReviewRequired')::boolean,
         customers.review_required
       )
       AND (
         (orders.billing_case_id IS NULL
          AND orders.trigger_status IN ('NEEDS_REVIEW', 'LEGACY_BILLING_REVIEW'))
         OR (
           billing_cases.status = 'NEEDS_REVIEW'
           AND coalesce(
             (billing_cases.customer_snapshot_json ->> 'reviewRequired')::boolean,
             true
           )
         )
       )
     ORDER BY orders.updated_at_source DESC, orders.id DESC`,
    [customerId],
  );
  const proposals = new Map<string, CustomerIdentityExceptionProposal>();
  for (const row of result.rows) {
    const parsed = orderInputSchema.safeParse(row.snapshot);
    if (!parsed.success) continue;
    const proposal = customerIdentityExceptionProposal(parsed.data);
    if (proposal) {
      proposals.set(
        `${proposal.provider}:${proposal.externalCustomerId}:${proposal.sourceIdentitySha256}`,
        proposal,
      );
    }
  }
  return proposals.size === 1 ? [...proposals.values()][0]! : null;
}

export async function getCustomerIdentityExceptionProposal(
  customerId: string | undefined,
): Promise<CustomerIdentityExceptionProposal | null> {
  if (!customerId || !isDatabaseId(customerId)) return null;
  return withTransaction((client) => proposalForCustomer(client, customerId));
}

export async function acceptCustomerIdentityException(
  customerId: string | undefined,
  actor: Actor,
): Promise<OrderInput[]> {
  if (!actor.canApprove) throw new AppError("DOCUMENT_APPROVAL_FORBIDDEN", 403);
  if (!customerId || !isDatabaseId(customerId)) throw new AppError("ORDER_INVALID_INPUT", 422);
  return withTransaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `customer-identity-exception:${customerId}`,
    ]);
    const proposal = await proposalForCustomer(client, customerId);
    if (!proposal) throw new AppError("ORDER_INVALID_INPUT", 422);
    await client.query(
      `INSERT INTO customer_identity_exceptions
         (provider, external_customer_id, source_identity_sha256, first_name, last_name,
          accepted_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (provider, external_customer_id) DO UPDATE SET
         source_identity_sha256 = EXCLUDED.source_identity_sha256,
         first_name = EXCLUDED.first_name,
         last_name = EXCLUDED.last_name,
         accepted_by = EXCLUDED.accepted_by,
         accepted_at = now()`,
      [
        proposal.provider,
        proposal.externalCustomerId,
        proposal.sourceIdentitySha256,
        proposal.firstName,
        proposal.lastName,
        actor.id,
      ],
    );
    await writeAudit(client, {
      actorType: "ADMIN",
      actorId: String(actor.id),
      action: "CUSTOMER_IDENTITY_EXCEPTION_ACCEPTED",
      eventClass: "CRITICAL",
      entityType: "CUSTOMER",
      entityId: customerId,
      metadata: { provider: "EBAY" },
      before: { identityException: "REQUIRED" },
      after: {
        identityException: "ACCEPTED",
        sourceIdentitySha256: proposal.sourceIdentitySha256,
      },
      reason: "Deroga anagrafica limitata all’identità eBay corrente",
      requestId: actor.requestId,
    });
    const replay = await client.query<{ snapshot: unknown }>(
      `SELECT orders.raw_snapshot_json AS snapshot
       FROM orders
       LEFT JOIN billing_cases ON billing_cases.id = orders.billing_case_id
       WHERE orders.provider = $1
         AND orders.raw_snapshot_json ->> 'externalCustomerId' = $2
         AND coalesce(billing_cases.status, '') NOT IN ('APPROVED', 'CLOSED')
       ORDER BY orders.id`,
      [proposal.provider, proposal.externalCustomerId],
    );
    return replay.rows.flatMap((row) => {
      const parsed = orderInputSchema.safeParse(row.snapshot);
      return parsed.success ? [parsed.data] : [];
    });
  });
}
