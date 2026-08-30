import type pg from "pg";

import {
  documentInputSchema,
  fiscalProfileSchema,
  projectFatturaXml,
  type DocumentInput,
  type FiscalProfile,
} from "../documents.ts";
import { AppError } from "../errors.ts";
import { validateFatturaXml } from "../fatturapa.server.ts";

export async function refreshInvoiceDraftProjection(client: pg.PoolClient, caseId: string) {
  const result = await client.query<{
    id: string;
    document_date: string;
    recipient_snapshot_json: DocumentInput["recipient"];
    payment_status: string;
    payment_method: string;
    causale: string | null;
    notes: string | null;
    profile_json: FiscalProfile;
    lines: DocumentInput["lines"];
  }>(
    `SELECT documents.id,
            (CURRENT_TIMESTAMP AT TIME ZONE 'Europe/Rome')::date::text AS document_date,
            documents.recipient_snapshot_json, documents.payment_status,
            documents.payment_method, documents.causale, documents.notes,
            fiscal_profiles.profile_json,
            coalesce((
              SELECT jsonb_agg(jsonb_build_object(
                'orderId', document_lines.order_id::text,
                'description', document_lines.description,
                'quantity', document_lines.quantity,
                'unitAmount', document_lines.unit_amount
              ) ORDER BY document_lines.line_number)
              FROM document_lines WHERE document_lines.document_id = documents.id
            ), '[]') AS lines
     FROM documents
     JOIN fiscal_profiles ON fiscal_profiles.version = documents.fiscal_profile_version
     WHERE documents.billing_case_id = $1
       AND documents.kind = 'INVOICE' AND documents.status = 'DRAFT'`,
    [caseId],
  );
  const row = result.rows[0];
  if (!row) return;
  const profile = fiscalProfileSchema.safeParse(row.profile_json);
  const input = documentInputSchema.safeParse({
    kind: "INVOICE",
    documentDate: row.document_date,
    recipient: row.recipient_snapshot_json,
    lines: row.lines,
    paymentStatus: row.payment_status,
    paymentMethod: row.payment_method,
    causale: row.causale ?? undefined,
    notes: row.notes ?? undefined,
  });
  if (!profile.success || !input.success) throw new AppError("DOCUMENT_INVALID", 422);
  const projection = projectFatturaXml(profile.data, input.data);
  await validateFatturaXml(projection.xml);
  await client.query(
    `UPDATE documents SET document_date = $2, projection_sha256 = $3, updated_at = now()
     WHERE id = $1`,
    [row.id, row.document_date, projection.sha256],
  );
}
