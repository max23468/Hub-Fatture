import { createHash } from "node:crypto";
import type pg from "pg";

import { errorCodeLabel } from "../error-label.ts";
import { AppError } from "../errors.ts";
import { orderReferenceLabel } from "../order-reference.ts";
import { escapeLike, postgresDateSchema } from "../orders.ts";
import {
  listOperationalBillingCaseAnomalies,
  type OperationalBillingCaseAnomaly,
} from "./operational-billing-case-controls.server.ts";
import { listOpenActivities } from "./order-queries.server.ts";
import { actionableConnectorFailures } from "./connector-jobs.server.ts";
import { pendingShopifyDataRequests } from "./connector-webhooks.server.ts";
import { listRemoteDocuments, type RemoteDocument } from "./aruba-inventory-queries.server.ts";
import { listArubaAccountControlCandidates } from "./aruba-account-controls.server.ts";
import { listArubaApiCooldownControlCandidates } from "./aruba-api-cooldown-controls.server.ts";
import { listArubaSubmissionControlCandidates } from "./aruba-submission-controls.server.ts";
import { getPool, withTransaction } from "./client.server.ts";
import { listActionableCustomerReviews } from "./customers.server.ts";

export type OperationalControlSeverity = "BLOCKING" | "IMPORTANT" | "ORDINARY";
type OperationalControlState = "OPEN" | "WAITING" | "RESOLVED";
export type OperationalControlOrigin =
  | "ORDERS"
  | "DOCUMENTS"
  | "CUSTOMERS"
  | "CONNECTIONS"
  | "PRIVACY";

export interface ControlFact {
  label: string;
  value: string;
  tone?: "warning" | "success";
}

export interface OperationalControlMetadata {
  area?: "ACQUISITION" | "PROCESSING" | "DOCUMENT_GENERATION";
  facts?: ControlFact[];
  candidates?: Array<{
    id: string;
    label: string;
    guided: boolean;
    amountMismatch: boolean;
    localAmount: number;
    differenceAmount: number;
  }>;
  remoteDocumentId?: string;
  remoteStatus?: string;
  matchStatus?: string;
  hasXml?: boolean;
  jobId?: string;
  privacyEventId?: string;
  sourceLabel?: string;
  orderReferences?: string[];
}

export interface OperationalControl {
  id: string;
  kind: string;
  category: "DECISION" | "TECHNICAL" | "COMPLIANCE";
  severity: OperationalControlSeverity;
  state: OperationalControlState;
  source_type: string;
  source_id: string;
  origin: OperationalControlOrigin;
  title: string;
  detail: string;
  consequence: string;
  href: string;
  primary_action: string;
  metadata_json: OperationalControlMetadata;
  opened_at: string;
  updated_at: string;
  waiting_at: string | null;
  resolution_note: string | null;
  waiting_reason: "PROVIDER" | "CUSTOMER" | "ACCOUNTING" | "TECHNICAL" | "FOLLOW_UP" | null;
  due_at: string | null;
  assignee_user_id: number | null;
  assignee_username: string | null;
}

interface ControlCandidate {
  id: string;
  kind: string;
  category: OperationalControl["category"];
  severity: OperationalControlSeverity;
  sourceType: string;
  sourceId: string;
  origin: OperationalControlOrigin;
  title: string;
  detail: string;
  consequence: string;
  href: string;
  primaryAction: string;
  metadata: OperationalControlMetadata;
  detectedAt: string;
}

const severityRank: Record<OperationalControlSeverity, number> = {
  BLOCKING: 0,
  IMPORTANT: 1,
  ORDINARY: 2,
};

const arubaErroneousControl = {
  kind: "ARUBA_ERRONEOUS_DOCUMENT",
  severity: "IMPORTANT" as const,
  title: "Documento Aruba indicato come errato",
  consequence:
    "Escluso dai collegamenti agli ordini per decisione del titolare. Il documento resta su Aruba: verifica il suo esito e la gestione fiscale necessaria.",
  primaryAction: "Verifica documento Aruba",
};

type ArubaControlRemote = Pick<
  RemoteDocument,
  | "id"
  | "remote_id"
  | "document_type"
  | "series"
  | "fiscal_number"
  | "document_date"
  | "total_amount"
  | "remote_status"
  | "last_observed_at"
>;

function erroneousArubaControl(remote: ArubaControlRemote): ControlCandidate {
  const label =
    `${remote.document_type} ${remote.series ?? ""} ${remote.fiscal_number ?? remote.remote_id}`
      .replaceAll(/\s+/g, " ")
      .trim();
  return {
    ...arubaErroneousControl,
    id: `ARUBA_REMOTE:${remote.id}`,
    category: "DECISION",
    sourceType: "ARUBA_REMOTE_DOCUMENT",
    sourceId: remote.id,
    origin: "DOCUMENTS",
    detail: label,
    href: `/documenti?vista=inventario-aruba#documento-aruba-${remote.id}`,
    detectedAt: remote.last_observed_at,
    metadata: {
      remoteDocumentId: remote.id,
      remoteStatus: remote.remote_status,
      matchStatus: "UNMATCHED",
      hasXml: true,
      candidates: [],
      orderReferences: [],
      facts: [
        { label: "Documento Aruba", value: label },
        { label: "Data", value: remote.document_date },
        {
          label: "Totale",
          value: `${(Number(remote.total_amount) / 100).toFixed(2).replace(".", ",")} €`,
        },
        { label: "Stato collegamento", value: "Escluso dai collegamenti", tone: "warning" },
      ],
    },
  };
}

