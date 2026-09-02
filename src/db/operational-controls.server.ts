import { createHash } from "node:crypto";

import { errorCodeLabel } from "../error-label.ts";
import {
  listOperationalBillingCaseAnomalies,
  type OperationalBillingCaseAnomaly,
} from "./billing-cases.server.ts";
import { listOpenActivities } from "./order-queries.server.ts";
import { actionableConnectorFailures } from "./connector-jobs.server.ts";
import { pendingShopifyDataRequests } from "./connector-webhooks.server.ts";
import { listRemoteDocuments } from "./aruba-inventory-queries.server.ts";
import { getPool, withTransaction } from "./client.server.ts";
import { listActionableCustomerReviews } from "./customers.server.ts";

export type OperationalControlSeverity = "BLOCKING" | "IMPORTANT" | "ORDINARY";
export type OperationalControlState = "OPEN" | "WAITING" | "RESOLVED";
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

function providerLabel(provider: string | null) {
  return provider === "SHOPIFY" ? "Shopify" : provider === "EBAY" ? "eBay" : "Canale";
}

function activityCandidate(
  activity: Awaited<ReturnType<typeof listOpenActivities>>["rows"][number],
) {
  const subject = activity.case_number
    ? `Preparazione ${activity.case_number}`
    : activity.order_number
      ? `${providerLabel(activity.provider)} ${activity.order_number}`
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
    metadata: { area: definition.area, facts, sourceLabel: subject },
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
  const [customers, billingCases, batches, submissions, emails] = await Promise.all([
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
       WHERE status IN ('DRY_RUN_FAILED', 'VALIDATION_FAILED', 'UNKNOWN_REMOTE_STATE',
                        'RECONCILIATION_REQUIRED')
       ORDER BY updated_at, id`,
    ),
    pool.query<{
      id: string;
      status: string;
      error_code: string | null;
      document_id: string;
      billing_case_id: string;
      case_number: string;
      observed_at: string;
    }>(
      `SELECT submissions.id::text, submissions.status, submissions.error_code,
              submissions.document_id::text, documents.billing_case_id::text,
              billing_cases.public_number AS case_number,
              coalesce(submissions.last_checked_at, submissions.submitted_at,
                       batches.updated_at)::text AS observed_at
       FROM aruba_submissions AS submissions
       JOIN aruba_batches AS batches ON batches.id = submissions.batch_id
       JOIN documents ON documents.id = submissions.document_id
       JOIN billing_cases ON billing_cases.id = documents.billing_case_id
       WHERE submissions.status IN ('VALIDATION_FAILED', 'REJECTED', 'UNKNOWN',
                                    'UNKNOWN_REMOTE_STATE')
       ORDER BY observed_at, submissions.id`,
    ),
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
    ...submissions.rows.map((row): ControlCandidate => ({
      id: `ARUBA_SUBMISSION:${row.id}`,
      kind: "ARUBA_SUBMISSION_ATTENTION",
      category: "DECISION",
      severity:
        row.status === "REJECTED" || row.status.startsWith("UNKNOWN") ? "BLOCKING" : "IMPORTANT",
      sourceType: "ARUBA_SUBMISSION",
      sourceId: row.id,
      origin: "DOCUMENTS",
      title:
        row.status === "REJECTED"
          ? "Documento scartato da SdI"
          : "Esito del documento da verificare",
      detail: `Preparazione ${row.case_number}`,
      consequence:
        "Il documento richiede un readback o una correzione prima di un nuovo tentativo.",
      href: `/ordini/preparazione/${row.billing_case_id}`,
      primaryAction: "Apri preparazione",
      metadata: {
        area: "DOCUMENT_GENERATION",
        facts: [
          { label: "Preparazione", value: row.case_number },
          { label: "Stato", value: row.status, tone: "warning" },
          ...(row.error_code
            ? [{ label: "Errore", value: errorCodeLabel(row.error_code), tone: "warning" as const }]
            : []),
        ],
      },
      detectedAt: row.observed_at,
    })),
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
    ...remoteDocuments.map((remote) => {
      const label =
        `${remote.document_type} ${remote.series ?? ""} ${remote.fiscal_number ?? remote.remote_id}`
          .replaceAll(/\s+/g, " ")
          .trim();
      const needsFile = !remote.has_xml;
      const amountMismatch = remote.amount_mismatch;
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
            : "ARUBA_REMOTE_MATCH",
        category: "DECISION" as const,
        severity: "BLOCKING" as const,
        sourceType: "ARUBA_REMOTE_DOCUMENT",
        sourceId: remote.id,
        origin: "DOCUMENTS" as const,
        title: needsFile
          ? "File ufficiale Aruba da acquisire"
          : amountMismatch
            ? "Importo Aruba da verificare"
            : "Possibile fattura già presente su Aruba",
        detail: label,
        consequence: needsFile
          ? "La riconciliazione resta incompleta finché il file ufficiale non viene verificato."
          : amountMismatch
            ? "La preparazione correlata resta sospesa finché la differenza non viene risolta."
            : "L’approvazione è sospesa per evitare una doppia emissione.",
        href: `/documenti?vista=inventario-aruba#documento-aruba-${remote.id}`,
        primaryAction: needsFile
          ? "Apri inventario Aruba"
          : amountMismatch
            ? "Verifica documento Aruba"
            : "Collega documento Aruba",
        metadata: {
          remoteDocumentId: remote.id,
          remoteStatus: remote.remote_status,
          matchStatus: remote.match_status,
          hasXml: remote.has_xml,
          candidates: remote.candidates,
          facts: [
            { label: "Documento Aruba", value: label },
            { label: "Data", value: remote.document_date },
            {
              label: "Totale",
              value: `${(Number(remote.total_amount) / 100).toFixed(2).replace(".", ",")} €`,
            },
            ...amountMismatchFacts,
            { label: "Stato collegamento", value: remote.match_status, tone: "warning" as const },
          ],
        },
        detectedAt: remote.last_observed_at,
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
           resolution_code = 'VERIFIED', updated_at = now()
       WHERE state = 'WAITING' AND source_type <> 'JOB'
         AND NOT (id = ANY($1::text[]))`,
      [currentIds],
    );
  });
  return candidates.length;
}

export async function getOperationalControlSummary() {
  await refreshOperationalControls();
  return readOperationalControlSummary();
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

export async function listOperationalControls(filters: {
  state?: "OPEN" | "WAITING";
  severity?: OperationalControlSeverity;
  kind?: string;
  origin?: OperationalControlOrigin;
  selectedId?: string;
}) {
  await refreshOperationalControls();
  const state = filters.state ?? "OPEN";
  const result = await getPool().query<OperationalControl & { total_count: number }>(
    `SELECT controls.*, count(*) OVER()::int AS total_count
     FROM operational_controls AS controls
     WHERE controls.state = $1
       AND ($2::text IS NULL OR controls.severity = $2)
       AND ($3::text IS NULL OR controls.kind = $3)
       AND ($4::text IS NULL OR controls.origin = $4)
     ORDER BY CASE controls.severity
       WHEN 'BLOCKING' THEN 0 WHEN 'IMPORTANT' THEN 1 ELSE 2 END,
       controls.opened_at, controls.id
     LIMIT 100`,
    [state, filters.severity ?? null, filters.kind ?? null, filters.origin ?? null],
  );
  const rows = result.rows.map(({ total_count, ...row }) => {
    void total_count;
    return row;
  });
  const selected =
    rows.find((row) => row.id === filters.selectedId) ??
    (filters.selectedId
      ? (
          await getPool().query<OperationalControl>(
            "SELECT * FROM operational_controls WHERE id = $1 AND state = $2",
            [filters.selectedId, state],
          )
        ).rows[0]
      : rows[0]);
  const summary = await readOperationalControlSummary();
  return { rows, total: result.rows[0]?.total_count ?? 0, selected: selected ?? null, summary };
}

export async function markOperationalControlWaiting(id: string, note?: string) {
  await getPool().query(
    `UPDATE operational_controls
     SET state = 'WAITING', waiting_at = now(), resolved_at = NULL,
         resolution_code = 'ACTION_STARTED', resolution_note = nullif(btrim($2), ''),
         updated_at = now()
     WHERE id = $1 AND state = 'OPEN'`,
    [id, note ?? null],
  );
}

export async function resolveOperationalControl(id: string, code: string, note?: string) {
  await getPool().query(
    `UPDATE operational_controls
     SET state = 'RESOLVED', waiting_at = NULL, resolved_at = now(),
         resolution_code = $2, resolution_note = nullif(btrim($3), ''), updated_at = now()
     WHERE id = $1 AND state IN ('OPEN', 'WAITING')`,
    [id, code, note ?? null],
  );
}
