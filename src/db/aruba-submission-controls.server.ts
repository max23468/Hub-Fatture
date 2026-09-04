import { errorCodeLabel } from "../error-label.ts";
import { getPool } from "./client.server.ts";

type SubmissionControlCause =
  | "REMOTE_UNKNOWN"
  | "PROCESSING_ERROR"
  | "SDI_REJECTED"
  | "NOT_DELIVERED"
  | "OVERDUE"
  | "TECHNICAL_FAILURE";

function submissionCause(row: {
  status: string;
  error_code: string | null;
  overdue: boolean;
}): SubmissionControlCause {
  if (row.error_code === "ARUBA_INVENTORY_CONFLICT") return "PROCESSING_ERROR";
  if (row.status === "UNKNOWN_REMOTE_STATE") return "REMOTE_UNKNOWN";
  if (row.status === "UNKNOWN") return "PROCESSING_ERROR";
  if (row.status === "REJECTED") return "SDI_REJECTED";
  if (row.status === "NOT_DELIVERED") return "NOT_DELIVERED";
  if (row.overdue) return "OVERDUE";
  return "TECHNICAL_FAILURE";
}

const definitions = {
  REMOTE_UNKNOWN: {
    title: "Stato remoto Aruba incerto",
    consequence: "Un nuovo invio resta escluso finché Aruba non chiarisce l’esito precedente.",
    action: "Rileggi da Aruba",
    severity: "BLOCKING" as const,
  },
  PROCESSING_ERROR: {
    title: "Esito Aruba da verificare",
    consequence: "Lo stato osservato non permette di considerare conclusa la trasmissione.",
    action: "Apri documento e leggi l’esito",
    severity: "BLOCKING" as const,
  },
  SDI_REJECTED: {
    title: "Documento scartato da SdI",
    consequence: "Il documento non è emesso e richiede una correzione prima di un nuovo invio.",
    action: "Apri documento e leggi l’esito",
    severity: "BLOCKING" as const,
  },
  NOT_DELIVERED: {
    title: "Documento non consegnato da SdI",
    consequence: "La fattura è emessa, ma il destinatario deve riceverne una copia leggibile.",
    action: "Apri documento e gestisci il destinatario",
    severity: "IMPORTANT" as const,
  },
  OVERDUE: {
    title: "Aggiornamento SdI oltre la soglia prevista",
    consequence: "L’attesa supera 24 ore: serve una nuova lettura autorevole, non un reinvio.",
    action: "Aggiorna stato Aruba",
    severity: "IMPORTANT" as const,
  },
  TECHNICAL_FAILURE: {
    title: "Trasmissione Aruba non completata",
    consequence: "La causa tecnica deve essere risolta prima di ripetere l’operazione.",
    action: "Apri documento",
    severity: "IMPORTANT" as const,
  },
};

const statusLabels: Record<string, string> = {
  ARUBA_ACCEPTED: "Accettato da Aruba",
  SDI_PROCESSING: "In lavorazione SdI",
  SUBMITTED: "Inviato a SdI",
  DELIVERED: "Consegnato",
  NOT_DELIVERED: "Mancata consegna",
  REJECTED: "Scartato",
  UNKNOWN: "Esito da verificare",
  UNKNOWN_REMOTE_STATE: "Stato remoto incerto",
  DRY_RUN_FAILED: "Verifica non riuscita",
  SEND_FAILED: "Trasmissione non riuscita",
  VALIDATION_FAILED: "Validazione non riuscita",
};

export async function listArubaSubmissionControlCandidates() {
  const result = await getPool().query<{
    id: string;
    status: string;
    error_code: string | null;
    document_id: string;
    case_number: string;
    observed_at: string;
    overdue: boolean;
  }>(
    `SELECT submissions.id::text, submissions.status, submissions.error_code,
            submissions.document_id::text, billing_cases.public_number AS case_number,
            coalesce(submissions.remote_status_changed_at, submissions.accepted_at,
                     submissions.submitted_at, batches.updated_at)::text AS observed_at,
            (submissions.status IN ('ARUBA_ACCEPTED', 'SDI_PROCESSING', 'SUBMITTED')
              AND coalesce(submissions.remote_status_changed_at, submissions.accepted_at,
                           submissions.submitted_at, batches.updated_at)
                    < now() - interval '24 hours') AS overdue
     FROM aruba_submissions AS submissions
     JOIN aruba_batches AS batches ON batches.id = submissions.batch_id
     JOIN documents ON documents.id = submissions.document_id
     JOIN billing_cases ON billing_cases.id = documents.billing_case_id
     WHERE submissions.error_code = 'ARUBA_INVENTORY_CONFLICT'
        OR submissions.status IN ('DRY_RUN_FAILED', 'SEND_FAILED', 'VALIDATION_FAILED',
                                  'REJECTED', 'NOT_DELIVERED', 'UNKNOWN',
                                  'UNKNOWN_REMOTE_STATE')
        OR (submissions.status IN ('ARUBA_ACCEPTED', 'SDI_PROCESSING', 'SUBMITTED')
            AND coalesce(submissions.remote_status_changed_at, submissions.accepted_at,
                         submissions.submitted_at, batches.updated_at)
                  < now() - interval '24 hours')
     ORDER BY observed_at, submissions.id`,
  );
  return result.rows.map((row) => {
    const cause = submissionCause(row);
    const definition = definitions[cause];
    return {
      id: `ARUBA_SUBMISSION:${row.id}`,
      kind: `ARUBA_SUBMISSION_${cause}`,
      category: "DECISION" as const,
      severity: definition.severity,
      sourceType: "ARUBA_SUBMISSION",
      sourceId: row.id,
      origin: "DOCUMENTS" as const,
      title: definition.title,
      detail: `Preparazione ${row.case_number}`,
      consequence: definition.consequence,
      href: `/documenti?query=${encodeURIComponent(row.case_number)}`,
      primaryAction: definition.action,
      metadata: {
        area: "DOCUMENT_GENERATION" as const,
        sourceLabel: `Preparazione ${row.case_number}`,
        facts: [
          { label: "Preparazione", value: row.case_number },
          {
            label: "Stato",
            value: statusLabels[row.status] ?? "Da verificare",
            tone: "warning" as const,
          },
          ...(row.error_code
            ? [{ label: "Errore", value: errorCodeLabel(row.error_code), tone: "warning" as const }]
            : []),
        ],
      },
      detectedAt: row.observed_at,
    };
  });
}