const CONTROLS_PAGE_SIZE = 50;
const waitingReasons = ["PROVIDER", "CUSTOMER", "ACCOUNTING", "TECHNICAL", "FOLLOW_UP"] as const;
type OperationalControlWaitingReason = (typeof waitingReasons)[number];

interface OperationalControlCursor {
  direction: "next" | "previous";
  severityRank: number;
  openedAt: string;
  id: string;
}

function encodeControlCursor(
  direction: OperationalControlCursor["direction"],
  control: OperationalControl,
) {
  return Buffer.from(
    JSON.stringify({
      direction,
      severityRank: severityRank[control.severity],
      openedAt: new Date(control.opened_at).toISOString(),
      id: control.id,
    } satisfies OperationalControlCursor),
  ).toString("base64url");
}

function decodeControlCursor(value: string | undefined): OperationalControlCursor | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    ) as Partial<OperationalControlCursor>;
    if (
      (parsed.direction === "next" || parsed.direction === "previous") &&
      Number.isInteger(parsed.severityRank) &&
      Number(parsed.severityRank) >= 0 &&
      Number(parsed.severityRank) <= 2 &&
      typeof parsed.openedAt === "string" &&
      Number.isFinite(new Date(parsed.openedAt).getTime()) &&
      typeof parsed.id === "string" &&
      parsed.id.length >= 3 &&
      parsed.id.length <= 220
    ) {
      return parsed as OperationalControlCursor;
    }
  } catch {
    // Un cursore URL alterato riparte dalla prima pagina senza cambiare i filtri.
  }
  return null;
}

function fingerprint(candidate: ControlCandidate) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        kind: candidate.kind,
        severity: candidate.severity,
        title: candidate.title,
        detail: candidate.detail,
        consequence: candidate.consequence,
        href: candidate.href,
        primaryAction: candidate.primaryAction,
        metadata: candidate.metadata,
      }),
    )
    .digest("hex");
}

function activityCandidate(
  activity: Awaited<ReturnType<typeof listOpenActivities>>["rows"][number],
) {
  const subject = activity.case_number
    ? `Preparazione ${activity.case_number}`
    : activity.order_number
      ? orderReferenceLabel(activity.provider ?? "", activity.order_number)
      : activity.kind === "CREDIT_NOTE"
        ? "Nota di credito"
        : `Elemento ${activity.id}`;
  const definitions: Record<
    string,
    Pick<ControlCandidate, "title" | "consequence" | "severity" | "category" | "primaryAction"> & {
      area?: OperationalControlMetadata["area"];
    }
  > = {
    HISTORY_RECONCILIATION: {
      title: "Ordine storico da riconciliare",
      consequence: "La fatturazione resta bloccata per evitare una doppia emissione.",
      severity: "BLOCKING",
      category: "DECISION",
      primaryAction: "Apri ordine",
    },
    ARUBA_INVOICE_LINK: {
      title: "Fattura Aruba da collegare",
      consequence:
        "La fatturazione resta bloccata finché il documento esistente non viene collegato.",
      severity: "BLOCKING",
      category: "DECISION",
      primaryAction: "Apri ordine",
    },
    ORDER_REVIEW: {
      title: "Dati dell’ordine da verificare",
      consequence: "L’ordine non può entrare in una preparazione finché il controllo resta aperto.",
      severity: "IMPORTANT",
      category: "DECISION",
      primaryAction: "Apri ordine",
    },
    REFUND_REVIEW: {
      title: "Rimborso da verificare",
      consequence: "Il rimborso non può essere applicato o trasformato in nota di credito.",
      severity: "IMPORTANT",
      category: "DECISION",
      primaryAction: "Apri ordine",
    },
    REFUND_JOB_FAILED: {
      title: "Rimborso non elaborato",
      consequence: "L’aggiornamento del documento collegato è sospeso.",
      severity: "IMPORTANT",
      category: "TECHNICAL",
      primaryAction: "Apri ordine",
      area: "PROCESSING",
    },
    CREDIT_NOTE_APPROVAL: {
      title: "Nota di credito da approvare",
      consequence: "La rettifica resta in preparazione finché non viene controllata e approvata.",
      severity: "IMPORTANT",
      category: "DECISION",
      primaryAction: "Apri nota di credito",
    },
  };
  const definition = definitions[activity.reason] ?? definitions.ORDER_REVIEW!;
  const facts: ControlFact[] = [
    { label: "Elemento", value: subject },
    ...(activity.customer_name ? [{ label: "Cliente", value: activity.customer_name }] : []),
    ...(activity.order_date ? [{ label: "Data ordine", value: activity.order_date }] : []),
    ...(activity.error_code
      ? [{ label: "Errore", value: errorCodeLabel(activity.error_code), tone: "warning" as const }]
      : []),
  ];
  return {
    id: `${activity.reason}:${activity.id}`,
    kind: activity.reason,
    category: definition.category,
    severity: definition.severity,
    sourceType: activity.kind,
    sourceId: activity.id,
    origin: activity.kind === "CREDIT_NOTE" ? "DOCUMENTS" : "ORDERS",
    title: definition.title,
    detail: subject,
    consequence: definition.consequence,
    href: activity.href,
    primaryAction: definition.primaryAction,
    metadata: {
      area: definition.area,
      facts,
      sourceLabel: subject,
    },
    detectedAt: activity.created_at,
  } satisfies ControlCandidate;
}

