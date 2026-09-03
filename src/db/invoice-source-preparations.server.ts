import type pg from "pg";

import { AppError } from "../errors.ts";
import { getPool } from "./client.server.ts";

export interface ReconciledSourceDocument {
  id: string;
  billing_case_id: string;
  public_number: string;
  series: string;
  fiscal_year: number;
  fiscal_number: number;
  document_date: string;
  total_amount: number;
  source_total_amount: number;
  orders: Array<{ id: string; provider: string; display_number: string }>;
}

export async function linkDocumentToSourcePreparation(
  client: pg.PoolClient,
  documentId: string,
  sourceCaseId: string,
) {
  const current = await client.query<{ source_billing_case_id: string | null }>(
    "SELECT source_billing_case_id::text FROM documents WHERE id = $1 FOR UPDATE",
    [documentId],
  );
  const linkedCaseId = current.rows[0]?.source_billing_case_id;
  if (linkedCaseId === null) {
    await client.query("UPDATE documents SET source_billing_case_id = $2 WHERE id = $1", [
      documentId,
      sourceCaseId,
    ]);
  } else if (linkedCaseId !== sourceCaseId) {
    throw new AppError("ARUBA_INVENTORY_CONFLICT", 409);
  }
}

export async function listReconciledDocumentsForSourceCase(sourceCaseId: string) {
  const result = await getPool().query<ReconciledSourceDocument>(
    `SELECT documents.id::text, documents.billing_case_id::text,
            archived_cases.public_number, documents.series,
            documents.fiscal_year, documents.fiscal_number,
            documents.document_date::text, documents.total_amount,
            documents.source_total_amount,
            coalesce((
              SELECT jsonb_agg(jsonb_build_object(
                'id', orders.id::text,
                'provider', orders.provider,
                'display_number', orders.display_number
              ) ORDER BY orders.id)
              FROM document_orders
              JOIN orders ON orders.id = document_orders.order_id
              WHERE document_orders.document_id = documents.id
                AND document_orders.document_kind = 'INVOICE'
            ), '[]'::jsonb) AS orders
     FROM documents
     JOIN billing_cases AS archived_cases ON archived_cases.id = documents.billing_case_id
     WHERE documents.source_billing_case_id = $1
       AND documents.kind = 'INVOICE'
     ORDER BY documents.document_date, documents.id`,
    [sourceCaseId],
  );
  return result.rows;
}
