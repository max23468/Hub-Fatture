import type pg from "pg";

import type { CustomerIdentityExceptionProposal } from "../customer-identity-exception.ts";
import { writeAudit } from "./audit.server.ts";

export async function recordAutomaticCustomerIdentityException(
  client: pg.PoolClient,
  customerId: string,
  proposal: CustomerIdentityExceptionProposal,
  requestId: string,
) {
  const recorded = await client.query(
    `INSERT INTO customer_identity_exceptions
       (provider, external_customer_id, source_identity_sha256, first_name, last_name,
        accepted_by, decision_mode)
     VALUES ($1, $2, $3, $4, $5, NULL, 'AUTOMATIC')
     ON CONFLICT (provider, external_customer_id) DO UPDATE SET
       source_identity_sha256 = EXCLUDED.source_identity_sha256,
       first_name = EXCLUDED.first_name,
       last_name = EXCLUDED.last_name,
       accepted_by = NULL,
       decision_mode = 'AUTOMATIC',
       accepted_at = now()
     WHERE (
       customer_identity_exceptions.source_identity_sha256,
       customer_identity_exceptions.first_name,
       customer_identity_exceptions.last_name,
       customer_identity_exceptions.decision_mode,
       customer_identity_exceptions.accepted_by
     ) IS DISTINCT FROM (
       EXCLUDED.source_identity_sha256,
       EXCLUDED.first_name,
       EXCLUDED.last_name,
       EXCLUDED.decision_mode,
       EXCLUDED.accepted_by
     )
     RETURNING id`,
    [
      proposal.provider,
      proposal.externalCustomerId,
      proposal.sourceIdentitySha256,
      proposal.firstName,
      proposal.lastName,
    ],
  );
  if (!recorded.rowCount) return;
  await writeAudit(client, {
    actorType: "SYSTEM",
    action: "CUSTOMER_IDENTITY_EXCEPTION_APPLIED",
    eventClass: "CRITICAL",
    entityType: "CUSTOMER",
    entityId: customerId,
    metadata: { provider: proposal.provider },
    before: { identityException: "REQUIRED" },
    after: {
      identityException: "AUTOMATIC",
      sourceIdentitySha256: proposal.sourceIdentitySha256,
    },
    reason: "Deroga automatica per intestazione cliente e CF formalmente valido",
    requestId,
  });
}