function billingCaseAnomalyCandidate(
  item: Awaited<ReturnType<typeof listOperationalBillingCaseAnomalies>>[number],
) {
  const definitions: Record<
    OperationalBillingCaseAnomaly,
    Pick<ControlCandidate, "title" | "consequence" | "primaryAction">
  > = {
    TOTALS_MISMATCH: {
      title: "Totale dell’ordine da riconciliare",
      consequence:
        "La preparazione resta sospesa finché articoli, spedizione e pagamenti non ricostruiscono il totale ricevuto.",
      primaryAction: "Apri preparazione",
    },
    CUSTOMER_MISMATCH: {
      title: "Anagrafiche discordanti nella preparazione",
      consequence:
        "La preparazione resta sospesa finché l’anagrafica corretta non viene scelta o gli ordini incoerenti non vengono separati.",
      primaryAction: "Apri preparazione",
    },
    SOURCE_CONFLICT: {
      title: "Ordine aggiornato dopo la preparazione",
      consequence:
        "La preparazione resta sospesa finché le versioni dell’ordine non vengono confrontate.",
      primaryAction: "Apri preparazione",
    },
    ORDER_NOT_BILLABLE: {
      title: "Ordine non più fatturabile nella preparazione",
      consequence:
        "La preparazione resta sospesa finché l’ordine annullato o rimborsato non viene separato o archiviato.",
      primaryAction: "Apri preparazione",
    },
  };
  const definition = definitions[item.anomaly];
  const subject = `Preparazione ${item.public_number}`;
  return {
    id: `${item.anomaly}:${item.id}`,
    kind: item.anomaly,
    category: "DECISION",
    severity: "IMPORTANT",
    sourceType: "BILLING_CASE",
    sourceId: item.id,
    origin: "ORDERS",
    title: definition.title,
    detail: subject,
    consequence: definition.consequence,
    href: `/ordini/preparazione/${item.id}`,
    primaryAction: definition.primaryAction,
    metadata: {
      facts: [
        { label: "Preparazione", value: item.public_number },
        { label: "Cliente", value: item.customer_name },
        { label: "Data ordine", value: item.local_order_date },
      ],
      sourceLabel: subject,
      orderReferences: item.order_references,
    },
    detectedAt: item.updated_at,
  } satisfies ControlCandidate;
}

async function allOpenActivities() {
  const rows: Awaited<ReturnType<typeof listOpenActivities>>["rows"] = [];
  for (let page = 1; page <= 100; page += 1) {
    const result = await listOpenActivities({ page, pageSize: 5_000 });
    rows.push(...result.rows);
    if (!result.hasNext) break;
  }
  return rows;
}

