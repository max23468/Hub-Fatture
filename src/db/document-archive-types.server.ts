export interface DocumentListFilters {
  query?: string;
  kind?: "INVOICE" | "CREDIT_NOTE";
  status?: "DRAFT" | "APPROVED";
  arubaStatus?: string;
  transmission?: "TO_SEND" | "RECONCILIATION_REQUIRED";
  dateFrom?: string;
  dateTo?: string;
  remoteUpdatedFrom?: string;
  remoteUpdatedTo?: string;
  recipientCountry?: string;
  recipientTaxId?: string;
  origin?: "HUB" | "ARUBA_HISTORY";
  fiscalNumber?: string;
  providerFilename?: string;
  sdiId?: string;
  page?: number;
  sort?: { key: DocumentListSortKey; direction: "asc" | "desc" };
}

export type DocumentListSortKey = "documento" | "cliente" | "data" | "totale" | "stato" | "email";

interface ArubaDocumentTimelineEvent {
  event_key: string;
  status: string;
  detail: string | null;
  observed_at: string;
  source: "ARUBA" | "SDI";
}

export interface DocumentListRow {
  id: string;
  billing_case_id: string;
  public_number: string;
  source_billing_case_id: string | null;
  source_public_number: string | null;
  kind: "INVOICE" | "CREDIT_NOTE";
  origin: "HUB" | "ARUBA_HISTORY";
  status: "DRAFT" | "APPROVED";
  series: string;
  fiscal_year: number | null;
  fiscal_number: number | null;
  document_date: string;
  total_amount: number;
  customer_name: string;
  xml_sha256: string | null;
  aruba_batch_id: string | null;
  aruba_status: string | null;
  provider_filename: string | null;
  provider_sdi_id: string | null;
  remote_updated_at: string | null;
  remote_status_changed_at: string | null;
  aruba_error_code: string | null;
  aruba_timeline: ArubaDocumentTimelineEvent[];
  historical_order_id: string | null;
}

export const documentListSortSql: Record<DocumentListSortKey, string> = {
  documento: `CASE
       WHEN fiscal_number IS NOT NULL AND fiscal_year IS NOT NULL
         THEN concat_ws(' ', series, lpad(fiscal_number::text, 10, '0'), fiscal_year::text)
       ELSE lpad(public_number, 10, '0')
     END`,
  cliente: "customer_name",
  data: "document_date",
  totale: "total_amount",
  stato: "concat_ws(' ', status, aruba_status)",
  email: "email_status",
};