async function databaseCandidates(): Promise<ControlCandidate[]> {
  const pool = getPool();
  const [
    customers,
    billingCases,
    batches,
    submissions,
    emails,
    retention,
    arubaAccount,
    arubaCooldowns,
  ] = await Promise.all([
    listActionableCustomerReviews(),
    listOperationalBillingCaseAnomalies(),
    pool.query<{
      id: string;
      status: string;
      document_count: number;
      updated_at: string;
    }>(
      `SELECT id::text, status, document_count, updated_at::text
       FROM aruba_batches
       WHERE status IN ('DRY_RUN_FAILED', 'SEND_FAILED', 'VALIDATION_FAILED', 'UNKNOWN_REMOTE_STATE',
                        'RECONCILIATION_REQUIRED')
         AND NOT EXISTS (
           SELECT 1 FROM aruba_submissions
           WHERE aruba_submissions.batch_id = aruba_batches.id
             AND aruba_submissions.transport = 'API'
         )
       ORDER BY updated_at, id`,
    ),
    listArubaSubmissionControlCandidates(),
    pool.query<{
      id: string;
      document_id: string;
      billing_case_id: string;
      case_number: string;
      last_error_code: string | null;
      updated_at: string;
    }>(
      `SELECT DISTINCT ON (deliveries.document_id)
              deliveries.id::text, deliveries.document_id::text,
              documents.billing_case_id::text, billing_cases.public_number AS case_number,
              deliveries.last_error_code, deliveries.updated_at::text
       FROM email_deliveries AS deliveries
       JOIN documents ON documents.id = deliveries.document_id
       JOIN billing_cases ON billing_cases.id = documents.billing_case_id
       WHERE deliveries.status = 'FAILED'
      ORDER BY deliveries.document_id, deliveries.updated_at DESC, deliveries.id DESC`,
    ),
    pool.query<{
      id: string;
      attempts: number;
      last_error_code: string | null;
      failed_at: string;
    }>(
      `SELECT failed.id::text, failed.attempts, failed.last_error_code,
              coalesce(failed.locked_at, failed.run_at, failed.created_at)::text AS failed_at
       FROM jobs AS failed
       WHERE failed.type = 'maintenance_retention' AND failed.status = 'FAILED'
         AND NOT EXISTS (
           SELECT 1 FROM jobs AS completed
           WHERE completed.type = 'maintenance_retention' AND completed.status = 'COMPLETED'
             AND completed.completed_at > coalesce(failed.locked_at, failed.run_at, failed.created_at)
         )
       ORDER BY coalesce(failed.locked_at, failed.run_at, failed.created_at) DESC, failed.id DESC
       LIMIT 1`,
    ),
    listArubaAccountControlCandidates(),
    listArubaApiCooldownControlCandidates(),
  ]);
  return [
    ...customers.map((row): ControlCandidate => ({
      id: `CUSTOMER_IDENTITY:${row.id}`,
      kind: "CUSTOMER_IDENTITY",
      category: "DECISION",
      severity: "IMPORTANT",
      sourceType: "CUSTOMER",
      sourceId: row.id,
      origin: "CUSTOMERS",
      title: "Identità cliente da verificare",
      detail: row.missing_fields.length
        ? `${row.display_name} · ${row.missing_fields.join(", ")}`
        : row.display_name,
      consequence:
        "Le preparazioni collegate restano sospese finché l’identità non viene confermata.",
      href:
        row.target_type === "PREPARATION"
          ? `/ordini/preparazione/${row.target_id}#dati-destinatario`
          : `/ordini/${row.target_id}`,
      primaryAction: row.target_type === "PREPARATION" ? "Correggi destinatario" : "Apri ordine",
      metadata: {
        facts: [
          { label: "Cliente", value: row.display_name },
          ...(row.missing_fields.length
            ? [{ label: "Da completare", value: row.missing_fields.join(", ") }]
            : []),
        ],
        orderReferences: row.order_references,
      },
      detectedAt: row.updated_at,
    })),
    ...billingCases.map(billingCaseAnomalyCandidate),
    ...batches.rows.map((row): ControlCandidate => ({
      id: `ARUBA_BATCH:${row.id}`,
      kind: "ARUBA_BATCH_RECONCILIATION",
      category: "TECHNICAL",
      severity:
        row.status === "UNKNOWN_REMOTE_STATE" || row.status === "RECONCILIATION_REQUIRED"
          ? "BLOCKING"
          : "IMPORTANT",
      sourceType: "ARUBA_BATCH",
      sourceId: row.id,
      origin: "DOCUMENTS",
      title:
        row.status === "RECONCILIATION_REQUIRED" || row.status === "UNKNOWN_REMOTE_STATE"
          ? "Esito Aruba da riconciliare"
          : "Verifica Aruba non riuscita",
      detail: `${row.document_count} ${row.document_count === 1 ? "documento" : "documenti"}`,
      consequence: "Lo stato remoto deve essere verificato prima di ripetere qualsiasi operazione.",
      href: `/documenti#batch-${row.id}`,
      primaryAction: "Apri batch",
      metadata: {
        area: "DOCUMENT_GENERATION",
        facts: [
          { label: "Stato", value: row.status, tone: "warning" },
          { label: "Documenti", value: String(row.document_count) },
        ],
      },
      detectedAt: row.updated_at,
    })),
    ...submissions,
    ...arubaAccount,
    ...arubaCooldowns,
    ...emails.rows.map((row): ControlCandidate => ({
      id: `CUSTOMER_EMAIL:${row.document_id}`,
      kind: "CUSTOMER_EMAIL_FAILED",
      category: "TECHNICAL",
      severity: "ORDINARY",
      sourceType: "EMAIL_DELIVERY",
      sourceId: row.document_id,
      origin: "DOCUMENTS",
      title: "E-mail al cliente non consegnata",
      detail: `Preparazione ${row.case_number}`,
      consequence: "La copia leggibile del documento non è stata consegnata al cliente.",
      href: `/ordini/preparazione/${row.billing_case_id}`,
      primaryAction: "Apri preparazione",
      metadata: {
        area: "DOCUMENT_GENERATION",
        facts: [
          { label: "Preparazione", value: row.case_number },
          ...(row.last_error_code
            ? [
                {
                  label: "Errore",
                  value: errorCodeLabel(row.last_error_code),
                  tone: "warning" as const,
                },
              ]
            : []),
        ],
      },
      detectedAt: row.updated_at,
    })),
    ...retention.rows.map((row): ControlCandidate => ({
      id: `RETENTION_JOB:${row.id}`,
      kind: "RETENTION_FAILED",
      category: "TECHNICAL",
      severity: "BLOCKING",
      sourceType: "JOB",
      sourceId: row.id,
      origin: "CONNECTIONS",
      title: "Conservazione tecnica non completata",
      detail: errorCodeLabel(row.last_error_code),
      consequence:
        "Le scadenze di conservazione non risultano applicate finché il job non termina con una ricevuta verificabile.",
      href: "/impostazioni#sistema",
      primaryAction: "Riprova conservazione",
      metadata: {
        area: "PROCESSING",
        jobId: row.id,
        facts: [
          { label: "Errore", value: errorCodeLabel(row.last_error_code), tone: "warning" },
          { label: "Tentativi", value: String(row.attempts) },
        ],
      },
      detectedAt: row.failed_at,
    })),
  ];
}

async function collectCandidates(): Promise<ControlCandidate[]> {
  const [activities, jobs, privacyRequests, remoteDocuments, stored] = await Promise.all([
    allOpenActivities(),
    actionableConnectorFailures(),
    pendingShopifyDataRequests(),
    listRemoteDocuments({ attentionOnly: true }),
    databaseCandidates(),
  ]);
  const activityCandidates: ControlCandidate[] = [];
  for (const activity of activities) {
    if (activity.reason !== "BILLING_CASE_REVIEW") {
      activityCandidates.push(activityCandidate(activity));
    }
  }
  const candidates: ControlCandidate[] = [
    ...activityCandidates,
    ...jobs.map((job) => ({
      id: `CONNECTOR_JOB:${job.id}`,
      kind: "CONNECTOR_JOB_FAILED",
      category: "TECHNICAL" as const,
      severity: "ORDINARY" as const,
      sourceType: "JOB",
      sourceId: job.id,
      origin: "CONNECTIONS" as const,
      title: "Sincronizzazione non riuscita",
      detail: errorCodeLabel(job.errorCode),
      consequence:
        "I dati del canale possono non essere aggiornati finché il nuovo tentativo non termina.",
      href: "/impostazioni#connessioni",
      primaryAction: "Riprova ora",
      metadata: {
        area: "ACQUISITION" as const,
        jobId: job.id,
        facts: [
          { label: "Errore", value: errorCodeLabel(job.errorCode), tone: "warning" as const },
          { label: "Tentativi", value: String(job.attempts) },
        ],
      },
      detectedAt: job.failedAt,
    })),
    ...privacyRequests.map((privacy) => ({
      id: `SHOPIFY_PRIVACY:${privacy.externalEventId}`,
      kind: "SHOPIFY_PRIVACY_REQUEST",
      category: "COMPLIANCE" as const,
      severity: "IMPORTANT" as const,
      sourceType: "WEBHOOK_EVENT",
      sourceId: privacy.externalEventId,
      origin: "PRIVACY" as const,
      title: "Richiesta dati cliente da completare",
      detail: "Richiesta privacy Shopify",
      consequence: "La richiesta resta aperta finché l’evasione non viene confermata.",
      href: "/controlli",
      primaryAction: "Conferma completamento",
      metadata: {
        privacyEventId: privacy.externalEventId,
        facts: [
          {
            label: "Clienti coinvolti",
            value: privacy.customerIds.join(", ") || "Nessuno indicato",
          },
          { label: "Ordini coinvolti", value: privacy.orderIds.join(", ") || "Nessuno indicato" },
        ],
      },
      detectedAt: privacy.receivedAt,
    })),
    ...remoteDocuments.flatMap<ControlCandidate>((remote) => {
      if (remote.id !== remote.control_remote_id) return [];
      if (remote.identity_excluded) return erroneousArubaControl(remote);
      const label =
        `${remote.document_type} ${remote.series ?? ""} ${remote.fiscal_number ?? remote.remote_id}`
          .replaceAll(/\s+/g, " ")
          .trim();
      const needsFile = !remote.has_xml;
      const amountMismatch = remote.amount_mismatch;
      const externalEvidence = remote.external_evidence;
      const amountMismatchFacts = remote.candidates.reduce<ControlFact[]>((facts, candidate) => {
        if (candidate.amountMismatch) {
          facts.push({
            label: candidate.label,
            value: `${(candidate.localAmount / 100).toFixed(2).replace(".", ",")} €; scostamento Aruba ${candidate.differenceAmount >= 0 ? "+" : ""}${(candidate.differenceAmount / 100).toFixed(2).replace(".", ",")} €`,
            tone: "warning",
          });
        }
        return facts;
      }, []);
      return {
        id: `ARUBA_REMOTE:${remote.id}`,
        kind: needsFile
          ? "ARUBA_OFFICIAL_FILE_REQUIRED"
          : amountMismatch
            ? "ARUBA_AMOUNT_MISMATCH"
            : externalEvidence
              ? "ARUBA_EXTERNAL_EVIDENCE"
              : "ARUBA_REMOTE_MATCH",
        category: "DECISION" as const,
        severity: externalEvidence ? ("IMPORTANT" as const) : ("BLOCKING" as const),
        sourceType: "ARUBA_REMOTE_DOCUMENT",
        sourceId: remote.id,
        origin: "DOCUMENTS" as const,
        title: needsFile
          ? "File ufficiale Aruba da acquisire"
          : amountMismatch
            ? "Importo Aruba da verificare"
            : externalEvidence
              ? "Conferma esterna da registrare"
              : "Possibile fattura già presente su Aruba",
        detail: label,
        consequence: needsFile
          ? "La riconciliazione resta incompleta finché il file ufficiale non viene verificato."
          : amountMismatch
            ? "La preparazione correlata resta sospesa finché la differenza non viene risolta."
            : externalEvidence
              ? "Collega soltanto se una prova esterna identifica espressamente documento e ordine."
              : "L’approvazione è sospesa per evitare una doppia emissione.",
        href: `/documenti?vista=inventario-aruba#documento-aruba-${remote.id}`,
        primaryAction: needsFile
          ? "Apri inventario Aruba"
          : amountMismatch
            ? "Verifica documento Aruba"
            : externalEvidence
              ? "Registra conferma esterna"
              : "Collega documento Aruba",
        metadata: {
          remoteDocumentId: remote.id,
          remoteStatus: remote.remote_status,
          matchStatus: remote.match_status,
          hasXml: remote.has_xml,
          candidates: remote.candidates,
          orderReferences: remote.candidates.map((candidate) => candidate.label),
          facts: [
            { label: "Documento Aruba", value: label },
            { label: "Data", value: remote.document_date },
            {
              label: "Totale",
              value: `${(Number(remote.total_amount) / 100).toFixed(2).replace(".", ",")} €`,
            },
            ...amountMismatchFacts,
            {
              label: "Stato collegamento",
              value: remote.identity_collision
                ? "Conflitto fra documenti Aruba"
                : remote.match_status,
              tone: "warning" as const,
            },
          ],
        },
        detectedAt: remote.last_observed_at,
        ...(remote.identity_collision
          ? {
              kind: "ARUBA_IDENTITY_CONFLICT",
              title: "Identità fiscale duplicata su Aruba",
              consequence:
                "Due documenti Aruba distinti condividono il numero fiscale o l’XML. Verifica entrambi i documenti e i rispettivi esiti SdI prima di risolvere il conflitto. Restano bloccate le preparazioni coinvolte; una verifica incompleta blocca tutte le approvazioni.",
              primaryAction: "Verifica conflitto Aruba",
            }
          : {}),
      } satisfies ControlCandidate;
    }),
    ...stored,
  ];
  const unique = new Map<string, ControlCandidate>();
  for (const candidate of candidates) {
    const current = unique.get(candidate.id);
    if (!current || severityRank[candidate.severity] < severityRank[current.severity]) {
      unique.set(candidate.id, candidate);
    }
  }
  return [...unique.values()];
}

export async function refreshOperationalControls() {
  const candidates = await collectCandidates();
  await withTransaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock($1)", [1_214_606_390]);
    await client.query(
      `INSERT INTO operational_controls
          (id, kind, category, severity, state, source_type, source_id, origin, title,
           detail, consequence, href, primary_action, fingerprint, metadata_json,
           opened_at, updated_at)
       SELECT candidate.id, candidate.kind, candidate.category, candidate.severity,
              'OPEN', candidate.source_type, candidate.source_id, candidate.origin,
              candidate.title, candidate.detail, candidate.consequence, candidate.href,
              candidate.primary_action, candidate.fingerprint, candidate.metadata_json,
              candidate.opened_at, now()
       FROM jsonb_to_recordset($1::jsonb) AS candidate(
         id text, kind text, category text, severity text, source_type text, source_id text,
         origin text, title text, detail text, consequence text, href text,
         primary_action text, fingerprint text, metadata_json jsonb, opened_at timestamptz
       )
         ON CONFLICT (id) DO UPDATE SET
           kind = EXCLUDED.kind,
           category = EXCLUDED.category,
           severity = EXCLUDED.severity,
           source_type = EXCLUDED.source_type,
           source_id = EXCLUDED.source_id,
           origin = EXCLUDED.origin,
           title = EXCLUDED.title,
           detail = EXCLUDED.detail,
           consequence = EXCLUDED.consequence,
           href = EXCLUDED.href,
           primary_action = EXCLUDED.primary_action,
           metadata_json = EXCLUDED.metadata_json,
           opened_at = CASE
             WHEN operational_controls.state = 'RESOLVED'
               OR operational_controls.fingerprint <> EXCLUDED.fingerprint THEN now()
             ELSE operational_controls.opened_at
           END,
           state = CASE
             WHEN operational_controls.state = 'WAITING'
               AND operational_controls.fingerprint = EXCLUDED.fingerprint THEN 'WAITING'
             ELSE 'OPEN'
           END,
           waiting_at = CASE
             WHEN operational_controls.state = 'WAITING'
               AND operational_controls.fingerprint = EXCLUDED.fingerprint
               THEN operational_controls.waiting_at
             ELSE NULL
           END,
           waiting_reason = CASE
             WHEN operational_controls.state = 'WAITING'
               AND operational_controls.fingerprint = EXCLUDED.fingerprint
               THEN operational_controls.waiting_reason
             ELSE NULL
           END,
           due_at = CASE
             WHEN operational_controls.state = 'WAITING'
               AND operational_controls.fingerprint = EXCLUDED.fingerprint
               THEN operational_controls.due_at
             ELSE NULL
           END,
           assignee_user_id = CASE
             WHEN operational_controls.state = 'WAITING'
               AND operational_controls.fingerprint = EXCLUDED.fingerprint
               THEN operational_controls.assignee_user_id
             ELSE NULL
           END,
           resolved_at = NULL,
           resolution_code = NULL,
           fingerprint = EXCLUDED.fingerprint,
           updated_at = now()`,
      [
        JSON.stringify(
          candidates.map((candidate) => ({
            id: candidate.id,
            kind: candidate.kind,
            category: candidate.category,
            severity: candidate.severity,
            source_type: candidate.sourceType,
            source_id: candidate.sourceId,
            origin: candidate.origin,
            title: candidate.title,
            detail: candidate.detail,
            consequence: candidate.consequence,
            href: candidate.href,
            primary_action: candidate.primaryAction,
            fingerprint: fingerprint(candidate),
            metadata_json: candidate.metadata,
            opened_at: candidate.detectedAt,
          })),
        ),
      ],
    );
    const currentIds = candidates.map((candidate) => candidate.id);
    await client.query(
      `UPDATE operational_controls
       SET state = 'RESOLVED', resolved_at = now(), waiting_at = NULL,
           waiting_reason = NULL, due_at = NULL,
           resolution_code = 'SOURCE_CLEARED', updated_at = now()
       WHERE state = 'OPEN' AND NOT (id = ANY($1::text[]))`,
      [currentIds],
    );
    await client.query(
      `UPDATE operational_controls AS controls
       SET state = CASE jobs.status
             WHEN 'FAILED' THEN 'OPEN'
             WHEN 'COMPLETED' THEN 'RESOLVED'
             ELSE 'WAITING'
           END,
           waiting_at = CASE WHEN jobs.status IN ('PENDING', 'RUNNING')
             THEN controls.waiting_at ELSE NULL END,
           waiting_reason = CASE WHEN jobs.status IN ('PENDING', 'RUNNING')
             THEN coalesce(controls.waiting_reason, 'TECHNICAL') ELSE NULL END,
           due_at = CASE WHEN jobs.status IN ('PENDING', 'RUNNING')
             THEN coalesce(controls.due_at, now() + interval '1 day') ELSE NULL END,
           resolved_at = CASE WHEN jobs.status = 'COMPLETED' THEN now() ELSE NULL END,
           resolution_code = CASE WHEN jobs.status = 'COMPLETED' THEN 'VERIFIED' ELSE NULL END,
           updated_at = now()
       FROM jobs
       WHERE controls.state = 'WAITING' AND controls.source_type = 'JOB'
         AND jobs.id::text = controls.source_id`,
    );
    await client.query(
      `UPDATE operational_controls
       SET state = 'RESOLVED', resolved_at = now(), waiting_at = NULL,
           waiting_reason = NULL, due_at = NULL,
           resolution_code = 'VERIFIED', updated_at = now()
       WHERE state = 'WAITING' AND source_type <> 'JOB'
         AND NOT (id = ANY($1::text[]))`,
      [currentIds],
    );
  });
  return candidates.length;
}

/** Legge la proiezione materializzata senza avviare una ricostruzione durante la navigazione. */
export async function readOperationalControlSummary() {
  const result = await getPool().query<{
    open: number;
    waiting: number;
    blocking: number;
    important: number;
    ordinary: number;
    technical: number;
    acquisition: number;
    processing: number;
    document_generation: number;
  }>(
    `SELECT
       count(*) FILTER (WHERE state = 'OPEN')::int AS open,
       count(*) FILTER (WHERE state = 'WAITING')::int AS waiting,
       count(*) FILTER (WHERE state = 'OPEN' AND severity = 'BLOCKING')::int AS blocking,
       count(*) FILTER (WHERE state = 'OPEN' AND severity = 'IMPORTANT')::int AS important,
       count(*) FILTER (WHERE state = 'OPEN' AND severity = 'ORDINARY')::int AS ordinary,
       count(*) FILTER (WHERE state = 'OPEN' AND category = 'TECHNICAL')::int AS technical,
       count(*) FILTER (WHERE state = 'OPEN' AND category = 'TECHNICAL'
         AND metadata_json ->> 'area' = 'ACQUISITION')::int AS acquisition,
       count(*) FILTER (WHERE state = 'OPEN' AND category = 'TECHNICAL'
         AND metadata_json ->> 'area' = 'PROCESSING')::int AS processing,
       count(*) FILTER (WHERE state = 'OPEN' AND category = 'TECHNICAL'
         AND metadata_json ->> 'area' = 'DOCUMENT_GENERATION')::int AS document_generation
     FROM operational_controls`,
  );
  return result.rows[0]!;
}

/** Legge la coda materializzata senza ricostruirla durante una richiesta HTTP. */
export async function readOperationalControls(filters: {
  state?: "OPEN" | "WAITING";
  severity?: OperationalControlSeverity;
  kind?: string;
  origin?: OperationalControlOrigin;
  selectedId?: string;
  search?: string;
  cursor?: string;
}) {
  const state = filters.state ?? "OPEN";
  const search = filters.search?.trim() ?? "";
  if (search.length > 100 || search.includes("\0")) throw new AppError("ORDER_INVALID_INPUT", 422);
  const cursor = decodeControlCursor(filters.cursor);
  const backwards = cursor?.direction === "previous";
  const rankSql = `CASE controls.severity
    WHEN 'BLOCKING' THEN 0 WHEN 'IMPORTANT' THEN 1 ELSE 2 END`;
  const cursorSql = cursor
    ? `AND (${rankSql}, controls.opened_at, controls.id) ${backwards ? "<" : ">"}
         ($6::int, $7::timestamptz, $8::text)`
    : "";
  const orderSql = backwards
    ? `${rankSql} DESC, controls.opened_at DESC, controls.id DESC`
    : `${rankSql}, controls.opened_at, controls.id`;
  const parameters = [
    state,
    filters.severity ?? null,
    filters.kind ?? null,
    filters.origin ?? null,
    search ? `%${escapeLike(search)}%` : null,
    cursor?.severityRank ?? null,
    cursor?.openedAt ?? null,
    cursor?.id ?? null,
  ];
  const pageParameters = cursor ? parameters : parameters.slice(0, 5);
  const [pageResult, totalResult, summary] = await Promise.all([
    getPool().query<OperationalControl>(
      `SELECT controls.*, assignee.username AS assignee_username
     FROM operational_controls AS controls
     LEFT JOIN users AS assignee ON assignee.id = controls.assignee_user_id
     WHERE controls.state = $1
       AND ($2::text IS NULL OR controls.severity = $2)
       AND ($3::text IS NULL OR controls.kind = $3)
       AND ($4::text IS NULL OR controls.origin = $4)
       AND ($5::text IS NULL OR concat_ws(' ', controls.title, controls.detail,
             controls.source_id, controls.metadata_json::text) ILIKE $5)
       ${cursorSql}
     ORDER BY ${orderSql}
     LIMIT ${CONTROLS_PAGE_SIZE + 1}`,
      pageParameters,
    ),
    getPool().query<{ total: number }>(
      `SELECT count(*)::int AS total
       FROM operational_controls AS controls
       WHERE controls.state = $1
         AND ($2::text IS NULL OR controls.severity = $2)
         AND ($3::text IS NULL OR controls.kind = $3)
         AND ($4::text IS NULL OR controls.origin = $4)
         AND ($5::text IS NULL OR concat_ws(' ', controls.title, controls.detail,
               controls.source_id, controls.metadata_json::text) ILIKE $5)`,
      parameters.slice(0, 5),
    ),
    readOperationalControlSummary(),
  ]);
  const hasExtra = pageResult.rows.length > CONTROLS_PAGE_SIZE;
  let rows = pageResult.rows.slice(0, CONTROLS_PAGE_SIZE);
  if (backwards) rows = rows.reverse();
  const hasPrevious = backwards ? hasExtra : Boolean(cursor);
  const hasNext = backwards ? Boolean(cursor) : hasExtra;
  const selected =
    rows.find((row) => row.id === filters.selectedId) ??
    (filters.selectedId
      ? (
          await getPool().query<OperationalControl>(
            `SELECT controls.*, assignee.username AS assignee_username
             FROM operational_controls AS controls
             LEFT JOIN users AS assignee ON assignee.id = controls.assignee_user_id
             WHERE controls.id = $1 AND controls.state = $2`,
            [filters.selectedId, state],
          )
        ).rows[0]
      : rows[0]);
  return {
    rows,
    total: totalResult.rows[0]?.total ?? 0,
    selected: selected ?? null,
    summary,
    previousCursor: hasPrevious && rows[0] ? encodeControlCursor("previous", rows[0]) : null,
    nextCursor: hasNext && rows.at(-1) ? encodeControlCursor("next", rows.at(-1)!) : null,
  };
}

export async function markOperationalControlWaiting(
  id: string,
  input: {
    reason: OperationalControlWaitingReason;
    dueDate?: string;
    assigneeUsername: "Massimo" | "Codex";
    note?: string;
  },
) {
  if (!waitingReasons.includes(input.reason)) throw new AppError("ORDER_INVALID_INPUT", 422);
  if (input.dueDate && !postgresDateSchema.safeParse(input.dueDate).success) {
    throw new AppError("ORDER_INVALID_INPUT", 422);
  }
  const result = await getPool().query(
    `UPDATE operational_controls AS controls
     SET state = 'WAITING', waiting_at = now(), resolved_at = NULL,
         waiting_reason = $2,
         due_at = CASE WHEN $3::text IS NULL THEN now() + interval '1 day'
           ELSE ($3::date + time '12:00') AT TIME ZONE 'Europe/Rome' END,
         assignee_user_id = users.id,
         resolution_code = 'ACTION_STARTED', resolution_note = nullif(btrim($5), ''),
         updated_at = now()
     FROM users
     WHERE controls.id = $1 AND controls.state IN ('OPEN', 'WAITING')
       AND users.username = $4`,
    [id, input.reason, input.dueDate ?? null, input.assigneeUsername, input.note ?? null],
  );
  if (result.rowCount !== 1) throw new AppError("CONFLICT_REVISION", 409);
}

export async function reopenOperationalControl(id: string) {
  const result = await getPool().query(
    `UPDATE operational_controls
     SET state = 'OPEN', waiting_at = NULL, waiting_reason = NULL, due_at = NULL,
         resolved_at = NULL, resolution_code = NULL, resolution_note = NULL, updated_at = now()
     WHERE id = $1 AND state = 'WAITING'`,
    [id],
  );
  if (result.rowCount !== 1) throw new AppError("CONFLICT_REVISION", 409);
}

export async function resolveOperationalControl(id: string, code: string, note?: string) {
  await getPool().query(
    `UPDATE operational_controls
     SET state = 'RESOLVED', waiting_at = NULL, waiting_reason = NULL, due_at = NULL,
         resolved_at = now(),
         resolution_code = $2, resolution_note = nullif(btrim($3), ''), updated_at = now()
     WHERE id = $1 AND state IN ('OPEN', 'WAITING')`,
    [id, code, note ?? null],
  );
}

// Aggiornamento mirato dopo una decisione: la ricostruzione globale resta al worker.
export async function resolveArubaIdentityControls(
  client: pg.PoolClient,
  selectedId: string,
  excludedId: string,
  rejected: boolean,
  reason: string,
) {
  await client.query(
    `UPDATE operational_controls SET
       state = 'RESOLVED', resolved_at = now(), resolution_code = 'ARUBA_IDENTITY_RESOLVED',
       resolution_note = $3, waiting_at = NULL, waiting_reason = NULL, due_at = NULL, updated_at = now()
     WHERE kind = 'ARUBA_IDENTITY_CONFLICT' AND source_type = 'ARUBA_REMOTE_DOCUMENT'
       AND source_id = ANY($1::text[]) AND (source_id = $2 OR $4::boolean)`,
    [[selectedId, excludedId], selectedId, reason, rejected],
  );
  if (rejected) return;
  const remote = await client.query<ArubaControlRemote>(
    `SELECT id::text, remote_id, document_type, series, fiscal_number, document_date::text,
       total_amount, remote_status, last_observed_at::text FROM aruba_remote_documents WHERE id = $1`,
    [excludedId],
  );
  const candidate = erroneousArubaControl(remote.rows[0]!);
  await client.query(
    `INSERT INTO operational_controls
       (id, kind, category, severity, state, source_type, source_id, origin, title, detail,
        consequence, href, primary_action, fingerprint, metadata_json, opened_at, updated_at)
     VALUES ($1, $2, 'DECISION', 'IMPORTANT', 'OPEN', 'ARUBA_REMOTE_DOCUMENT', $3, 'DOCUMENTS',
       $4, $5, $6, $7, $8, $9, $10, now(), now())
     ON CONFLICT (id) DO UPDATE SET kind = EXCLUDED.kind, severity = EXCLUDED.severity,
       title = EXCLUDED.title, detail = EXCLUDED.detail, consequence = EXCLUDED.consequence,
       href = EXCLUDED.href, primary_action = EXCLUDED.primary_action, fingerprint = EXCLUDED.fingerprint,
       metadata_json = EXCLUDED.metadata_json, state = 'OPEN', opened_at = now(), updated_at = now(),
       resolved_at = NULL, waiting_at = NULL, waiting_reason = NULL, due_at = NULL,
       resolution_code = NULL, resolution_note = NULL`,
    [
      candidate.id,
      candidate.kind,
      candidate.sourceId,
      candidate.title,
      candidate.detail,
      candidate.consequence,
      candidate.href,
      candidate.primaryAction,
      fingerprint(candidate),
      candidate.metadata,
    ],
  );
}
