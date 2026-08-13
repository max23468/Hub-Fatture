import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile, unlink } from "node:fs/promises";
import path from "node:path";

import type pg from "pg";
import { z } from "zod";

import {
  groupOrderCandidates,
  inventoryPageSchema,
  isEmissionConfirmed,
  normalizedMatchText,
  remoteMetadataDigest,
  remoteStatusTransition,
  selectOrderMatch,
  type ArubaOrderCandidate,
  type ArubaRemoteStatus,
  type RemoteInventoryDocument,
} from "../aruba-inbound.ts";
import {
  ARUBA_IMPORT_MAX_BYTES,
  ARUBA_PANEL_ORIGIN,
  arubaFileKindSchema,
  notificationStatus,
  validateOfficialFile,
  validateUntrustedXml,
} from "../aruba.ts";
import { getConfig } from "../config.server.ts";
import { hashToken } from "../crypto.server.ts";
import {
  acceptedCreditNoteFromXml,
  acceptedDocumentFiscalIdentity,
  acceptedInvoiceFromXml,
  documentInputSchema,
  fiscalProfileSchema,
  projectFatturaXml,
  type FiscalProfile,
} from "../documents.ts";
import { AppError } from "../errors.ts";
import { validateFatturaXml } from "../fatturapa.server.ts";
import { localOrderDate } from "../orders.ts";
import { writeAudit } from "./audit.server.ts";
import { storeImportedFile } from "./aruba.server.ts";
import { getPool, withTransaction } from "./client.server.ts";
import { isDatabaseId } from "./database-id.ts";
import { serializeOrderMutations } from "./order-mutation-lock.server.ts";

const READ_SESSION_TTL_MS = 8 * 60 * 60_000;
const READ_LEASE_MS = 2 * 60_000;
const MATCHER_VERSION = 1;

export interface ArubaReadActor {
  id: number;
  canApprove: boolean;
  requestId: string;
}

function environment(): "MOCK" | "PRODUCTION" {
  return getConfig().APP_ENV === "production" ? "PRODUCTION" : "MOCK";
}

function panelUrl(): string {
  return environment() === "PRODUCTION"
    ? `${ARUBA_PANEL_ORIGIN}/`
    : new URL("/aruba-sintetica?scenario=inventory", getConfig().APP_BASE_URL).toString();
}

function accountReference(): string {
  return getConfig().ARUBA_ACCOUNT_REFERENCE;
}

async function lockArubaInventory(
  client: pg.PoolClient,
  environmentValue = environment(),
  account = accountReference(),
) {
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
    `aruba-read:${environmentValue}:${account}`,
  ]);
}

function payloadDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function cursorStream(environmentValue: string, account: string, stream: string) {
  return `${environmentValue}:${createHash("sha256").update(account).digest("hex").slice(0, 16)}:${stream}`;
}

async function requiredInventoryCoverage(client: pg.Pool | pg.PoolClient) {
  const oldest = await client.query<{ oldest: string | null }>(
    `SELECT min(local_order_date)::text AS oldest
       FROM orders
       WHERE trigger_status NOT IN ('INVOICED', 'CANCELLED_NO_DOCUMENT', 'REFUNDED_BEFORE_ISSUE')`,
  );
  const nonTerminalYears = await client.query<{ fiscal_year: number }>(
    `SELECT DISTINCT fiscal_year FROM aruba_remote_documents
       WHERE environment = $1 AND account_reference = $2
         AND remote_status IN ('SUBMITTED', 'SDI_PROCESSING', 'UNKNOWN')`,
    [environment(), accountReference()],
  );
  const currentDate = localOrderDate(new Date().toISOString());
  const currentYear = Number(currentDate.slice(0, 4));
  const oldestDate = oldest.rows[0]?.oldest ?? currentDate;
  const oldestYear = Number(oldestDate.slice(0, 4));
  const years = new Set<number>(
    Array.from(
      { length: Math.max(1, Math.min(20, currentYear - oldestYear + 1)) },
      (_, index) => currentYear - index,
    ),
  );
  for (const row of nonTerminalYears.rows) years.add(row.fiscal_year);
  return {
    oldestReconciliationDate: oldestDate,
    streams: [...years]
      .toSorted((left, right) => right - left)
      .flatMap((year) => [`invoices:${year}`, `credit-notes:${year}`]),
  };
}

async function currentInventoryWatermark(client: pg.Pool | pg.PoolClient) {
  const result = await client.query<{ value: string }>(
    `SELECT greatest(
       coalesce((SELECT max(inventory_watermark) FROM aruba_sync_sessions
         WHERE environment = $1 AND account_reference = $2), 0),
       coalesce((SELECT max(inventory_version) FROM aruba_remote_documents
         WHERE environment = $1 AND account_reference = $2), 0)
     )::text AS value`,
    [environment(), accountReference()],
  );
  return Number(result.rows[0]?.value ?? 0);
}

async function backfillHistoricalArubaDocuments(client: pg.PoolClient) {
  await client.query(
    `INSERT INTO aruba_remote_documents (
       environment, account_reference, remote_id, document_type, fiscal_year, series,
       fiscal_number, document_date, total_amount, remote_status,
       remote_status_observed_at, xml_sha256, origin, metadata_digest
     )
     SELECT $1, $2, 'historical-document-' || documents.id,
            documents.document_type, documents.fiscal_year, documents.series,
            documents.fiscal_number::text, documents.document_date, documents.total_amount,
            'DELIVERED', coalesce(documents.approved_at, documents.created_at), documents.xml_sha256,
            'ARUBA_EXTERNAL',
            md5('historical-document-' || documents.id) || md5('historical-document:' || documents.id)
     FROM documents
     WHERE documents.origin = 'ARUBA_HISTORY'
       AND NOT EXISTS (
         SELECT 1 FROM aruba_remote_documents remote
         WHERE remote.environment = $1 AND remote.account_reference = $2
           AND (remote.remote_id = 'historical-document-' || documents.id
             OR (remote.fiscal_year = documents.fiscal_year
               AND upper(remote.series) = upper(documents.series)
               AND upper(remote.fiscal_number) = upper(documents.fiscal_number::text)
               AND remote.document_type = documents.document_type)
             OR remote.xml_sha256 = documents.xml_sha256)
       )
     ON CONFLICT DO NOTHING`,
    [environment(), accountReference()],
  );
  await client.query(
    `INSERT INTO aruba_document_matches
       (remote_document_id, status, method, matcher_version, document_id, signals_json, candidates_json)
     SELECT remote.id, 'MATCHED', 'AUTOMATIC', $3, documents.id,
            '{"historicalBackfill":true}', '[]'
     FROM documents
     JOIN aruba_remote_documents remote
       ON remote.environment = $1 AND remote.account_reference = $2
      AND remote.remote_id = 'historical-document-' || documents.id
     WHERE documents.origin = 'ARUBA_HISTORY'
     ON CONFLICT (remote_document_id) DO NOTHING`,
    [environment(), accountReference(), MATCHER_VERSION],
  );
}

function acceptedProfileMatches(
  profile: FiscalProfile,
  identity: ReturnType<typeof acceptedDocumentFiscalIdentity>,
) {
  return (
    profile.series === "FPR" &&
    profile.transmitter.countryCode === identity.transmitter.countryCode &&
    profile.transmitter.taxCode === identity.transmitter.taxCode &&
    profile.seller.vatCountryCode === identity.seller.vatCountryCode &&
    profile.seller.vatCode === identity.seller.vatCode &&
    (profile.seller.taxCode ?? null) === (identity.seller.taxCode ?? null) &&
    profile.seller.taxRegime === identity.seller.taxRegime &&
    profile.taxNature === identity.taxNature &&
    profile.legalReference === identity.legalReference &&
    profile.payment.condition === identity.payment.condition &&
    (identity.type === "TD01"
      ? profile.payment.invoiceMethod === identity.payment.method
      : profile.payment.creditNoteMethod === identity.payment.method)
  );
}

function remoteFiscalIdentityMatches(
  remote: {
    document_type: "TD01" | "TD04";
    fiscal_year: number;
    series: string | null;
    fiscal_number: string | null;
    document_date: string;
    total_amount: number;
  },
  identity: ReturnType<typeof acceptedDocumentFiscalIdentity>,
) {
  return (
    remote.document_type === identity.type &&
    remote.fiscal_year === identity.year &&
    remote.document_date === identity.documentDate &&
    remote.total_amount === identity.totalAmount &&
    (!remote.series || normalizedMatchText(remote.series) === "FPR") &&
    (!remote.fiscal_number || Number(remote.fiscal_number) === identity.number)
  );
}

function assertDeviceId(value: unknown): string {
  const parsed = z
    .string()
    .regex(/^[A-Za-z0-9_-]{16,100}$/)
    .safeParse(value);
  if (!parsed.success) throw new AppError("ARUBA_READ_SESSION_INVALID", 422);
  return parsed.data;
}

export async function issueArubaReadSession(deviceId: unknown, actor: ArubaReadActor) {
  const id = randomUUID();
  const parsedDeviceId = assertDeviceId(deviceId);
  const token = `${parsedDeviceId}.${randomBytes(32).toString("base64url")}`;
  const startedAt = new Date();
  const absoluteExpiresAt = new Date(startedAt.getTime() + READ_SESSION_TTL_MS);
  await withTransaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `aruba-read:${environment()}:${accountReference()}`,
    ]);
    await backfillHistoricalArubaDocuments(client);
    await client.query(
      `UPDATE aruba_sync_sessions
       SET status = 'EXPIRED', lease_expires_at = NULL
       WHERE environment = $1 AND account_reference = $2
         AND status IN ('ACTIVE', 'SCANNING')
         AND (absolute_expires_at <= now() OR coalesce(lease_expires_at, '-infinity') <= now())`,
      [environment(), accountReference()],
    );
    const active = await client.query<{ id: string; absolute_expires_at: Date }>(
      `SELECT id, absolute_expires_at FROM aruba_sync_sessions
       WHERE environment = $1 AND account_reference = $2
         AND status IN ('ACTIVE', 'SCANNING')
       ORDER BY started_at DESC LIMIT 1`,
      [environment(), accountReference()],
    );
    if (active.rows[0]) throw new AppError("ARUBA_READ_SESSION_ACTIVE", 409);
    await client.query(
      `INSERT INTO aruba_sync_sessions
        (id, environment, account_reference, device_id, token_hash, started_at,
         absolute_expires_at, lease_expires_at, requested_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        id,
        environment(),
        accountReference(),
        parsedDeviceId,
        hashToken(token),
        startedAt,
        absoluteExpiresAt,
        new Date(startedAt.getTime() + READ_LEASE_MS),
        actor.id,
      ],
    );
    await client.query(
      `INSERT INTO aruba_sync_pages
         (sync_session_id, stream, scan_ordinal, page_ordinal, cursor, terminal,
          full_scan, row_count, documents_json, payload_digest, committed_at)
       SELECT $1, pages.stream, 1, pages.page_ordinal, pages.cursor, pages.terminal,
              pages.full_scan, pages.row_count, pages.documents_json,
              pages.payload_digest, pages.committed_at
       FROM aruba_sync_pages pages
       WHERE pages.sync_session_id = (
         SELECT previous.id FROM aruba_sync_sessions previous
         WHERE previous.environment = $2 AND previous.account_reference = $3
           AND previous.status IN ('FAILED', 'EXPIRED') AND previous.is_full_scan
           AND previous.started_at > coalesce((
             SELECT max(completed.full_scan_completed_at) FROM aruba_sync_sessions completed
             WHERE completed.environment = $2 AND completed.account_reference = $3
               AND completed.full_scan_completed_at IS NOT NULL
           ), '-infinity')
         ORDER BY previous.started_at DESC LIMIT 1
       ) AND pages.scan_ordinal = 1 AND NOT pages.terminal
       ON CONFLICT DO NOTHING`,
      [id, environment(), accountReference()],
    );
    await writeAudit(client, {
      actorType: "ADMIN",
      actorId: String(actor.id),
      action: "ARUBA_READ_SESSION_ISSUED",
      eventClass: "OPERATIONAL",
      entityType: "ARUBA_SYNC_SESSION",
      entityId: id,
      metadata: { environment: environment(), deviceIdSuffix: parsedDeviceId.slice(-6) },
      requestId: actor.requestId,
    });
  });
  return { token, sessionId: id, absoluteExpiresAt: absoluteExpiresAt.toISOString() };
}

interface ReadSessionRow {
  id: string;
  environment: "MOCK" | "PRODUCTION";
  account_reference: string;
  device_id: string;
  token_hash: string;
  status: string;
  absolute_expires_at: Date;
  inventory_watermark: string;
}

async function loadReadSession(
  client: pg.Pool | pg.PoolClient,
  token: string,
  lock = false,
): Promise<ReadSessionRow | null> {
  const deviceId = token.split(".", 1)[0];
  if (!/^[A-Za-z0-9_-]{16,100}\.[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const result = await client.query<ReadSessionRow>(
    `SELECT * FROM aruba_sync_sessions
     WHERE token_hash = $1 AND device_id = $2 AND status IN ('ACTIVE', 'SCANNING')
       AND absolute_expires_at > now() AND lease_expires_at > now()
     ${lock ? "FOR UPDATE" : ""}`,
    [hashToken(token), deviceId],
  );
  return result.rows[0] ?? null;
}

export function arubaReadBearer(request: Request): string {
  const match = /^Bearer ([A-Za-z0-9_-]{16,100}\.[A-Za-z0-9_-]{43})$/.exec(
    request.headers.get("authorization") ?? "",
  );
  if (!match) throw new AppError("ARUBA_READ_SESSION_INVALID", 401);
  return match[1]!;
}

export async function arubaReadManifest(token: string) {
  const session = await loadReadSession(getPool(), token);
  if (!session) throw new AppError("ARUBA_READ_SESSION_INVALID", 401);
  const coverage = await requiredInventoryCoverage(getPool());
  const cursors = await getPool().query<{
    stream: string;
    cursor: string | null;
    overlap_from: Date | null;
    last_page_ordinal: number | null;
    full_scan_completed_at: Date | null;
  }>(
    `SELECT stream, cursor, overlap_from, last_page_ordinal, full_scan_completed_at
     FROM sync_cursors WHERE provider = 'ARUBA' AND stream = ANY($1::text[])`,
    [
      coverage.streams.map((stream) =>
        cursorStream(session.environment, session.account_reference, stream),
      ),
    ],
  );
  const byStream = new Map(cursors.rows.map((row) => [row.stream, row]));
  const interrupted = await getPool().query<{
    stream: string;
    scan_ordinal: number;
    page_ordinal: number;
  }>(
    `SELECT DISTINCT ON (stream) stream, scan_ordinal, page_ordinal
     FROM aruba_sync_pages
     WHERE sync_session_id IN (
       SELECT id FROM aruba_sync_sessions
       WHERE environment = $1 AND account_reference = $2 AND status IN ('FAILED', 'EXPIRED')
         AND started_at > coalesce((
           SELECT max(full_scan_completed_at) FROM aruba_sync_sessions
           WHERE environment = $1 AND account_reference = $2
             AND full_scan_completed_at IS NOT NULL
         ), '-infinity')
     ) AND NOT terminal
     ORDER BY stream, committed_at DESC`,
    [session.environment, session.account_reference],
  );
  const resume = new Map(interrupted.rows.map((row) => [row.stream, row]));
  return {
    operation: "READ_SYNC" as const,
    sessionId: session.id,
    environment: session.environment,
    accountReference: session.account_reference,
    panelUrl: panelUrl(),
    oldestReconciliationDate: coverage.oldestReconciliationDate,
    streams: coverage.streams.map((stream) => {
      const scoped = cursorStream(session.environment, session.account_reference, stream);
      const cursor = byStream.get(scoped);
      const interruptedPage = resume.get(stream);
      return {
        name: stream,
        cursor: cursor?.cursor ?? null,
        overlapFrom: cursor?.overlap_from?.toISOString() ?? null,
        lastFullScanCompletedAt: cursor?.full_scan_completed_at?.toISOString() ?? null,
        resumePageOrdinal: interruptedPage ? interruptedPage.page_ordinal : null,
      };
    }),
    intervalSeconds: 900,
    absoluteExpiresAt: session.absolute_expires_at.toISOString(),
  };
}

export async function heartbeatArubaReadSession(
  token: string,
  details: { helperVersion?: unknown; browser?: unknown } = {},
) {
  const browser = z.enum(["chrome", "msedge"]).optional().safeParse(details.browser);
  const helperVersion = z.string().trim().max(100).optional().safeParse(details.helperVersion);
  if (!browser.success || !helperVersion.success)
    throw new AppError("ARUBA_READ_SESSION_INVALID", 422);
  const result = await getPool().query(
    `UPDATE aruba_sync_sessions
     SET status = 'SCANNING', last_heartbeat_at = now(),
         lease_expires_at = least(absolute_expires_at, now() + interval '2 minutes'),
         helper_version = coalesce($2, helper_version), browser_name = coalesce($3, browser_name)
     WHERE token_hash = $1 AND status IN ('ACTIVE', 'SCANNING')
       AND absolute_expires_at > now() AND lease_expires_at > now()`,
    [hashToken(token), helperVersion.data ?? null, browser.data ?? null],
  );
  if (!result.rowCount) throw new AppError("ARUBA_READ_SESSION_INVALID", 401);
}

interface InboundOrderCandidateRow {
  id: string;
  provider: "SHOPIFY" | "EBAY";
  display_number: string;
  local_order_date: string;
  billable_amount: number;
  recipient_name: string | null;
  recipient_tax_ids: string[];
  recipient_address: string | null;
  billing_case_id: string | null;
  invoice_document_id: string | null;
  refund_ids: string[];
  refund_amounts: number[];
}

export function uniqueRefundSubset(
  refunds: Array<{ id: string; amount: number }>,
  target: number,
): string[] | null {
  const sums = new Map<number, string[] | null>([[0, []]]);
  for (const refund of refunds.slice(0, 100)) {
    for (const [sum, selected] of [...sums.entries()].toReversed()) {
      if (sum + refund.amount > target) continue;
      const next = sum + refund.amount;
      if (selected === null) {
        sums.set(next, null);
        continue;
      }
      const candidate = [...selected, refund.id];
      if (!sums.has(next)) sums.set(next, candidate);
      else if (JSON.stringify(sums.get(next)) !== JSON.stringify(candidate)) sums.set(next, null);
    }
  }
  return sums.get(target) ?? null;
}

async function orderCandidates(client: pg.PoolClient, remote: RemoteInventoryDocument) {
  const result = await client.query<InboundOrderCandidateRow>(
    `SELECT orders.id, orders.provider, orders.display_number, orders.local_order_date::text,
            orders.billing_case_id, invoice.document_id::text AS invoice_document_id,
            '{}'::text[] AS refund_ids, '{}'::integer[] AS refund_amounts,
            (orders.gross_amount - orders.deducted_shopify_payments_fee_amount - coalesce((
              SELECT sum(refunds.amount) FROM refunds
              WHERE refunds.order_id = orders.id AND refunds.applied_before_issue
            ), 0))::integer AS billable_amount,
            customers.display_name AS recipient_name,
            coalesce((SELECT array_agg(order_tax_identifiers.normalized_value)
                      FROM order_tax_identifiers WHERE order_tax_identifiers.order_id = orders.id), '{}')
              AS recipient_tax_ids,
            concat_ws(' ',
              orders.normalized_snapshot_json #>> '{customerSnapshot,billingAddress,line1}',
              orders.normalized_snapshot_json #>> '{customerSnapshot,billingAddress,postalCode}',
              orders.normalized_snapshot_json #>> '{customerSnapshot,billingAddress,city}',
              orders.normalized_snapshot_json #>> '{customerSnapshot,billingAddress,countryCode}'
            ) AS recipient_address
     FROM orders
     JOIN customers ON customers.id = orders.customer_id
     LEFT JOIN LATERAL (
       SELECT document_orders.document_id
       FROM document_orders JOIN documents ON documents.id = document_orders.document_id
       WHERE document_orders.order_id = orders.id AND document_orders.document_kind = 'INVOICE'
         AND documents.status = 'APPROVED'
       ORDER BY documents.id DESC LIMIT 1
     ) AS invoice ON true
     WHERE orders.local_order_date BETWEEN $1::date - 31 AND $1::date + 31
       AND orders.trigger_status NOT IN ('CANCELLED_NO_DOCUMENT', 'REFUNDED_BEFORE_ISSUE')
     ORDER BY orders.id
     LIMIT 500`,
    [remote.documentDate],
  );
  return result.rows;
}

async function creditNoteCandidates(client: pg.PoolClient, remote: RemoteInventoryDocument) {
  const result = await client.query<InboundOrderCandidateRow>(
    `SELECT orders.id, orders.provider, orders.display_number,
            coalesce(refundable.refund_date, invoice.document_date)::text AS local_order_date,
            orders.billing_case_id, invoice.document_id::text AS invoice_document_id,
            refundable.amount::integer AS billable_amount, refundable.refund_ids,
            refundable.refund_amounts,
            customers.display_name AS recipient_name,
            coalesce((SELECT array_agg(order_tax_identifiers.normalized_value)
                      FROM order_tax_identifiers WHERE order_tax_identifiers.order_id = orders.id), '{}')
              AS recipient_tax_ids,
            concat_ws(' ',
              orders.normalized_snapshot_json #>> '{customerSnapshot,billingAddress,line1}',
              orders.normalized_snapshot_json #>> '{customerSnapshot,billingAddress,postalCode}',
              orders.normalized_snapshot_json #>> '{customerSnapshot,billingAddress,city}',
              orders.normalized_snapshot_json #>> '{customerSnapshot,billingAddress,countryCode}'
            ) AS recipient_address
     FROM orders
     JOIN customers ON customers.id = orders.customer_id
     JOIN LATERAL (
       SELECT document_orders.document_id, documents.document_date
       FROM document_orders JOIN documents ON documents.id = document_orders.document_id
       WHERE document_orders.order_id = orders.id AND document_orders.document_kind = 'INVOICE'
         AND documents.status = 'APPROVED'
       ORDER BY documents.id DESC LIMIT 1
     ) AS invoice ON true
     JOIN LATERAL (
       SELECT sum(refunds.amount)::integer AS amount,
              max(refunds.completed_at)::date AS refund_date,
              array_agg(refunds.id::text ORDER BY refunds.id) AS refund_ids,
              array_agg(refunds.amount::integer ORDER BY refunds.id) AS refund_amounts
       FROM refunds
       WHERE refunds.order_id = orders.id AND refunds.status = 'COMPLETED'
         AND refunds.amount > 0 AND (
           refunds.credit_document_id IS NULL OR EXISTS (
             SELECT 1 FROM documents credit
             WHERE credit.id = refunds.credit_document_id
               AND credit.kind = 'CREDIT_NOTE' AND credit.status = 'DRAFT'
           )
         )
     ) AS refundable ON refundable.amount > 0
     WHERE coalesce(refundable.refund_date, invoice.document_date)
       BETWEEN $1::date - 31 AND $1::date + 31
     ORDER BY orders.id
     LIMIT 500`,
    [remote.documentDate],
  );
  return result.rows;
}

async function reconcileRemoteDocument(
  client: pg.PoolClient,
  remoteId: string,
  remote: RemoteInventoryDocument,
) {
  const candidates =
    remote.documentType === "TD04"
      ? await creditNoteCandidates(client, remote)
      : await orderCandidates(client, remote);
  const individualCandidates = candidates.map((candidate) => {
    const refundIds =
      remote.documentType === "TD04"
        ? uniqueRefundSubset(
            candidate.refund_ids.map((id, index) => ({
              id,
              amount: candidate.refund_amounts[index] ?? 0,
            })),
            remote.totalAmount,
          )
        : [];
    return {
      ...candidate,
      selected_refund_ids: refundIds,
      match_amount:
        remote.documentType === "TD04" && refundIds
          ? remote.totalAmount
          : remote.documentType === "TD04"
            ? remote.totalAmount + 1
            : candidate.billable_amount,
    };
  });
  const evaluatedCandidates: Array<{
    source: InboundOrderCandidateRow & {
      selected_refund_ids?: string[] | null;
      match_amount?: number;
    };
    matchCandidate: ArubaOrderCandidate & { billingCaseId?: string | null };
  }> = individualCandidates.map((candidate) => ({
    source: candidate,
    matchCandidate: {
      id: candidate.id,
      billingCaseId: remote.documentType === "TD01" ? candidate.billing_case_id : null,
      provider: candidate.provider,
      displayNumber: candidate.display_number,
      localOrderDate: candidate.local_order_date,
      billableAmount: candidate.match_amount,
      recipientName: candidate.recipient_name,
      recipientTaxIds: candidate.recipient_tax_ids,
      recipientAddress: candidate.recipient_address,
    },
  }));
  const matchCandidates = evaluatedCandidates.map((candidate) => candidate.matchCandidate);
  const candidatesById = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const groupedOrderCandidates = groupOrderCandidates(matchCandidates).filter(
    (candidate) => (candidate.orderIds?.length ?? 1) > 1,
  );
  if (remote.documentType === "TD01") {
    for (const grouped of groupedOrderCandidates) {
      const anchor = candidatesById.get(grouped.id)!;
      evaluatedCandidates.push({ source: anchor, matchCandidate: grouped });
    }
  } else {
    const byInvoice = new Map<string, InboundOrderCandidateRow[]>();
    for (const candidate of candidates) {
      if (!candidate.invoice_document_id) continue;
      byInvoice.set(candidate.invoice_document_id, [
        ...(byInvoice.get(candidate.invoice_document_id) ?? []),
        candidate,
      ]);
    }
    for (const invoiceCandidates of byInvoice.values()) {
      if (invoiceCandidates.length < 2) continue;
      const refundOwners = new Map<string, InboundOrderCandidateRow>();
      const refunds = invoiceCandidates.flatMap((candidate) =>
        candidate.refund_ids.map((id, index) => {
          refundOwners.set(id, candidate);
          return { id, amount: candidate.refund_amounts[index] ?? 0 };
        }),
      );
      const selectedRefundIds = uniqueRefundSubset(refunds, remote.totalAmount);
      if (!selectedRefundIds) continue;
      const selectedByOrder = new Map<string, number>();
      for (const refundId of selectedRefundIds) {
        const owner = refundOwners.get(refundId)!;
        const refundIndex = owner.refund_ids.indexOf(refundId);
        selectedByOrder.set(
          owner.id,
          (selectedByOrder.get(owner.id) ?? 0) + (owner.refund_amounts[refundIndex] ?? 0),
        );
      }
      if (selectedByOrder.size < 2) continue;
      const selectedCandidates = [];
      for (const candidate of invoiceCandidates) {
        const selectedAmount = selectedByOrder.get(candidate.id);
        if (selectedAmount === undefined) continue;
        selectedCandidates.push({
          id: candidate.id,
          billingCaseId: candidate.invoice_document_id,
          provider: candidate.provider,
          displayNumber: candidate.display_number,
          localOrderDate: candidate.local_order_date,
          billableAmount: selectedAmount,
          recipientName: candidate.recipient_name,
          recipientTaxIds: candidate.recipient_tax_ids,
          recipientAddress: candidate.recipient_address,
        });
      }
      const grouped = groupOrderCandidates(selectedCandidates)[0]!;
      const anchor = invoiceCandidates.find((candidate) => candidate.id === grouped.id)!;
      evaluatedCandidates.push({
        source: {
          ...anchor,
          selected_refund_ids: selectedRefundIds,
          match_amount: remote.totalAmount,
        },
        matchCandidate: grouped,
      });
    }
  }
  const match = selectOrderMatch(
    remote,
    evaluatedCandidates.map((candidate) => candidate.matchCandidate),
  );
  let status: string = remote.status === "UNKNOWN" ? "UNKNOWN_REMOTE_STATE" : match.status;
  const compatibleIndex =
    match.status === "MATCHED"
      ? match.evaluations.findIndex((evaluation) => evaluation.compatible)
      : -1;
  const selected = compatibleIndex >= 0 ? evaluatedCandidates[compatibleIndex]!.source : null;
  let documentId: string | null = null;
  if (selected) {
    const local = await client.query<{ document_id: string }>(
      `SELECT aruba_submissions.document_id
       FROM aruba_submissions
       JOIN documents ON documents.id = aruba_submissions.document_id
       WHERE aruba_submissions.remote_id = $1 AND aruba_submissions.environment = $2
       ORDER BY aruba_submissions.id DESC LIMIT 1`,
      [remote.remoteId, environment()],
    );
    documentId = local.rows[0]?.document_id ?? null;
    if (remote.documentType === "TD01" && selected.invoice_document_id) {
      const linked = await client.query<{
        id: string;
        series: string;
        fiscal_year: number;
        fiscal_number: number;
        document_date: string;
        total_amount: number;
      }>(
        `SELECT id, series, fiscal_year, fiscal_number, document_date::text, total_amount
         FROM documents WHERE id = $1 AND kind = 'INVOICE' AND status = 'APPROVED'`,
        [selected.invoice_document_id],
      );
      const existingInvoice = linked.rows[0];
      const sameFiscalIdentity = Boolean(
        existingInvoice &&
        remote.series &&
        remote.fiscalNumber &&
        normalizedMatchText(existingInvoice.series) === normalizedMatchText(remote.series) &&
        existingInvoice.fiscal_year === remote.fiscalYear &&
        existingInvoice.fiscal_number === Number(remote.fiscalNumber) &&
        existingInvoice.document_date === remote.documentDate &&
        existingInvoice.total_amount === remote.totalAmount,
      );
      if (documentId === selected.invoice_document_id || sameFiscalIdentity) {
        documentId = selected.invoice_document_id;
      } else {
        status = "PROFILE_CONFLICT";
        documentId = null;
      }
    }
  }
  const previous = await client.query<{ method: string; status: string }>(
    `SELECT method, status FROM aruba_document_matches WHERE remote_document_id = $1 FOR UPDATE`,
    [remoteId],
  );
  if (
    (previous.rows[0]?.method === "MANUAL" && previous.rows[0].status === "MATCHED") ||
    previous.rows[0]?.status === "ERROR" ||
    previous.rows[0]?.status === "UNKNOWN_REMOTE_STATE"
  ) {
    return;
  }
  await client.query(
    `INSERT INTO aruba_document_matches
      (remote_document_id, status, method, matcher_version, document_id, order_id,
       billing_case_id, related_invoice_document_id, refund_ids, signals_json, candidates_json)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (remote_document_id) DO UPDATE SET
       status = EXCLUDED.status, method = EXCLUDED.method,
       matcher_version = EXCLUDED.matcher_version, document_id = EXCLUDED.document_id,
       order_id = EXCLUDED.order_id, billing_case_id = EXCLUDED.billing_case_id,
       related_invoice_document_id = EXCLUDED.related_invoice_document_id,
       refund_ids = EXCLUDED.refund_ids,
       signals_json = EXCLUDED.signals_json, candidates_json = EXCLUDED.candidates_json,
       updated_at = now()`,
    [
      remoteId,
      status,
      selected && status === "MATCHED" ? "AUTOMATIC" : "NONE",
      MATCHER_VERSION,
      documentId,
      selected?.id ?? null,
      selected?.billing_case_id ?? null,
      selected?.invoice_document_id ?? null,
      selected?.selected_refund_ids ?? [],
      JSON.stringify(compatibleIndex >= 0 ? match.evaluations[compatibleIndex]!.signals : {}),
      JSON.stringify(
        match.evaluations.map((evaluation, index) => ({
          ...evaluation,
          refundIds: evaluatedCandidates[index]!.source.selected_refund_ids ?? [],
        })),
      ),
    ],
  );
  if (selected && !isEmissionConfirmed(remote.status)) {
    await client.query(
      `UPDATE billing_cases SET status = 'NEEDS_REVIEW', updated_at = now()
       WHERE id = $1 AND status IN ('DRAFT', 'READY')`,
      [selected.billing_case_id],
    );
  }
}

interface LockedRemoteMatch {
  id: string;
  remote_id: string;
  document_type: "TD01" | "TD04";
  fiscal_year: number;
  series: string | null;
  fiscal_number: string | null;
  document_date: string;
  total_amount: number;
  remote_status: ArubaRemoteStatus;
  xml_sha256: string | null;
  match_status: string;
  order_id: string | null;
  document_id: string | null;
  related_invoice_document_id: string | null;
  refund_ids: string[];
}

async function lockedRemoteMatch(client: pg.PoolClient, remoteDocumentId: string) {
  const result = await client.query<LockedRemoteMatch>(
    `SELECT remote.id, remote.remote_id, remote.document_type, remote.fiscal_year,
            remote.series, remote.fiscal_number, remote.document_date::text,
            remote.total_amount, remote.remote_status, remote.xml_sha256,
            matches.status AS match_status, matches.order_id, matches.document_id,
            matches.related_invoice_document_id, matches.refund_ids::text[]
     FROM aruba_remote_documents AS remote
     JOIN aruba_document_matches AS matches ON matches.remote_document_id = remote.id
     WHERE remote.id = $1 AND remote.environment = $2 AND remote.account_reference = $3
     FOR UPDATE OF remote, matches`,
    [remoteDocumentId, environment(), accountReference()],
  );
  return result.rows[0] ?? null;
}

async function activeFiscalProfile(client: pg.PoolClient) {
  const result = await client.query<{ version: number; profile_json: unknown }>(
    `SELECT version, profile_json FROM fiscal_profiles
     WHERE status IN ('MOCK', 'AUDITED') FOR SHARE`,
  );
  const row = result.rows[0];
  const parsed = fiscalProfileSchema.safeParse(row?.profile_json);
  return row && parsed.success ? { version: row.version, profile: parsed.data } : null;
}

function acceptedRecipientName(
  recipient: ReturnType<typeof acceptedInvoiceFromXml>["input"]["recipient"],
) {
  return (
    recipient.businessName ??
    recipient.displayName ??
    [recipient.firstName, recipient.lastName].filter(Boolean).join(" ")
  );
}

async function regenerateResidualInvoiceDraft(client: pg.PoolClient, caseId: string) {
  const draft = await client.query<{
    id: string;
    document_date: string;
    recipient_snapshot_json: unknown;
    payment_status: string;
    payment_method: string;
    causale: string | null;
    notes: string | null;
    profile_json: unknown;
    lines: Array<{
      orderId: string;
      description: string;
      quantity: number;
      unitAmount: number;
    }>;
  }>(
    `WITH totals AS (
       SELECT documents.id,
              coalesce(sum(document_orders.amount), 0)::integer AS amount
       FROM documents
       LEFT JOIN document_orders ON document_orders.document_id = documents.id
       WHERE documents.billing_case_id = $1 AND documents.kind = 'INVOICE'
         AND documents.status = 'DRAFT'
       GROUP BY documents.id
     ), updated AS (
       UPDATE documents SET source_total_amount = totals.amount,
         total_amount = totals.amount, difference_amount = 0, difference_reason = NULL,
         draft_version = draft_version + 1, projection_sha256 = repeat('0', 64),
         document_date = (CURRENT_TIMESTAMP AT TIME ZONE 'Europe/Rome')::date,
         updated_at = now()
       FROM totals WHERE documents.id = totals.id RETURNING documents.*
     )
     SELECT updated.id, updated.document_date::text, updated.recipient_snapshot_json,
            updated.payment_status, updated.payment_method, updated.causale, updated.notes,
            fiscal_profiles.profile_json,
            coalesce((SELECT jsonb_agg(jsonb_build_object(
              'orderId', document_lines.order_id::text,
              'description', document_lines.description,
              'quantity', document_lines.quantity,
              'unitAmount', document_lines.unit_amount
            ) ORDER BY document_lines.line_number)
            FROM document_lines WHERE document_lines.document_id = updated.id), '[]') AS lines
     FROM updated JOIN fiscal_profiles
       ON fiscal_profiles.version = updated.fiscal_profile_version`,
    [caseId],
  );
  const row = draft.rows[0];
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
    `UPDATE documents SET projection_sha256 = $2, updated_at = now() WHERE id = $1`,
    [row.id, projection.sha256],
  );
}

async function materializeExternalInvoice(
  client: pg.PoolClient,
  remote: LockedRemoteMatch,
  storageObjectId: string,
  xml: string,
) {
  if (!remote.order_id || remote.match_status !== "MATCHED") return null;
  const imported = acceptedInvoiceFromXml(xml, new Date().toISOString());
  const identity = acceptedDocumentFiscalIdentity(xml);
  const profile = await activeFiscalProfile(client);
  if (
    !profile ||
    !remoteFiscalIdentityMatches(remote, identity) ||
    !acceptedProfileMatches(profile.profile, identity)
  ) {
    throw new AppError("ARUBA_PROFILE_CONFLICT", 409);
  }
  const evidenceRemote: RemoteInventoryDocument = {
    remoteId: remote.remote_id,
    documentType: "TD01",
    fiscalYear: remote.fiscal_year,
    series: remote.series,
    fiscalNumber: remote.fiscal_number,
    documentDate: remote.document_date,
    recipientName: acceptedRecipientName(imported.input.recipient),
    recipientTaxId: imported.input.recipient.taxIdentifiers[0]?.value ?? null,
    recipientCountryCode: imported.input.recipient.address.countryCode,
    recipientAddress: [
      imported.input.recipient.address.line1,
      imported.input.recipient.address.postalCode,
      imported.input.recipient.address.city,
      imported.input.recipient.address.countryCode,
    ].join(" "),
    totalAmount: imported.totalAmount,
    currency: "EUR",
    status: remote.remote_status,
    providerObservedAt: null,
    xmlSha256: createHash("sha256").update(xml).digest("hex"),
    orderReferences: imported.references,
  };
  const candidates = await orderCandidates(client, evidenceRemote);
  const individualCandidates = candidates.map((candidate) => ({
    id: candidate.id,
    billingCaseId: candidate.billing_case_id,
    provider: candidate.provider,
    displayNumber: candidate.display_number,
    localOrderDate: candidate.local_order_date,
    billableAmount: candidate.billable_amount,
    recipientName: candidate.recipient_name,
    recipientTaxIds: candidate.recipient_tax_ids,
    recipientAddress: candidate.recipient_address,
  }));
  const groupedCandidates = groupOrderCandidates(individualCandidates).filter(
    (candidate) => (candidate.orderIds?.length ?? 1) > 1,
  );
  const verified = selectOrderMatch(evidenceRemote, [
    ...individualCandidates,
    ...groupedCandidates,
  ]);
  const selectedEvaluation =
    verified.status === "MATCHED"
      ? verified.evaluations.find((candidate) => candidate.compatible)
      : null;
  if (selectedEvaluation?.candidateId !== remote.order_id) {
    throw new AppError("ARUBA_PROFILE_CONFLICT", 409);
  }
  const matchedOrderIds = selectedEvaluation.orderIds;
  const matchedOrderIdSet = new Set(matchedOrderIds);
  await serializeOrderMutations(client);
  const order = await client.query<{
    id: string;
    customer_id: string;
    billing_case_id: string | null;
    customer_snapshot: Record<string, unknown>;
    canonical_billable_amount: number;
  }>(
    `SELECT orders.id, orders.customer_id, orders.billing_case_id,
            (orders.gross_amount - orders.deducted_shopify_payments_fee_amount - coalesce((
              SELECT sum(refunds.amount) FROM refunds
              WHERE refunds.order_id = orders.id AND refunds.applied_before_issue
            ), 0))::integer AS canonical_billable_amount,
            orders.normalized_snapshot_json -> 'customerSnapshot' AS customer_snapshot
     FROM orders WHERE orders.id = ANY($1::bigint[]) ORDER BY orders.id FOR UPDATE`,
    [matchedOrderIds],
  );
  const currentOrder = order.rows[0];
  if (
    !currentOrder ||
    order.rows.length !== matchedOrderIds.length ||
    order.rows.reduce((sum, item) => sum + item.canonical_billable_amount, 0) !==
      imported.totalAmount ||
    new Set(order.rows.map((item) => item.customer_id)).size !== 1 ||
    new Set(order.rows.map((item) => item.billing_case_id)).size !== 1
  ) {
    throw new AppError("ARUBA_PROFILE_CONFLICT", 409);
  }
  const digest = createHash("sha256").update(xml).digest("hex");
  const existing = await client.query<{ id: string; origin: string; xml_sha256: string }>(
    `SELECT id, origin, xml_sha256 FROM documents
     WHERE series = $1 AND fiscal_year = $2 AND fiscal_number = $3 FOR UPDATE`,
    [profile.profile.series, imported.year, imported.number],
  );
  let documentId = existing.rows[0]?.id ?? null;
  if (existing.rows[0] && existing.rows[0].xml_sha256 !== digest) {
    throw new AppError("ARUBA_INVENTORY_CONFLICT", 409);
  }
  const priorInvoiceLinks = await client.query<{ document_id: string }>(
    `SELECT document_orders.document_id
     FROM document_orders
     JOIN documents ON documents.id = document_orders.document_id
     WHERE document_orders.order_id = ANY($1::bigint[])
       AND document_orders.document_kind = 'INVOICE' AND documents.status = 'APPROVED'
     FOR UPDATE OF document_orders`,
    [matchedOrderIds],
  );
  if (priorInvoiceLinks.rows.some((link) => !documentId || link.document_id !== documentId)) {
    throw new AppError("ARUBA_INVENTORY_CONFLICT", 409);
  }
  if (documentId && existing.rows[0]?.origin === "HUB") {
    const localLink = await client.query<{ order_id: string }>(
      `SELECT order_id FROM document_orders
       WHERE document_id = $1 AND document_kind = 'INVOICE' FOR UPDATE`,
      [documentId],
    );
    if (
      localLink.rows.length !== matchedOrderIds.length ||
      localLink.rows.some((row) => !matchedOrderIdSet.has(row.order_id))
    ) {
      throw new AppError("ARUBA_INVENTORY_CONFLICT", 409);
    }
    await client.query(
      `UPDATE aruba_document_matches SET document_id = $2, billing_case_id =
         (SELECT billing_case_id FROM documents WHERE id = $2), updated_at = now()
       WHERE remote_document_id = $1`,
      [remote.id, documentId],
    );
    await client.query(
      `UPDATE aruba_remote_documents SET origin = 'HUB_SUBMISSION' WHERE id = $1`,
      [remote.id],
    );
    return documentId;
  }
  if (!documentId) {
    const historicalCase = await client.query<{ id: string }>(
      `INSERT INTO billing_cases
        (customer_id, local_order_date, currency, status, customer_snapshot_json,
         fiscal_profile_version)
       VALUES ($1, $2, 'EUR', 'CLOSED', $3, $4) RETURNING id`,
      [
        currentOrder.customer_id,
        imported.documentDate,
        JSON.stringify(currentOrder.customer_snapshot),
        profile.version,
      ],
    );
    const snapshot = {
      generatorVersion: 2,
      ...imported.input,
      sourceTotal: imported.totalAmount,
      total: imported.totalAmount,
      difference: 0,
      differenceReason: null,
    };
    const document = await client.query<{ id: string }>(
      `INSERT INTO documents
        (billing_case_id, kind, status, document_type, series, fiscal_year, fiscal_number,
         document_date, fiscal_profile_version, currency, total_amount, source_total_amount,
         difference_amount, projection_sha256, approved_at, xml_sha256,
         immutable_snapshot_json, fiscal_profile_snapshot_json, storage_object_id,
         payment_status, payment_method, recipient_snapshot_json, origin)
       VALUES ($1, 'INVOICE', 'APPROVED', 'TD01', $2, $3, $4, $5, $6, 'EUR',
         $7, $7, 0, $8, now(), $8, $9, $10, $11, 'PAID', $12, $13, 'ARUBA_HISTORY')
       RETURNING id`,
      [
        historicalCase.rows[0]!.id,
        profile.profile.series,
        imported.year,
        imported.number,
        imported.documentDate,
        profile.version,
        imported.totalAmount,
        digest,
        JSON.stringify(snapshot),
        JSON.stringify(imported.profile),
        storageObjectId,
        imported.input.paymentMethod,
        JSON.stringify(imported.input.recipient),
      ],
    );
    documentId = document.rows[0]!.id;
  }
  const alreadyLinked = await client.query<{ order_id: string }>(
    `SELECT order_id FROM document_orders
     WHERE document_id = $1 AND document_kind = 'INVOICE' FOR UPDATE`,
    [documentId],
  );
  if (alreadyLinked.rows.some((row) => !matchedOrderIdSet.has(row.order_id))) {
    throw new AppError("ARUBA_INVENTORY_CONFLICT", 409);
  }
  await client.query(
    `DELETE FROM document_lines
     WHERE order_id = ANY($1::bigint[]) AND document_id IN (
       SELECT id FROM documents WHERE kind = 'INVOICE' AND status = 'DRAFT'
     )`,
    [matchedOrderIds],
  );
  await client.query(
    `DELETE FROM document_orders
     WHERE order_id = ANY($1::bigint[]) AND document_kind = 'INVOICE'
       AND document_id IN (SELECT id FROM documents WHERE status = 'DRAFT')`,
    [matchedOrderIds],
  );
  await client.query(
    `INSERT INTO document_orders (document_id, document_kind, order_id, amount)
     SELECT $1, 'INVOICE', source.order_id, source.amount
     FROM unnest($2::bigint[], $3::integer[]) AS source(order_id, amount)
     ON CONFLICT (document_id, order_id) DO NOTHING`,
    [
      documentId,
      order.rows.map((item) => item.id),
      order.rows.map((item) => item.canonical_billable_amount),
    ],
  );
  const previousCaseId = currentOrder.billing_case_id;
  await client.query(
    `UPDATE orders SET trigger_status = 'INVOICED', billing_case_id = NULL
     WHERE id = ANY($1::bigint[])`,
    [matchedOrderIds],
  );
  if (previousCaseId) {
    const remaining = await client.query<{ count: string }>(
      `SELECT count(*) FROM orders WHERE billing_case_id = $1`,
      [previousCaseId],
    );
    if (Number(remaining.rows[0]!.count) === 0) {
      await client.query(
        `DELETE FROM documents WHERE billing_case_id = $1 AND kind = 'INVOICE' AND status = 'DRAFT'`,
        [previousCaseId],
      );
      await client.query(
        `UPDATE billing_cases SET status = 'CLOSED', revision = revision + 1, updated_at = now()
         WHERE id = $1 AND status IN ('DRAFT', 'READY', 'NEEDS_REVIEW')`,
        [previousCaseId],
      );
    } else {
      await regenerateResidualInvoiceDraft(client, previousCaseId);
      await client.query(
        `UPDATE billing_cases SET revision = revision + 1, updated_at = now()
         WHERE id = $1 AND status IN ('DRAFT', 'READY', 'NEEDS_REVIEW')`,
        [previousCaseId],
      );
    }
  }
  await client.query(
    `UPDATE aruba_document_matches SET document_id = $2, billing_case_id =
       (SELECT billing_case_id FROM documents WHERE id = $2), updated_at = now()
     WHERE remote_document_id = $1`,
    [remote.id, documentId],
  );
  await client.query(`UPDATE aruba_remote_documents SET origin = 'ARUBA_EXTERNAL' WHERE id = $1`, [
    remote.id,
  ]);
  return documentId;
}

async function materializeExternalCreditNote(
  client: pg.PoolClient,
  remote: LockedRemoteMatch,
  storageObjectId: string,
  xml: string,
) {
  if (
    !remote.order_id ||
    !remote.related_invoice_document_id ||
    remote.match_status !== "MATCHED"
  ) {
    return null;
  }
  const imported = acceptedCreditNoteFromXml(xml);
  const identity = acceptedDocumentFiscalIdentity(xml);
  const profile = await activeFiscalProfile(client);
  if (
    !profile ||
    !remoteFiscalIdentityMatches(remote, identity) ||
    !acceptedProfileMatches(profile.profile, identity)
  ) {
    throw new AppError("ARUBA_PROFILE_CONFLICT", 409);
  }
  await serializeOrderMutations(client);
  const invoice = await client.query<{
    id: string;
    billing_case_id: string;
    series: string;
    fiscal_year: number;
    fiscal_number: number;
    document_date: string;
    recipient_snapshot_json: unknown;
  }>(
    `SELECT id, billing_case_id, series, fiscal_year, fiscal_number,
            document_date::text, recipient_snapshot_json
     FROM documents WHERE id = $1 AND kind = 'INVOICE' AND status = 'APPROVED' FOR UPDATE`,
    [remote.related_invoice_document_id],
  );
  const sourceInvoice = invoice.rows[0];
  if (!sourceInvoice) throw new AppError("ARUBA_PROFILE_CONFLICT", 409);
  const invoiceLabel = `${sourceInvoice.series} ${String(sourceInvoice.fiscal_number).padStart(4, "0")}/${String(sourceInvoice.fiscal_year).slice(-2)}`;
  if (
    imported.linkedInvoices.length > 0 &&
    !imported.linkedInvoices.some(
      (linked) =>
        linked.number === invoiceLabel &&
        (!linked.date || linked.date === sourceInvoice.document_date),
    )
  ) {
    throw new AppError("ARUBA_PROFILE_CONFLICT", 409);
  }
  if (!remote.refund_ids.length) throw new AppError("ARUBA_PROFILE_CONFLICT", 409);
  const refunds = await client.query<{
    id: string;
    amount: number;
    order_id: string;
    credit_document_id: string | null;
  }>(
    `SELECT refunds.id, refunds.amount, refunds.order_id, refunds.credit_document_id
     FROM refunds
     JOIN document_orders AS invoice_order
       ON invoice_order.document_id = $2 AND invoice_order.document_kind = 'INVOICE'
      AND invoice_order.order_id = refunds.order_id
     WHERE refunds.id = ANY($1::bigint[]) AND refunds.status = 'COMPLETED'
       AND refunds.amount > 0
     ORDER BY refunds.id FOR UPDATE OF refunds`,
    [remote.refund_ids, sourceInvoice.id],
  );
  const refundTotal = refunds.rows.reduce((sum, refund) => sum + refund.amount, 0);
  const assignedDraftIds = [
    ...new Set(refunds.rows.flatMap((refund) => refund.credit_document_id ?? [])),
  ];
  let assignedDraftId: string | null = null;
  if (assignedDraftIds.length === 1) {
    const assignedDraft = await client.query<{ id: string }>(
      `SELECT documents.id FROM documents
       JOIN document_links ON document_links.document_id = documents.id
       WHERE documents.id = $1 AND documents.kind = 'CREDIT_NOTE' AND documents.status = 'DRAFT'
         AND document_links.related_document_id = $2
         AND document_links.relation_type = 'CREDIT_NOTE_FOR_INVOICE'
       FOR UPDATE OF documents`,
      [assignedDraftIds[0], sourceInvoice.id],
    );
    assignedDraftId = assignedDraft.rows[0]?.id ?? null;
  }
  if (
    refunds.rowCount !== remote.refund_ids.length ||
    refundTotal !== imported.totalAmount ||
    assignedDraftIds.length > 1 ||
    (assignedDraftIds.length === 1 && !assignedDraftId)
  ) {
    throw new AppError("ARUBA_PROFILE_CONFLICT", 409);
  }
  const digest = createHash("sha256").update(xml).digest("hex");
  const existing = await client.query<{ id: string; origin: string; xml_sha256: string }>(
    `SELECT id, origin, xml_sha256 FROM documents
     WHERE series = $1 AND fiscal_year = $2 AND fiscal_number = $3 FOR UPDATE`,
    [profile.profile.series, imported.year, imported.number],
  );
  let documentId = existing.rows[0]?.id ?? assignedDraftId;
  if (existing.rows[0] && existing.rows[0].xml_sha256 !== digest) {
    throw new AppError("ARUBA_INVENTORY_CONFLICT", 409);
  }
  if (documentId && existing.rows[0]?.origin === "HUB") {
    const localLink = await client.query<{ order_id: string }>(
      `SELECT order_id FROM document_orders
       WHERE document_id = $1 AND document_kind = 'CREDIT_NOTE' FOR UPDATE`,
      [documentId],
    );
    const matchedOrderIds = new Set(refunds.rows.map((refund) => refund.order_id));
    if (
      localLink.rows.length !== matchedOrderIds.size ||
      localLink.rows.some((row) => !matchedOrderIds.has(row.order_id))
    ) {
      throw new AppError("ARUBA_INVENTORY_CONFLICT", 409);
    }
    await client.query(
      `UPDATE aruba_document_matches SET document_id = $2, updated_at = now()
       WHERE remote_document_id = $1`,
      [remote.id, documentId],
    );
    await client.query(
      `UPDATE aruba_remote_documents SET origin = 'HUB_SUBMISSION' WHERE id = $1`,
      [remote.id],
    );
    return documentId;
  }
  const shouldAdoptDraft = !existing.rows[0];
  if (!documentId) {
    const draft = await client.query<{ id: string }>(
      `INSERT INTO documents
        (billing_case_id, kind, status, document_type, series, document_date,
         fiscal_profile_version, currency, total_amount, source_total_amount,
         difference_amount, draft_version, projection_sha256, payment_status,
         payment_method, recipient_snapshot_json)
       VALUES ($1, 'CREDIT_NOTE', 'DRAFT', 'TD04', $2, $3, $4, 'EUR', $5, $5,
         0, 1, $6, 'PAID', 'MP05', $7) RETURNING id`,
      [
        sourceInvoice.billing_case_id,
        profile.profile.series,
        imported.documentDate,
        profile.version,
        imported.totalAmount,
        digest,
        JSON.stringify(sourceInvoice.recipient_snapshot_json),
      ],
    );
    documentId = draft.rows[0]!.id;
    await client.query(
      `INSERT INTO document_links (document_id, related_document_id, relation_type)
       VALUES ($1, $2, 'CREDIT_NOTE_FOR_INVOICE')`,
      [documentId, sourceInvoice.id],
    );
    await client.query(
      `INSERT INTO document_orders (document_id, document_kind, order_id, amount)
       SELECT $1, 'CREDIT_NOTE', refunds.order_id, sum(refunds.amount)::integer
       FROM refunds WHERE refunds.id = ANY($2::bigint[])
       GROUP BY refunds.order_id`,
      [documentId, refunds.rows.map((refund) => refund.id)],
    );
    await client.query(
      `UPDATE refunds SET credit_document_id = $2, updated_at = now()
       WHERE id = ANY($1::bigint[])
         AND (credit_document_id IS NULL OR credit_document_id = $2)`,
      [refunds.rows.map((refund) => refund.id), documentId],
    );
  }
  if (shouldAdoptDraft) {
    const linkedOrders = await client.query<{ order_id: string; amount: number }>(
      `SELECT order_id, amount FROM document_orders
       WHERE document_id = $1 AND document_kind = 'CREDIT_NOTE' FOR UPDATE`,
      [documentId],
    );
    const matchedOrderIds = new Set(refunds.rows.map((refund) => refund.order_id));
    if (
      linkedOrders.rows.length !== matchedOrderIds.size ||
      linkedOrders.rows.some((row) => !matchedOrderIds.has(row.order_id)) ||
      linkedOrders.rows.reduce((sum, row) => sum + row.amount, 0) !== imported.totalAmount
    ) {
      throw new AppError("ARUBA_PROFILE_CONFLICT", 409);
    }
    const snapshot = {
      generatorVersion: 2,
      kind: "CREDIT_NOTE",
      documentDate: imported.documentDate,
      recipient: sourceInvoice.recipient_snapshot_json,
      lines: imported.lines.map((line) => ({ ...line, orderId: remote.order_id })),
      paymentStatus: "PAID",
      paymentMethod: "MP05",
      relatedInvoice: { number: invoiceLabel, date: sourceInvoice.document_date },
      sourceTotal: imported.totalAmount,
      total: imported.totalAmount,
      difference: 0,
      differenceReason: null,
    };
    await client.query(
      `UPDATE documents SET status = 'APPROVED', origin = 'ARUBA_HISTORY',
         fiscal_year = $2, fiscal_number = $3, approved_at = now(), xml_sha256 = $4,
         immutable_snapshot_json = $5, fiscal_profile_snapshot_json = $6,
         storage_object_id = $7, updated_at = now()
       WHERE id = $1`,
      [
        documentId,
        imported.year,
        imported.number,
        digest,
        JSON.stringify(snapshot),
        JSON.stringify(profile.profile),
        storageObjectId,
      ],
    );
  }
  await client.query(
    `UPDATE aruba_document_matches SET document_id = $2, updated_at = now()
     WHERE remote_document_id = $1`,
    [remote.id, documentId],
  );
  await client.query(`UPDATE aruba_remote_documents SET origin = 'ARUBA_EXTERNAL' WHERE id = $1`, [
    remote.id,
  ]);
  return documentId;
}

async function materializeMatchedExternalDocument(
  client: pg.PoolClient,
  remoteDocumentId: string,
  storageObjectId: string,
  xml: string,
) {
  const remote = await lockedRemoteMatch(client, remoteDocumentId);
  if (!remote || !isEmissionConfirmed(remote.remote_status)) return null;
  return remote.document_type === "TD01"
    ? materializeExternalInvoice(client, remote, storageObjectId, xml)
    : materializeExternalCreditNote(client, remote, storageObjectId, xml);
}

async function importArubaRemoteOfficialFileAuthorized(
  authorization: string | ArubaReadActor,
  remoteReference: string,
  rawKind: unknown,
  bytes: Buffer,
) {
  const kind = arubaFileKindSchema.safeParse(rawKind);
  const reference = z.string().trim().min(1).max(200).safeParse(remoteReference);
  if (!kind.success || !reference.success || bytes.byteLength > ARUBA_IMPORT_MAX_BYTES) {
    throw new AppError("ARUBA_INVENTORY_INVALID", 422);
  }
  try {
    validateOfficialFile(kind.data, bytes);
  } catch {
    throw new AppError("ARUBA_INVENTORY_INVALID", 422);
  }
  const session =
    typeof authorization === "string"
      ? await loadReadSession(getPool(), authorization)
      : {
          id: `manual:${authorization.id}`,
          environment: environment(),
          account_reference: accountReference(),
        };
  if (!session) throw new AppError("ARUBA_READ_SESSION_INVALID", 401);
  if (typeof authorization !== "string" && !authorization.canApprove) {
    throw new AppError("ARUBA_READ_SESSION_FORBIDDEN", 403);
  }
  const digest = createHash("sha256").update(bytes).digest("hex");
  const resolved = await getPool().query<{ id: string }>(
    `SELECT id FROM aruba_remote_documents
     WHERE environment = $1 AND account_reference = $2
       AND (id::text = $3 OR remote_id = $3) LIMIT 1`,
    [session.environment, session.account_reference, reference.data],
  );
  const remoteDocumentId = resolved.rows[0]?.id;
  if (!remoteDocumentId) throw new AppError("ARUBA_INVENTORY_INVALID", 404);
  const duplicate = await getPool().query<{
    id: string;
    document_id: string | null;
    storage_object_id: string;
  }>(
    `SELECT files.id, files.document_id, files.storage_object_id FROM aruba_files AS files
     JOIN aruba_remote_documents AS remote ON remote.id = files.remote_document_id
     JOIN storage_objects AS storage ON storage.id = files.storage_object_id
     WHERE remote.id = $1 AND remote.environment = $2 AND remote.account_reference = $3
       AND files.kind = $4 AND storage.sha256 = $5 LIMIT 1`,
    [remoteDocumentId, session.environment, session.account_reference, kind.data, digest],
  );
  if (duplicate.rows[0]) {
    let documentId = duplicate.rows[0].document_id;
    if (kind.data === "ARUBA_XML" && !documentId) {
      const xml = validateUntrustedXml(bytes);
      documentId = await withTransaction((client) =>
        materializeMatchedExternalDocument(
          client,
          remoteDocumentId,
          duplicate.rows[0]!.storage_object_id,
          xml,
        ),
      );
      if (documentId) {
        await getPool().query(`UPDATE aruba_files SET document_id = $2 WHERE id = $1`, [
          duplicate.rows[0].id,
          documentId,
        ]);
      }
    }
    return {
      id: duplicate.rows[0].id,
      repeated: true,
      documentId,
    };
  }
  let xml: string | null = null;
  if (kind.data === "ARUBA_XML") {
    try {
      xml = validateUntrustedXml(bytes);
      await validateFatturaXml(xml);
      acceptedDocumentFiscalIdentity(xml);
    } catch {
      throw new AppError("ARUBA_INVENTORY_INVALID", 422);
    }
  }
  const stored = await storeImportedFile(`remote-${remoteDocumentId}`, kind.data, bytes);
  try {
    const outcome = await withTransaction(async (client) => {
      const lockedSession =
        typeof authorization === "string"
          ? await loadReadSession(client, authorization, true)
          : session;
      if (!lockedSession) throw new AppError("ARUBA_READ_SESSION_INVALID", 401);
      const remote = await client.query<{ id: string; xml_sha256: string | null }>(
        `SELECT id, xml_sha256 FROM aruba_remote_documents
         WHERE id = $1 AND environment = $2 AND account_reference = $3 FOR UPDATE`,
        [remoteDocumentId, lockedSession.environment, lockedSession.account_reference],
      );
      if (!remote.rows[0]) throw new AppError("ARUBA_INVENTORY_INVALID", 404);
      if (
        kind.data === "ARUBA_XML" &&
        remote.rows[0].xml_sha256 &&
        remote.rows[0].xml_sha256 !== digest
      ) {
        throw new AppError("ARUBA_INVENTORY_CONFLICT", 409);
      }
      const concurrentDuplicate = await client.query<{
        id: string;
        document_id: string | null;
      }>(
        `SELECT files.id, files.document_id FROM aruba_files AS files
         JOIN storage_objects AS storage ON storage.id = files.storage_object_id
         WHERE files.remote_document_id = $1 AND files.kind = $2
           AND storage.sha256 = $3 LIMIT 1`,
        [remoteDocumentId, kind.data, digest],
      );
      if (concurrentDuplicate.rows[0]) {
        return {
          id: concurrentDuplicate.rows[0].id,
          repeated: true,
          documentId: concurrentDuplicate.rows[0].document_id,
        };
      }
      const contentType =
        kind.data === "ARUBA_PDF"
          ? "application/pdf"
          : kind.data === "ARUBA_P7M"
            ? "application/pkcs7-mime"
            : "application/xml";
      const storage = await client.query<{ id: string }>(
        `INSERT INTO storage_objects (kind, relative_path, sha256, size_bytes, content_type)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [kind.data, stored.relativePath, digest, bytes.byteLength, contentType],
      );
      const documentId = xml
        ? await materializeMatchedExternalDocument(
            client,
            remoteDocumentId,
            storage.rows[0]!.id,
            xml,
          )
        : null;
      const file = await client.query<{ id: string }>(
        `INSERT INTO aruba_files
          (document_id, remote_document_id, storage_object_id, kind, metadata_json)
         VALUES ($1, $2, $3, $4, jsonb_build_object('sha256', $5::text)) RETURNING id`,
        [documentId, remoteDocumentId, storage.rows[0]!.id, kind.data, digest],
      );
      if (kind.data === "ARUBA_XML") {
        await client.query(
          `UPDATE aruba_remote_documents SET xml_sha256 = $2,
             last_observed_at = now() WHERE id = $1`,
          [remoteDocumentId, digest],
        );
      }
      if (kind.data === "SDI_NOTIFICATION") {
        const status = notificationStatus(bytes.toString("utf8"));
        const transition = await client.query<{ remote_status: ArubaRemoteStatus }>(
          `SELECT remote_status FROM aruba_remote_documents WHERE id = $1 FOR UPDATE`,
          [remoteDocumentId],
        );
        const statusTransition = remoteStatusTransition(transition.rows[0]!.remote_status, status);
        if (statusTransition === "CONFLICT") {
          await client.query(
            `UPDATE aruba_document_matches SET status = 'UNKNOWN_REMOTE_STATE', method = 'NONE',
               updated_at = now() WHERE remote_document_id = $1`,
            [remoteDocumentId],
          );
        } else if (statusTransition === "APPLY") {
          await client.query(
            `UPDATE aruba_remote_documents SET remote_status = $2,
               remote_status_observed_at = now(), last_observed_at = now() WHERE id = $1`,
            [remoteDocumentId, status],
          );
          if (isEmissionConfirmed(status)) {
            const officialXml = await client.query<{
              storage_object_id: string;
              relative_path: string;
            }>(
              `SELECT files.storage_object_id, storage.relative_path
               FROM aruba_files files
               JOIN storage_objects storage ON storage.id = files.storage_object_id
               WHERE files.remote_document_id = $1 AND files.kind = 'ARUBA_XML'
               ORDER BY files.imported_at DESC LIMIT 1`,
              [remoteDocumentId],
            );
            if (officialXml.rows[0]) {
              const root = path.resolve(getConfig().DOCUMENT_STORAGE_ROOT);
              const absolutePath = path.resolve(root, officialXml.rows[0].relative_path);
              if (!absolutePath.startsWith(`${root}${path.sep}`)) {
                throw new AppError("DOCUMENT_STORAGE_FAILED", 500);
              }
              await materializeMatchedExternalDocument(
                client,
                remoteDocumentId,
                officialXml.rows[0].storage_object_id,
                validateUntrustedXml(await readFile(absolutePath)),
              );
            }
          }
        }
        await client.query(
          `INSERT INTO sdi_notifications
            (remote_document_id, remote_notification_id, type, status, storage_object_id, metadata_json)
           VALUES ($1, $2, $3, $3, $4, '{}')
           ON CONFLICT (remote_document_id, remote_notification_id) DO NOTHING`,
          [remoteDocumentId, digest, status, storage.rows[0]!.id],
        );
      }
      await writeAudit(client, {
        actorType: "SYSTEM",
        action: "ARUBA_FILE_IMPORTED",
        eventClass: "CRITICAL",
        entityType: "DOCUMENT",
        entityId: remoteDocumentId,
        metadata: { fileKind: kind.data },
        requestId:
          typeof authorization === "string"
            ? `aruba-read:${lockedSession.id}`
            : authorization.requestId,
      });
      return { id: file.rows[0]!.id, repeated: false, documentId };
    });
    if (outcome.repeated) await unlink(stored.absolutePath).catch(() => undefined);
    return outcome;
  } catch (error) {
    await unlink(stored.absolutePath).catch(() => undefined);
    throw error;
  }
}

export async function importArubaRemoteOfficialFile(
  token: string,
  remoteReference: string,
  rawKind: unknown,
  bytes: Buffer,
) {
  return importArubaRemoteOfficialFileAuthorized(token, remoteReference, rawKind, bytes);
}

export async function importArubaRemoteOfficialFileAsActor(
  remoteReference: string,
  rawKind: unknown,
  bytes: Buffer,
  actor: ArubaReadActor,
) {
  return importArubaRemoteOfficialFileAuthorized(actor, remoteReference, rawKind, bytes);
}

async function ingestParsedArubaPage(
  client: pg.PoolClient,
  session: ReadSessionRow,
  page: z.infer<typeof inventoryPageSchema>,
  updateCursor = true,
) {
  const requestedFiles: Array<{
    remoteId: string;
    kind: "ARUBA_XML" | "ARUBA_P7M" | "ARUBA_PDF" | "SDI_NOTIFICATION";
  }> = [];
  const digest = payloadDigest(page);
  const existingPage = await client.query<{ payload_digest: string }>(
    `SELECT payload_digest FROM aruba_sync_pages
       WHERE sync_session_id = $1 AND stream = $2 AND scan_ordinal = $3 AND page_ordinal = $4`,
    [session.id, page.stream, page.scanOrdinal, page.pageOrdinal],
  );
  if (existingPage.rows[0]) {
    if (existingPage.rows[0].payload_digest !== digest) {
      throw new AppError("ARUBA_INVENTORY_CONFLICT", 409);
    }
    for (const remote of page.documents) {
      const stored = await client.query<{ id: string }>(
        `SELECT id FROM aruba_remote_documents
         WHERE environment = $1 AND account_reference = $2 AND remote_id = $3`,
        [session.environment, session.account_reference, remote.remoteId],
      );
      if (!stored.rows[0]) throw new AppError("ARUBA_INVENTORY_CONFLICT", 409);
      const files = await client.query<{ kind: string }>(
        `SELECT kind FROM aruba_files WHERE remote_document_id = $1`,
        [stored.rows[0].id],
      );
      const knownKinds = new Set(files.rows.map((file) => file.kind));
      for (const kind of ["ARUBA_XML", "ARUBA_P7M", "ARUBA_PDF"] as const) {
        if (!knownKinds.has(kind)) requestedFiles.push({ remoteId: remote.remoteId, kind });
      }
      if (!knownKinds.has("SDI_NOTIFICATION") || !isEmissionConfirmed(remote.status)) {
        requestedFiles.push({ remoteId: remote.remoteId, kind: "SDI_NOTIFICATION" });
      }
    }
    return { repeated: true, documents: page.documents.length, requestedFiles };
  }
  for (const remote of page.documents) {
    const metadataDigest = remoteMetadataDigest(remote);
    const existing = await client.query<{
      id: string;
      remote_status: ArubaRemoteStatus;
      metadata_digest: string;
    }>(
      `SELECT id, remote_status, metadata_digest FROM aruba_remote_documents
         WHERE environment = $1 AND account_reference = $2 AND remote_id = $3
         FOR UPDATE`,
      [session.environment, session.account_reference, remote.remoteId],
    );
    const current = existing.rows[0];
    const transition = remoteStatusTransition(current?.remote_status ?? null, remote.status);
    let conflicted = false;
    if (
      transition === "CONFLICT" ||
      (current &&
        current.metadata_digest !== metadataDigest &&
        isEmissionConfirmed(current.remote_status))
    ) {
      conflicted = true;
      if (current) {
        await client.query(
          `INSERT INTO aruba_document_matches
              (remote_document_id, status, method, matcher_version, signals_json, candidates_json)
             VALUES ($1, 'UNKNOWN_REMOTE_STATE', 'NONE', $2, '{}', '[]')
             ON CONFLICT (remote_document_id) DO UPDATE SET
               status = 'UNKNOWN_REMOTE_STATE', method = 'NONE', updated_at = now()`,
          [current.id, MATCHER_VERSION],
        );
      }
    }
    let storedId = current?.id;
    if (!current) {
      const collision = await client.query<{ id: string; remote_id: string }>(
        `SELECT id, remote_id FROM aruba_remote_documents
         WHERE environment = $1 AND account_reference = $2 AND (
           ($3::text IS NOT NULL AND fiscal_year = $4 AND upper(series) = upper($3)
             AND upper(fiscal_number) = upper($5) AND document_type = $6)
           OR ($7::text IS NOT NULL AND xml_sha256 = $7)
         ) FOR UPDATE`,
        [
          session.environment,
          session.account_reference,
          remote.series,
          remote.fiscalYear,
          remote.fiscalNumber,
          remote.documentType,
          remote.xmlSha256,
        ],
      );
      const collided = collision.rows[0];
      if (collided?.remote_id.startsWith("historical-document-")) {
        await client.query(
          `UPDATE aruba_remote_documents SET remote_id = $2, document_type = $3,
             fiscal_year = $4, series = $5, fiscal_number = $6, document_date = $7,
             recipient_name_normalized = $8, recipient_tax_id_normalized = $9,
             recipient_country_code = $10, recipient_address_normalized = $11,
             total_amount = $12, currency = $13, remote_status = $14,
             remote_status_observed_at = coalesce($15::timestamptz, now()),
             xml_sha256 = coalesce($16, xml_sha256), last_observed_at = now(),
             last_full_scan_at = CASE WHEN $17 THEN now() ELSE last_full_scan_at END,
             inventory_version = inventory_version + 1, metadata_digest = $18
           WHERE id = $1`,
          [
            collided.id,
            remote.remoteId,
            remote.documentType,
            remote.fiscalYear,
            remote.series,
            remote.fiscalNumber,
            remote.documentDate,
            normalizedMatchText(remote.recipientName),
            normalizedMatchText(remote.recipientTaxId),
            remote.recipientCountryCode,
            normalizedMatchText(remote.recipientAddress),
            remote.totalAmount,
            remote.currency,
            remote.status,
            remote.providerObservedAt,
            remote.xmlSha256,
            page.fullScan,
            metadataDigest,
          ],
        );
        storedId = collided.id;
      } else if (collided) {
        conflicted = true;
        storedId = collided.id;
        await client.query(
          `INSERT INTO aruba_deduplication_conflicts
             (environment, account_reference, existing_remote_document_id, incoming_remote_id,
              collision_key, incoming_payload_digest, sync_session_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT DO NOTHING`,
          [
            session.environment,
            session.account_reference,
            collided.id,
            remote.remoteId,
            remote.xmlSha256 ? "XML_SHA256" : "FISCAL_IDENTITY",
            metadataDigest,
            session.id,
          ],
        );
        await client.query(
          `INSERT INTO aruba_document_matches
             (remote_document_id, status, method, matcher_version, signals_json, candidates_json)
           VALUES ($1, 'ERROR', 'NONE', $2, '{"deduplicationCollision":true}', '[]')
           ON CONFLICT (remote_document_id) DO UPDATE SET
             status = 'ERROR', method = 'NONE', updated_at = now()`,
          [collided.id, MATCHER_VERSION],
        );
      }
    }
    if (!storedId) {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO aruba_remote_documents
            (environment, account_reference, remote_id, document_type, fiscal_year, series,
             fiscal_number, document_date, recipient_name_normalized,
             recipient_tax_id_normalized, recipient_country_code,
             recipient_address_normalized, total_amount, currency, remote_status,
             remote_status_observed_at, xml_sha256, origin, last_full_scan_at, metadata_digest)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
                   $15, coalesce($16::timestamptz, now()), $17, 'UNKNOWN',
                   CASE WHEN $18 THEN now() ELSE NULL END, $19)
           RETURNING id`,
        [
          session.environment,
          session.account_reference,
          remote.remoteId,
          remote.documentType,
          remote.fiscalYear,
          remote.series,
          remote.fiscalNumber,
          remote.documentDate,
          normalizedMatchText(remote.recipientName),
          normalizedMatchText(remote.recipientTaxId),
          remote.recipientCountryCode,
          normalizedMatchText(remote.recipientAddress),
          remote.totalAmount,
          remote.currency,
          remote.status,
          remote.providerObservedAt,
          remote.xmlSha256,
          page.fullScan,
          metadataDigest,
        ],
      );
      storedId = inserted.rows[0]!.id;
    } else if (current && transition === "APPLY" && !conflicted) {
      await client.query(
        `UPDATE aruba_remote_documents SET
             document_type = $2, fiscal_year = $3, series = $4, fiscal_number = $5,
             document_date = $6, recipient_name_normalized = $7,
             recipient_tax_id_normalized = $8, recipient_country_code = $9,
             recipient_address_normalized = $10, total_amount = $11, currency = $12,
             remote_status = $13, remote_status_observed_at = coalesce($14::timestamptz, now()),
             xml_sha256 = coalesce($15, xml_sha256), last_observed_at = now(),
             last_full_scan_at = CASE WHEN $16 THEN now() ELSE last_full_scan_at END,
             inventory_version = inventory_version + 1, metadata_digest = $17
           WHERE id = $1`,
        [
          current.id,
          remote.documentType,
          remote.fiscalYear,
          remote.series,
          remote.fiscalNumber,
          remote.documentDate,
          normalizedMatchText(remote.recipientName),
          normalizedMatchText(remote.recipientTaxId),
          remote.recipientCountryCode,
          normalizedMatchText(remote.recipientAddress),
          remote.totalAmount,
          remote.currency,
          remote.status,
          remote.providerObservedAt,
          remote.xmlSha256,
          page.fullScan,
          metadataDigest,
        ],
      );
    }
    await client.query(
      `INSERT INTO aruba_remote_observations
          (remote_document_id, sync_session_id, remote_status, provider_observed_at,
           stream, scan_ordinal, page_ordinal, cursor, payload_digest)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT DO NOTHING`,
      [
        storedId,
        session.id,
        remote.status,
        remote.providerObservedAt,
        page.stream,
        page.scanOrdinal,
        page.pageOrdinal,
        page.cursor,
        remoteMetadataDigest(remote),
      ],
    );
    if (!conflicted) await reconcileRemoteDocument(client, storedId!, remote);
    const files = await client.query<{ kind: string }>(
      `SELECT kind FROM aruba_files WHERE remote_document_id = $1`,
      [storedId],
    );
    const knownKinds = new Set(files.rows.map((file) => file.kind));
    const changed = !current || current.metadata_digest !== metadataDigest;
    if (changed || !knownKinds.has("ARUBA_XML")) {
      requestedFiles.push({ remoteId: remote.remoteId, kind: "ARUBA_XML" });
    }
    if (changed || !knownKinds.has("ARUBA_P7M")) {
      requestedFiles.push({ remoteId: remote.remoteId, kind: "ARUBA_P7M" });
    }
    if (changed || !knownKinds.has("ARUBA_PDF")) {
      requestedFiles.push({ remoteId: remote.remoteId, kind: "ARUBA_PDF" });
    }
    if (!isEmissionConfirmed(remote.status) || changed) {
      requestedFiles.push({ remoteId: remote.remoteId, kind: "SDI_NOTIFICATION" });
    }
  }
  const watermark = await client.query<{ value: string }>(
    `SELECT nextval('aruba_inventory_watermark_seq')::text AS value`,
  );
  await client.query(
    `INSERT INTO aruba_sync_pages
        (sync_session_id, stream, scan_ordinal, page_ordinal, cursor, terminal, full_scan,
         row_count, documents_json, payload_digest)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      session.id,
      page.stream,
      page.scanOrdinal,
      page.pageOrdinal,
      page.cursor,
      page.terminal,
      page.fullScan,
      page.documents.length,
      JSON.stringify(page.documents),
      digest,
    ],
  );
  await client.query(
    `UPDATE aruba_sync_sessions SET status = 'SCANNING', last_heartbeat_at = now(),
         lease_expires_at = least(absolute_expires_at, now() + interval '2 minutes'),
         page_count = page_count + 1, document_count = document_count + $2,
         final_cursor = $3, inventory_watermark = $4
       WHERE id = $1`,
    [session.id, page.documents.length, page.cursor, Number(watermark.rows[0]!.value)],
  );
  if (updateCursor) {
    await client.query(
      `INSERT INTO sync_cursors
       (provider, stream, cursor, overlap_from, last_page_ordinal, updated_at)
     VALUES ('ARUBA', $1, $2, now() - interval '2 days', $3, now())
     ON CONFLICT (provider, stream) DO UPDATE SET
       cursor = EXCLUDED.cursor, overlap_from = EXCLUDED.overlap_from,
       last_page_ordinal = EXCLUDED.last_page_ordinal, updated_at = now()`,
      [
        cursorStream(session.environment, session.account_reference, page.stream),
        page.cursor,
        page.pageOrdinal,
      ],
    );
  }
  return { repeated: false, documents: page.documents.length, requestedFiles };
}

export async function ingestArubaInventoryPage(token: string, rawPage: unknown) {
  const parsed = inventoryPageSchema.safeParse(rawPage);
  if (!parsed.success) throw new AppError("ARUBA_INVENTORY_INVALID", 422);
  return withTransaction(async (client) => {
    const session = await loadReadSession(client, token, true);
    if (!session) throw new AppError("ARUBA_READ_SESSION_INVALID", 401);
    await lockArubaInventory(client, session.environment, session.account_reference);
    return ingestParsedArubaPage(client, session, parsed.data);
  });
}

export async function completeArubaInventory(
  token: string,
  rawStreams: unknown,
  rawScanOrdinal: unknown,
  rawFullScan: unknown,
) {
  const streams = z
    .array(z.string().regex(/^[a-z0-9:_-]{1,100}$/))
    .min(2)
    .max(50)
    .safeParse(rawStreams);
  const scanOrdinal = z.number().int().positive().max(100_000).safeParse(rawScanOrdinal);
  const fullScan = z.boolean().safeParse(rawFullScan);
  if (
    !streams.success ||
    !scanOrdinal.success ||
    !fullScan.success ||
    new Set(streams.data).size !== streams.data.length
  ) {
    throw new AppError("ARUBA_INVENTORY_INCOMPLETE", 422);
  }
  return withTransaction(async (client) => {
    const session = await loadReadSession(client, token, true);
    if (!session) throw new AppError("ARUBA_READ_SESSION_INVALID", 401);
    const coverage = await requiredInventoryCoverage(client);
    const requiredStreams = new Set(coverage.streams);
    if (
      streams.data.length !== coverage.streams.length ||
      streams.data.some((stream) => !requiredStreams.has(stream))
    ) {
      throw new AppError("ARUBA_INVENTORY_INCOMPLETE", 409);
    }
    const pageCoverage = await client.query<{
      stream: string;
      page_count: number;
      max_ordinal: number;
      terminal_count: number;
      terminal_ordinal: number | null;
      mode_count: number;
    }>(
      `SELECT stream, count(*)::integer AS page_count, max(page_ordinal)::integer AS max_ordinal,
              count(*) FILTER (WHERE terminal)::integer AS terminal_count,
              max(page_ordinal) FILTER (WHERE terminal)::integer AS terminal_ordinal,
              count(*) FILTER (WHERE full_scan = $3)::integer AS mode_count
       FROM aruba_sync_pages
       WHERE sync_session_id = $1 AND scan_ordinal = $2
       GROUP BY stream`,
      [session.id, scanOrdinal.data, fullScan.data],
    );
    const byStream = new Map(pageCoverage.rows.map((row) => [row.stream, row]));
    if (
      streams.data.some((stream) => {
        const row = byStream.get(stream);
        return (
          !row ||
          row.page_count !== row.max_ordinal ||
          row.terminal_count !== 1 ||
          row.terminal_ordinal !== row.max_ordinal ||
          row.mode_count !== row.page_count
        );
      })
    ) {
      await client.query(
        `UPDATE aruba_sync_sessions SET status = 'INCOMPLETE', lease_expires_at = NULL,
           failed_at = now(),
           error_code = 'ARUBA_INVENTORY_INCOMPLETE', error_message_sanitized = 'Stream incompleti'
         WHERE id = $1`,
        [session.id],
      );
      throw new AppError("ARUBA_INVENTORY_INCOMPLETE", 409);
    }
    await client.query(
      `UPDATE aruba_sync_sessions SET status = 'ACTIVE', completed_at = now(),
         full_scan_completed_at = CASE WHEN $2 THEN now() ELSE full_scan_completed_at END,
         lease_expires_at = least(absolute_expires_at, now() + interval '2 minutes'),
         error_code = NULL, error_message_sanitized = NULL
       WHERE id = $1`,
      [session.id, fullScan.data],
    );
    if (fullScan.data) {
      await client.query(
        `UPDATE sync_cursors SET full_scan_completed_at = now(), updated_at = now()
         WHERE provider = 'ARUBA' AND stream = ANY($1::text[])`,
        [
          streams.data.map((stream) =>
            cursorStream(session.environment, session.account_reference, stream),
          ),
        ],
      );
    }
    await client.query(
      `INSERT INTO connections
        (provider, environment, account_reference, encrypted_credentials, status,
         last_checked_at, last_synced_at)
       VALUES ('ARUBA', $1, $2, NULL, 'CONNECTED', now(), now())
       ON CONFLICT (provider, environment) DO UPDATE SET
         account_reference = EXCLUDED.account_reference, status = 'CONNECTED',
         last_checked_at = now(), last_synced_at = now(), updated_at = now(),
         last_error_code = NULL, last_error_message_sanitized = NULL`,
      [
        session.environment === "PRODUCTION" ? "PRODUCTION" : "DEVELOPMENT",
        session.account_reference,
      ],
    );
    await writeAudit(client, {
      actorType: "SYSTEM",
      action: "ARUBA_INVENTORY_COMPLETED",
      eventClass: "OPERATIONAL",
      entityType: "ARUBA_SYNC_SESSION",
      entityId: session.id,
      metadata: { streamCount: streams.data.length, fullScan: fullScan.data },
      requestId: `aruba-read:${session.id}`,
    });
    return { completed: true };
  });
}

export async function failArubaInventory(token: string, rawCode: unknown) {
  const code = z
    .string()
    .regex(/^[A-Z0-9_]{3,100}$/)
    .safeParse(rawCode);
  if (!code.success) throw new AppError("ARUBA_INVENTORY_INVALID", 422);
  const result = await getPool().query(
    `UPDATE aruba_sync_sessions SET status = 'FAILED', lease_expires_at = NULL, failed_at = now(),
       error_code = $2, error_message_sanitized = 'Sincronizzazione Aruba interrotta'
     WHERE token_hash = $1 AND status IN ('ACTIVE', 'SCANNING')
     RETURNING id`,
    [hashToken(token), code.data],
  );
  if (!result.rows[0]) throw new AppError("ARUBA_READ_SESSION_INVALID", 401);
}

export interface ArubaInventoryHealth {
  status: "NEVER" | "HEALTHY" | "WARNING" | "BLOCKED";
  blocking: boolean;
  lastCompletedAt: string | null;
  ageMinutes: number | null;
  activeSession: boolean;
  activeDeviceSuffix: string | null;
  activeSessionExpiresAt: string | null;
  nextScheduledAt: string | null;
  lastErrorCode: string | null;
  unmatched: number;
  ambiguous: number;
  conflicts: number;
  remoteDocuments: number;
  blockingReason: "NEVER" | "STALE" | "FAILURE" | "CONFLICT" | null;
}

export async function getArubaInventoryHealth(): Promise<ArubaInventoryHealth> {
  const result = await getPool().query<{
    last_completed_at: Date | null;
    last_full_scan_completed_at: Date | null;
    active_session: boolean;
    active_device_suffix: string | null;
    active_session_expires_at: Date | null;
    next_scheduled_at: Date | null;
    last_error_code: string | null;
    unresolved_failure: boolean;
    unmatched: string;
    ambiguous: string;
    conflicts: string;
    remote_documents: string;
  }>(
    `SELECT
       (SELECT max(completed_at) FROM aruba_sync_sessions
        WHERE environment = $1 AND account_reference = $2 AND completed_at IS NOT NULL
          AND is_full_scan) AS last_completed_at,
       (SELECT max(full_scan_completed_at) FROM aruba_sync_sessions
        WHERE environment = $1 AND account_reference = $2
          AND full_scan_completed_at IS NOT NULL) AS last_full_scan_completed_at,
       EXISTS (SELECT 1 FROM aruba_sync_sessions
        WHERE environment = $1 AND account_reference = $2
          AND status IN ('ACTIVE', 'SCANNING') AND absolute_expires_at > now()
          AND lease_expires_at > now()) AS active_session,
       (SELECT right(device_id, 6) FROM aruba_sync_sessions
        WHERE environment = $1 AND account_reference = $2 AND status IN ('ACTIVE', 'SCANNING')
          AND absolute_expires_at > now() AND lease_expires_at > now()
        ORDER BY started_at DESC LIMIT 1) AS active_device_suffix,
       (SELECT absolute_expires_at FROM aruba_sync_sessions
        WHERE environment = $1 AND account_reference = $2 AND status IN ('ACTIVE', 'SCANNING')
          AND absolute_expires_at > now() AND lease_expires_at > now()
        ORDER BY started_at DESC LIMIT 1) AS active_session_expires_at,
       (SELECT coalesce(completed_at, last_heartbeat_at, started_at) + interval '15 minutes'
        FROM aruba_sync_sessions
        WHERE environment = $1 AND account_reference = $2 AND status IN ('ACTIVE', 'SCANNING')
          AND absolute_expires_at > now() AND lease_expires_at > now()
        ORDER BY started_at DESC LIMIT 1) AS next_scheduled_at,
       (SELECT error_code FROM aruba_sync_sessions
        WHERE environment = $1 AND account_reference = $2 AND error_code IS NOT NULL
        ORDER BY started_at DESC LIMIT 1) AS last_error_code,
       EXISTS (SELECT 1 FROM aruba_sync_sessions AS failed
        WHERE failed.environment = $1 AND failed.account_reference = $2
          AND failed.status IN ('FAILED', 'INCOMPLETE')
          AND coalesce(failed.failed_at, failed.started_at) > coalesce((SELECT max(full_scan_completed_at) FROM aruba_sync_sessions
            WHERE environment = $1 AND account_reference = $2
              AND full_scan_completed_at IS NOT NULL), '-infinity'))
         AS unresolved_failure,
       (SELECT count(*) FROM aruba_document_matches matches
        JOIN aruba_remote_documents remote ON remote.id = matches.remote_document_id
        WHERE remote.environment = $1 AND remote.account_reference = $2
          AND matches.status = 'UNMATCHED') AS unmatched,
       (SELECT count(*) FROM aruba_document_matches matches
        JOIN aruba_remote_documents remote ON remote.id = matches.remote_document_id
        WHERE remote.environment = $1 AND remote.account_reference = $2
          AND remote.remote_status <> 'REJECTED' AND matches.status = 'AMBIGUOUS') AS ambiguous,
       (SELECT count(*) FROM aruba_document_matches matches
        JOIN aruba_remote_documents remote ON remote.id = matches.remote_document_id
        WHERE remote.environment = $1 AND remote.account_reference = $2
          AND remote.remote_status <> 'REJECTED'
          AND matches.status IN ('PROFILE_CONFLICT', 'ERROR', 'UNKNOWN_REMOTE_STATE')) AS conflicts,
       (SELECT count(*) FROM aruba_remote_documents
        WHERE environment = $1 AND account_reference = $2) AS remote_documents`,
    [environment(), accountReference()],
  );
  const row = result.rows[0]!;
  const completed = row.last_full_scan_completed_at ? row.last_completed_at : null;
  const ageMinutes = completed ? Math.max(0, (Date.now() - completed.getTime()) / 60_000) : null;
  const unresolved = Number(row.ambiguous) + Number(row.conflicts);
  const blockingReason = !completed
    ? "NEVER"
    : row.unresolved_failure
      ? "FAILURE"
      : unresolved > 0
        ? "CONFLICT"
        : (ageMinutes ?? Infinity) > 24 * 60
          ? "STALE"
          : null;
  const status = !completed
    ? "NEVER"
    : row.unresolved_failure || unresolved > 0 || (ageMinutes ?? Infinity) > 24 * 60
      ? "BLOCKED"
      : (ageMinutes ?? 0) > 60
        ? "WARNING"
        : "HEALTHY";
  return {
    status,
    blocking: status === "NEVER" || status === "BLOCKED",
    lastCompletedAt: completed?.toISOString() ?? null,
    ageMinutes,
    activeSession: row.active_session,
    activeDeviceSuffix: row.active_device_suffix,
    activeSessionExpiresAt: row.active_session_expires_at?.toISOString() ?? null,
    nextScheduledAt: row.next_scheduled_at?.toISOString() ?? null,
    lastErrorCode: row.last_error_code,
    unmatched: Number(row.unmatched),
    ambiguous: Number(row.ambiguous),
    conflicts: Number(row.conflicts),
    remoteDocuments: Number(row.remote_documents),
    blockingReason,
  };
}

export async function listRemoteDocuments(options: { attentionOnly?: boolean } = {}) {
  const result = await getPool().query<{
    id: string;
    remote_id: string;
    document_type: "TD01" | "TD04";
    fiscal_number: string | null;
    series: string | null;
    document_date: string;
    total_amount: number;
    remote_status: ArubaRemoteStatus;
    last_observed_at: string;
    match_status: string;
    order_id: string | null;
    document_id: string | null;
    candidates: Array<{ id: string; label: string }>;
    has_xml: boolean;
  }>(
    `SELECT remote.id, remote.remote_id, remote.document_type, remote.fiscal_number,
            remote.series, remote.document_date::text, remote.total_amount,
            remote.remote_status, remote.last_observed_at,
            coalesce(matches.status, 'UNMATCHED') AS match_status,
            matches.order_id, matches.document_id,
            EXISTS (SELECT 1 FROM aruba_files
              WHERE aruba_files.remote_document_id = remote.id
                AND aruba_files.kind = 'ARUBA_XML') AS has_xml,
            coalesce((
              SELECT jsonb_agg(jsonb_build_object(
                'id', orders.id::text,
                'label', CASE orders.provider WHEN 'SHOPIFY' THEN 'Shopify ' ELSE 'eBay ' END
                  || orders.display_number
              ) ORDER BY orders.id)
              FROM orders
              WHERE orders.id::text IN (
                SELECT candidate ->> 'candidateId'
                FROM jsonb_array_elements(coalesce(matches.candidates_json, '[]')) AS candidate
                WHERE coalesce((candidate ->> 'compatible')::boolean, false)
              )
            ), '[]') AS candidates
     FROM aruba_remote_documents AS remote
     LEFT JOIN aruba_document_matches AS matches ON matches.remote_document_id = remote.id
     WHERE remote.environment = $1 AND remote.account_reference = $2
       AND (NOT $3::boolean OR coalesce(matches.status, 'UNMATCHED') <> 'MATCHED')
     ORDER BY remote.last_observed_at DESC, remote.id DESC
     LIMIT 200`,
    [environment(), accountReference(), Boolean(options.attentionOnly)],
  );
  return result.rows;
}

export async function listOrderRemoteDocuments(orderId: string) {
  if (!isDatabaseId(orderId)) return [];
  const result = await getPool().query(
    `SELECT remote.remote_id, remote.document_type, remote.fiscal_number, remote.series,
            remote.remote_status, remote.last_observed_at, matches.status AS match_status
     FROM aruba_document_matches AS matches
     JOIN aruba_remote_documents AS remote ON remote.id = matches.remote_document_id
     WHERE matches.order_id = $1 ORDER BY remote.last_observed_at DESC`,
    [orderId],
  );
  return result.rows;
}

export async function requestArubaPreflight(
  input: {
    billingCaseId?: string;
    documentId?: string;
    draftVersion: number;
    projectionSha256: string;
  },
  actor: ArubaReadActor,
  sharedManifestSha256?: string,
) {
  const health = await getArubaInventoryHealth();
  if (health.blocking && health.blockingReason !== "STALE") {
    throw new AppError("ARUBA_INVENTORY_BLOCKED", 409);
  }
  const request = await getPool().query<{
    id: string;
    order_ids: string[];
    searches: Array<{
      provider: "SHOPIFY" | "EBAY";
      displayNumber: string;
      amount: number;
      documentType: "TD01" | "TD04";
      orderId: string;
      orderDate: string;
      recipientName: string | null;
      recipientTaxIds: string[];
      recipientAddress: string | null;
      refundIds: string[];
    }>;
  }>(
    `SELECT documents.id, coalesce(array_agg(document_orders.order_id::text)
      FILTER (WHERE document_orders.order_id IS NOT NULL), '{}') AS order_ids,
      coalesce(jsonb_agg(DISTINCT jsonb_build_object(
        'provider', orders.provider, 'displayNumber', orders.display_number,
        'amount', document_orders.amount, 'documentType', documents.document_type,
        'orderId', orders.id::text, 'orderDate', orders.local_order_date::text,
        'recipientName', customers.display_name,
        'recipientTaxIds', coalesce((SELECT jsonb_agg(tax.normalized_value)
          FROM order_tax_identifiers tax WHERE tax.order_id = orders.id), '[]'),
        'recipientAddress', concat_ws(' ',
          orders.normalized_snapshot_json #>> '{customerSnapshot,billingAddress,line1}',
          orders.normalized_snapshot_json #>> '{customerSnapshot,billingAddress,postalCode}',
          orders.normalized_snapshot_json #>> '{customerSnapshot,billingAddress,city}',
          orders.normalized_snapshot_json #>> '{customerSnapshot,billingAddress,countryCode}'),
        'refundIds', coalesce((SELECT jsonb_agg(refunds.id::text ORDER BY refunds.id)
          FROM refunds WHERE refunds.order_id = orders.id AND refunds.status = 'COMPLETED'
            AND refunds.credit_document_id IS NULL), '[]')
      )) FILTER (WHERE orders.id IS NOT NULL), '[]') AS searches
     FROM documents
     LEFT JOIN document_orders ON document_orders.document_id = documents.id
     LEFT JOIN orders ON orders.id = document_orders.order_id
     LEFT JOIN customers ON customers.id = orders.customer_id
     WHERE (($1::bigint IS NOT NULL AND documents.billing_case_id = $1)
        OR ($2::bigint IS NOT NULL AND documents.id = $2))
       AND documents.draft_version = $3 AND documents.projection_sha256 = $4
     GROUP BY documents.id`,
    [
      input.billingCaseId ?? null,
      input.documentId ?? null,
      input.draftVersion,
      input.projectionSha256,
    ],
  );
  const document = request.rows[0];
  if (!document) throw new AppError("DOCUMENT_PROJECTION_STALE", 409);
  const manifest = {
    billingCaseId: input.billingCaseId ?? null,
    documentId: document.id,
    draftVersion: input.draftVersion,
    projectionSha256: input.projectionSha256,
    orderIds: document.order_ids,
    refundIds: document.searches.flatMap((search) => search.refundIds),
    searches: document.searches,
  };
  const [watermark, existing] = await Promise.all([
    currentInventoryWatermark(getPool()),
    getPool().query<{ id: string; status: string }>(
      `SELECT id, status FROM aruba_preflight_receipts
       WHERE billing_case_id IS NOT DISTINCT FROM $1 AND document_id = $2
         AND draft_version = $3 AND projection_sha256 = $4
         AND status IN ('REQUESTED', 'RUNNING', 'PASSED')
         AND (expires_at IS NULL OR expires_at > now())
       ORDER BY requested_at DESC LIMIT 1`,
      [input.billingCaseId ?? null, document.id, input.draftVersion, input.projectionSha256],
    ),
  ]);
  if (existing.rows[0]) return existing.rows[0];
  const id = randomUUID();
  const syntheticPass = environment() === "MOCK";
  await getPool().query(
    `INSERT INTO aruba_preflight_receipts
      (id, environment, account_reference, billing_case_id, document_id, draft_version,
       projection_sha256, manifest_sha256, inventory_watermark, requested_by, request_json,
       status, completed_at, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
       CASE WHEN $12 THEN 'PASSED' ELSE 'REQUESTED' END,
       CASE WHEN $12 THEN now() ELSE NULL END,
       CASE WHEN $12 THEN now() + interval '5 minutes' ELSE NULL END)`,
    [
      id,
      environment(),
      accountReference(),
      input.billingCaseId ?? null,
      document.id,
      input.draftVersion,
      input.projectionSha256,
      sharedManifestSha256 ?? payloadDigest(manifest),
      watermark,
      actor.id,
      JSON.stringify({ ...manifest, sharedManifestSha256: sharedManifestSha256 ?? null }),
      syntheticPass,
    ],
  );
  return { id, status: syntheticPass ? "PASSED" : "REQUESTED" };
}

export async function ensureArubaPreflight(
  input: {
    billingCaseId?: string;
    documentId?: string;
    draftVersion: number;
    projectionSha256: string;
  },
  actor: ArubaReadActor,
) {
  const receipt = await requestArubaPreflight(input, actor);
  if (receipt.status !== "PASSED") throw new AppError("ARUBA_PREFLIGHT_REQUIRED", 409);
  return receipt.id;
}

export async function getPendingArubaPreflightForCase(billingCaseId: string) {
  if (!isDatabaseId(billingCaseId)) return null;
  const result = await getPool().query<{
    id: string;
    status: string;
    request_json: unknown;
    requested_at: string;
  }>(
    `SELECT id, status, request_json, requested_at
     FROM aruba_preflight_receipts
     WHERE billing_case_id = $1 AND status IN ('REQUESTED', 'RUNNING')
     ORDER BY requested_at DESC LIMIT 1`,
    [billingCaseId],
  );
  return result.rows[0] ?? null;
}

export async function consumeArubaPreflight(
  client: pg.PoolClient,
  receiptId: string,
  input: {
    billingCaseId?: string;
    documentId?: string;
    draftVersion: number;
    projectionSha256: string;
  },
) {
  const receipt = await client.query<{
    id: string;
    inventory_watermark: string;
    environment: string;
    account_reference: string;
  }>(
    `SELECT id, inventory_watermark::text, environment, account_reference
     FROM aruba_preflight_receipts
     WHERE id = $1 AND status = 'PASSED' AND expires_at > now()
       AND billing_case_id IS NOT DISTINCT FROM $2
       AND document_id IS NOT DISTINCT FROM $3
       AND draft_version = $4 AND projection_sha256 = $5
     FOR UPDATE`,
    [
      receiptId,
      input.billingCaseId ?? null,
      input.documentId ?? null,
      input.draftVersion,
      input.projectionSha256,
    ],
  );
  const current = receipt.rows[0];
  if (!current) throw new AppError("ARUBA_PREFLIGHT_REQUIRED", 409);
  await lockArubaInventory(
    client,
    current.environment as "MOCK" | "PRODUCTION",
    current.account_reference,
  );
  const watermark = await currentInventoryWatermark(client);
  if (watermark !== Number(current.inventory_watermark)) {
    throw new AppError("ARUBA_PREFLIGHT_REQUIRED", 409);
  }
  const blocker = await client.query(
    `SELECT 1 FROM aruba_document_matches matches
     JOIN aruba_remote_documents remote ON remote.id = matches.remote_document_id
     WHERE remote.environment = $1 AND remote.account_reference = $2
       AND remote.remote_status <> 'REJECTED'
       AND matches.status IN ('AMBIGUOUS', 'PROFILE_CONFLICT', 'ERROR', 'UNKNOWN_REMOTE_STATE')
     LIMIT 1`,
    [current.environment, current.account_reference],
  );
  if (blocker.rows[0]) throw new AppError("ARUBA_INVENTORY_BLOCKED", 409);
  await client.query(
    `UPDATE aruba_preflight_receipts SET status = 'CONSUMED', consumed_at = now() WHERE id = $1`,
    [current.id],
  );
}

export async function listArubaPreflightWork(token: string) {
  const session = await loadReadSession(getPool(), token);
  if (!session) throw new AppError("ARUBA_READ_SESSION_INVALID", 401);
  const result = await withTransaction(async (client) => {
    await client.query(
      `UPDATE aruba_preflight_receipts SET status = 'REQUESTED', claimed_at = NULL
       WHERE environment = $1 AND account_reference = $2 AND status = 'RUNNING'
         AND (claimed_at IS NULL OR claimed_at <= now() - interval '2 minutes')`,
      [session.environment, session.account_reference],
    );
    const work = await client.query(
      `UPDATE aruba_preflight_receipts SET status = 'RUNNING', claimed_at = now()
     WHERE id IN (
       SELECT id FROM aruba_preflight_receipts
       WHERE environment = $1 AND account_reference = $2 AND status = 'REQUESTED'
       ORDER BY requested_at LIMIT 100 FOR UPDATE SKIP LOCKED
     ) RETURNING id, request_json, requested_at`,
      [session.environment, session.account_reference],
    );
    const requested = await client.query<{ value_json: { requestedAt?: string } }>(
      `DELETE FROM settings WHERE key = 'aruba_sync_requested' RETURNING value_json`,
    );
    return { work: work.rows, syncRequestedAt: requested.rows[0]?.value_json.requestedAt ?? null };
  });
  return result;
}

export async function completeArubaPreflight(
  token: string,
  raw: { receiptId?: unknown; candidateRemoteIds?: unknown; searchesCompleted?: unknown },
) {
  const receiptId = z.uuid().safeParse(raw.receiptId);
  const candidateIds = z
    .array(z.string().trim().min(1).max(200))
    .max(100)
    .safeParse(raw.candidateRemoteIds);
  const searchesCompleted = z.boolean().safeParse(raw.searchesCompleted);
  if (!receiptId.success || !candidateIds.success || !searchesCompleted.success) {
    throw new AppError("ARUBA_INVENTORY_INVALID", 422);
  }
  return withTransaction(async (client) => {
    const session = await loadReadSession(client, token, true);
    if (!session) throw new AppError("ARUBA_READ_SESSION_INVALID", 401);
    const receipt = await client.query<{
      request_json: { orderIds?: string[]; refundIds?: string[] };
      requested_at: Date;
      draft_version: number;
      projection_sha256: string;
      manifest_sha256: string;
    }>(
      `SELECT request_json, requested_at, draft_version, projection_sha256, manifest_sha256
       FROM aruba_preflight_receipts
       WHERE id = $1 AND environment = $2 AND account_reference = $3
         AND status = 'RUNNING' FOR UPDATE`,
      [receiptId.data, session.environment, session.account_reference],
    );
    if (!receipt.rows[0]) throw new AppError("ARUBA_PREFLIGHT_REQUIRED", 409);
    const requestJson = receipt.rows[0].request_json;
    const declaredCandidates = candidateIds.data.length
      ? await client.query(
          `SELECT remote_id FROM aruba_remote_documents
           WHERE environment = $1 AND account_reference = $2
             AND remote_status <> 'REJECTED' AND remote_id = ANY($3::text[])`,
          [session.environment, session.account_reference, candidateIds.data],
        )
      : { rowCount: 0 };
    const required = await requiredInventoryCoverage(client);
    const covered = await client.query<{ stream: string }>(
      `SELECT DISTINCT stream FROM aruba_sync_pages
       WHERE sync_session_id = $1 AND committed_at >= $2`,
      [session.id, receipt.rows[0].requested_at],
    );
    const authoritativeCandidates = await client.query(
      `SELECT 1 FROM aruba_document_matches matches
         JOIN aruba_remote_documents remote ON remote.id = matches.remote_document_id
         WHERE remote.environment = $1 AND remote.account_reference = $2
           AND remote.remote_status <> 'REJECTED' AND (
           matches.order_id::text = ANY($3::text[])
           OR EXISTS (
             SELECT 1 FROM jsonb_array_elements(matches.candidates_json) candidate
             WHERE candidate ->> 'candidateId' = ANY($3::text[])
               AND coalesce((candidate ->> 'compatible')::boolean, false)
           )
         ) LIMIT 1`,
      [session.environment, session.account_reference, requestJson.orderIds ?? []],
    );
    const coveredStreams = new Set(covered.rows.map((row) => row.stream));
    const passed =
      searchesCompleted.data &&
      required.streams.every((stream) => coveredStreams.has(stream)) &&
      declaredCandidates.rowCount === 0 &&
      authoritativeCandidates.rowCount === 0;
    const watermark = await currentInventoryWatermark(client);
    await client.query(
      `UPDATE aruba_preflight_receipts SET status = $2, claimed_at = NULL, completed_at = now(),
         expires_at = CASE WHEN $2 = 'PASSED' THEN now() + interval '5 minutes' ELSE NULL END,
         blocker_code = CASE WHEN $2 = 'BLOCKED' THEN 'ARUBA_REMOTE_CANDIDATE' ELSE NULL END,
         inventory_watermark = $3
       WHERE id = $1`,
      [receiptId.data, passed ? "PASSED" : "BLOCKED", watermark],
    );
    return { passed };
  });
}

export async function requestImmediateArubaSync(actor: ArubaReadActor) {
  await getPool().query(
    `INSERT INTO settings (key, value_json) VALUES ('aruba_sync_requested', $1)
     ON CONFLICT (key) DO UPDATE SET value_json = EXCLUDED.value_json,
       version = settings.version + 1, updated_at = now()`,
    [JSON.stringify({ requestedAt: new Date().toISOString(), requestedBy: actor.id })],
  );
}

export async function revokeArubaReadSessions(actor: ArubaReadActor) {
  if (!actor.canApprove) throw new AppError("ARUBA_READ_SESSION_FORBIDDEN", 403);
  const result = await getPool().query(
    `UPDATE aruba_sync_sessions SET status = 'REVOKED', lease_expires_at = NULL
     WHERE environment = $1 AND account_reference = $2 AND status IN ('ACTIVE', 'SCANNING')`,
    [environment(), accountReference()],
  );
  return result.rowCount ?? 0;
}

async function manualCoverage(client: pg.Pool | pg.PoolClient) {
  return requiredInventoryCoverage(client);
}

function parsedManualPages(raw: unknown, allowAcrossStreams = false) {
  const parsed = z.array(inventoryPageSchema).min(1).max(500).safeParse(raw);
  if (!parsed.success || parsed.data.some((page) => !page.fullScan)) {
    throw new AppError("ARUBA_INVENTORY_INVALID", 422);
  }
  const byStream = new Map<string, typeof parsed.data>();
  for (const page of parsed.data) {
    const pages = byStream.get(page.stream) ?? [];
    pages.push(page);
    byStream.set(page.stream, pages);
  }
  for (const pages of byStream.values()) {
    pages.sort((left, right) => left.pageOrdinal - right.pageOrdinal);
    if (
      pages.some((page, index) => page.pageOrdinal !== index + 1) ||
      !pages.at(-1)?.terminal ||
      pages.slice(0, -1).some((page) => page.terminal)
    ) {
      throw new AppError("ARUBA_INVENTORY_INCOMPLETE", 409);
    }
  }
  const remoteKeys = parsed.data.flatMap((page) =>
    page.documents.map((item) =>
      allowAcrossStreams ? `${page.stream}:${item.remoteId}` : item.remoteId,
    ),
  );
  if (new Set(remoteKeys).size !== remoteKeys.length) {
    throw new AppError("ARUBA_INVENTORY_CONFLICT", 409);
  }
  return {
    pages: parsed.data,
    byStream,
    remoteIds: [
      ...new Set(parsed.data.flatMap((page) => page.documents.map((item) => item.remoteId))),
    ],
  };
}

export async function createArubaManualReadback(actor: ArubaReadActor) {
  if (!actor.canApprove) throw new AppError("ARUBA_READ_SESSION_FORBIDDEN", 403);
  const coverage = await manualCoverage(getPool());
  const id = randomUUID();
  await getPool().query(
    `INSERT INTO aruba_manual_readbacks
      (id, mode, environment, account_reference, coverage_json, created_by)
     VALUES ($1, 'FULL', $2, $3, $4, $5)`,
    [id, environment(), accountReference(), JSON.stringify(coverage), actor.id],
  );
  return { id, coverage };
}

export async function addArubaManualReadbackPages(
  readbackId: string,
  rawPages: unknown,
  actor: ArubaReadActor,
) {
  if (!actor.canApprove || !z.uuid().safeParse(readbackId).success) {
    throw new AppError("ARUBA_READ_SESSION_FORBIDDEN", 403);
  }
  const parsed = parsedManualPages(rawPages);
  return withTransaction(async (client) => {
    const readback = await client.query<{ status: string }>(
      `SELECT status FROM aruba_manual_readbacks
       WHERE id = $1 AND environment = $2 AND account_reference = $3 FOR UPDATE`,
      [readbackId, environment(), accountReference()],
    );
    if (readback.rows[0]?.status !== "DRAFT") {
      throw new AppError("ARUBA_INVENTORY_CONFLICT", 409);
    }
    for (const page of parsed.pages) {
      const digest = payloadDigest(page);
      await client.query(
        `INSERT INTO aruba_manual_readback_pages
          (manual_readback_id, stream, page_ordinal, cursor, terminal, row_count,
           rows_json, payload_digest)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (manual_readback_id, stream, page_ordinal) DO UPDATE SET
           cursor = EXCLUDED.cursor, terminal = EXCLUDED.terminal,
           row_count = EXCLUDED.row_count, rows_json = EXCLUDED.rows_json,
           payload_digest = EXCLUDED.payload_digest`,
        [
          readbackId,
          page.stream,
          page.pageOrdinal,
          page.cursor,
          page.terminal,
          page.documents.length,
          JSON.stringify(page.documents),
          digest,
        ],
      );
    }
    await client.query(
      `UPDATE aruba_manual_readbacks SET row_count = (
         SELECT coalesce(sum(row_count), 0)::integer FROM aruba_manual_readback_pages
         WHERE manual_readback_id = $1
       ), content_sha256 = $2, status = 'VALID' WHERE id = $1`,
      [readbackId, payloadDigest(parsed.pages)],
    );
    return { pages: parsed.pages.length, documents: parsed.remoteIds.length };
  });
}

export async function finalizeArubaManualReadback(readbackId: string, actor: ArubaReadActor) {
  if (!actor.canApprove || !z.uuid().safeParse(readbackId).success) {
    throw new AppError("ARUBA_READ_SESSION_FORBIDDEN", 403);
  }
  return withTransaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `aruba-read:${environment()}:${accountReference()}`,
    ]);
    const readback = await client.query<{
      status: string;
      coverage_json: { streams?: string[] };
      finalized_at: Date | null;
    }>(
      `SELECT status, coverage_json, finalized_at FROM aruba_manual_readbacks
       WHERE id = $1 AND mode = 'FULL' AND environment = $2 AND account_reference = $3
       FOR UPDATE`,
      [readbackId, environment(), accountReference()],
    );
    const current = readback.rows[0];
    if (current?.status === "FINALIZED") return { completed: true, repeated: true };
    if (current?.status !== "VALID") throw new AppError("ARUBA_INVENTORY_INCOMPLETE", 409);
    const storedPages = await client.query<{
      stream: string;
      page_ordinal: number;
      cursor: string | null;
      terminal: boolean;
      rows_json: RemoteInventoryDocument[];
    }>(
      `SELECT stream, page_ordinal, cursor, terminal, rows_json
       FROM aruba_manual_readback_pages WHERE manual_readback_id = $1
       ORDER BY stream, page_ordinal FOR UPDATE`,
      [readbackId],
    );
    const pages = storedPages.rows.map((page) =>
      inventoryPageSchema.parse({
        stream: page.stream,
        scanOrdinal: 1,
        pageOrdinal: page.page_ordinal,
        cursor: page.cursor,
        terminal: page.terminal,
        fullScan: true,
        documents: page.rows_json,
      }),
    );
    const parsed = parsedManualPages(pages);
    const required = current.coverage_json.streams ?? [];
    if (required.some((stream) => !parsed.byStream.has(stream))) {
      throw new AppError("ARUBA_INVENTORY_INCOMPLETE", 409);
    }
    const activeHelper = await client.query(
      `SELECT 1 FROM aruba_sync_sessions
       WHERE environment = $1 AND account_reference = $2
         AND status IN ('ACTIVE', 'SCANNING') AND absolute_expires_at > now()
         AND lease_expires_at > now()
       LIMIT 1`,
      [environment(), accountReference()],
    );
    if (activeHelper.rows[0]) {
      throw new AppError("ARUBA_READ_SESSION_ACTIVE", 409);
    }
    const sessionId = randomUUID();
    await client.query(
      `INSERT INTO aruba_sync_sessions
        (id, environment, account_reference, device_id, token_hash, status,
         absolute_expires_at, lease_expires_at, requested_by, source, is_full_scan)
       VALUES ($1, $2, $3, $4, $5, 'SCANNING', now() + interval '5 minutes',
         now() + interval '2 minutes', $6, 'MANUAL', true)`,
      [
        sessionId,
        environment(),
        accountReference(),
        `manual-${readbackId.replaceAll("-", "")}`,
        hashToken(randomBytes(32).toString("base64url")),
        actor.id,
      ],
    );
    const session: ReadSessionRow = {
      id: sessionId,
      environment: environment(),
      account_reference: accountReference(),
      device_id: `manual-${readbackId.replaceAll("-", "")}`,
      token_hash: "",
      status: "SCANNING",
      absolute_expires_at: new Date(Date.now() + 5 * 60_000),
      inventory_watermark: "0",
    };
    for (const page of pages) {
      // react-doctor-disable-next-line react-doctor/async-await-in-loop -- Le pagine condividono la stessa transazione e ogni match deve osservare la pagina precedente.
      await ingestParsedArubaPage(client, session, page);
    }
    const blockers = await client.query<{ count: string }>(
      `SELECT count(*) FROM aruba_document_matches matches
       JOIN aruba_remote_documents remote ON remote.id = matches.remote_document_id
       WHERE remote.environment = $1 AND remote.account_reference = $2
         AND matches.status IN ('AMBIGUOUS', 'PROFILE_CONFLICT', 'ERROR', 'UNKNOWN_REMOTE_STATE')`,
      [environment(), accountReference()],
    );
    if (Number(blockers.rows[0]!.count) > 0) {
      throw new AppError("ARUBA_INVENTORY_BLOCKED", 409);
    }
    await client.query(
      `UPDATE aruba_sync_sessions SET status = 'COMPLETED', completed_at = now(),
         full_scan_completed_at = now(),
         lease_expires_at = NULL WHERE id = $1`,
      [sessionId],
    );
    await client.query(
      `INSERT INTO connections
        (provider, environment, account_reference, encrypted_credentials, status,
         last_checked_at, last_synced_at)
       VALUES ('ARUBA', $1, $2, NULL, 'CONNECTED', now(), now())
       ON CONFLICT (provider, environment) DO UPDATE SET
         account_reference = EXCLUDED.account_reference, status = 'CONNECTED',
         last_checked_at = now(), last_synced_at = now(), updated_at = now(),
         last_error_code = NULL, last_error_message_sanitized = NULL`,
      [environment() === "PRODUCTION" ? "PRODUCTION" : "DEVELOPMENT", accountReference()],
    );
    await client.query(
      `UPDATE aruba_manual_readbacks SET status = 'FINALIZED', finalized_by = $2,
         finalized_at = now() WHERE id = $1`,
      [readbackId, actor.id],
    );
    await writeAudit(client, {
      actorType: "ADMIN",
      actorId: String(actor.id),
      action: "ARUBA_INVENTORY_COMPLETED",
      eventClass: "OPERATIONAL",
      entityType: "ARUBA_SYNC_SESSION",
      entityId: sessionId,
      metadata: { streamCount: required.length },
      requestId: actor.requestId,
    });
    return { completed: true, repeated: false };
  });
}

export async function completeManualArubaPreflight(
  receiptId: string,
  rawPages: unknown,
  rawReason: unknown,
  actor: ArubaReadActor,
) {
  if (!actor.canApprove || !z.uuid().safeParse(receiptId).success) {
    throw new AppError("ARUBA_READ_SESSION_FORBIDDEN", 403);
  }
  const parsed = parsedManualPages(rawPages, true);
  const reason = z.string().trim().min(20).max(500).safeParse(rawReason);
  if (!reason.success) throw new AppError("ARUBA_INVENTORY_INVALID", 422);
  return withTransaction(async (client) => {
    const receipt = await client.query<{
      request_json: { searches?: unknown[] };
      draft_version: number;
      projection_sha256: string;
    }>(
      `SELECT request_json, draft_version, projection_sha256 FROM aruba_preflight_receipts
       WHERE id = $1 AND environment = $2 AND account_reference = $3
         AND status IN ('REQUESTED', 'RUNNING') FOR UPDATE`,
      [receiptId, environment(), accountReference()],
    );
    if (!receipt.rows[0]) throw new AppError("ARUBA_PREFLIGHT_REQUIRED", 409);
    const searches = receipt.rows[0].request_json.searches ?? [];
    const requiredStreams = searches.map((_, index) => `specific:${index + 1}`);
    if (
      requiredStreams.length === 0 ||
      parsed.byStream.size !== requiredStreams.length ||
      requiredStreams.some((stream) => !parsed.byStream.has(stream))
    ) {
      throw new AppError("ARUBA_INVENTORY_INCOMPLETE", 409);
    }
    const health = await getArubaInventoryHealth();
    if (health.blockingReason && health.blockingReason !== "STALE") {
      throw new AppError("ARUBA_INVENTORY_BLOCKED", 409);
    }
    const readbackId = randomUUID();
    if (parsed.remoteIds.length) {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        `aruba-read:${environment()}:${accountReference()}`,
      ]);
      const activeHelper = await client.query(
        `SELECT 1 FROM aruba_sync_sessions
         WHERE environment = $1 AND account_reference = $2
           AND status IN ('ACTIVE', 'SCANNING') AND absolute_expires_at > now()
           AND lease_expires_at > now() LIMIT 1`,
        [environment(), accountReference()],
      );
      if (activeHelper.rows[0]) throw new AppError("ARUBA_READ_SESSION_ACTIVE", 409);
      const evidenceSessionId = randomUUID();
      await client.query(
        `INSERT INTO aruba_sync_sessions
          (id, environment, account_reference, device_id, token_hash, status,
           absolute_expires_at, lease_expires_at, requested_by, source, is_full_scan)
         VALUES ($1, $2, $3, $4, $5, 'SCANNING', now() + interval '5 minutes',
           now() + interval '2 minutes', $6, 'MANUAL', false)`,
        [
          evidenceSessionId,
          environment(),
          accountReference(),
          `specific-${readbackId.replaceAll("-", "")}`,
          hashToken(randomBytes(32).toString("base64url")),
          actor.id,
        ],
      );
      const evidenceSession: ReadSessionRow = {
        id: evidenceSessionId,
        environment: environment(),
        account_reference: accountReference(),
        device_id: `specific-${readbackId.replaceAll("-", "")}`,
        token_hash: "",
        status: "SCANNING",
        absolute_expires_at: new Date(Date.now() + 5 * 60_000),
        inventory_watermark: "0",
      };
      for (const page of parsed.pages) {
        // react-doctor-disable-next-line react-doctor/async-await-in-loop -- Le pagine alimentano una proiezione ordinata nella stessa transazione.
        await ingestParsedArubaPage(client, evidenceSession, page, false);
      }
      await client.query(
        `UPDATE aruba_sync_sessions SET status = 'COMPLETED', completed_at = now(),
           lease_expires_at = NULL WHERE id = $1`,
        [evidenceSessionId],
      );
    }
    const passed = parsed.pages.every((page) =>
      page.documents.every((document) => document.status === "REJECTED"),
    );
    await client.query(
      `INSERT INTO aruba_manual_readbacks
        (id, mode, environment, account_reference, status, coverage_json, row_count,
         content_sha256, created_by, finalized_by, finalized_at)
       VALUES ($1, 'SPECIFIC', $2, $3, 'FINALIZED', $4, $5, $6, $7, $7, now())`,
      [
        readbackId,
        environment(),
        accountReference(),
        JSON.stringify(receipt.rows[0].request_json),
        parsed.remoteIds.length,
        payloadDigest(parsed.pages),
        actor.id,
      ],
    );
    for (const page of parsed.pages) {
      await client.query(
        `INSERT INTO aruba_manual_readback_pages
          (manual_readback_id, stream, page_ordinal, cursor, terminal, row_count,
           rows_json, payload_digest)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          readbackId,
          page.stream,
          page.pageOrdinal,
          page.cursor,
          page.terminal,
          page.documents.length,
          JSON.stringify(page.documents),
          payloadDigest(page),
        ],
      );
    }
    await client.query(
      `UPDATE aruba_preflight_receipts SET source = 'OWNER_OVERRIDE', status = $2,
         completed_at = now(), expires_at = CASE WHEN $2 = 'PASSED'
           THEN now() + interval '5 minutes' ELSE NULL END,
         blocker_code = CASE WHEN $2 = 'BLOCKED' THEN 'ARUBA_REMOTE_CANDIDATE' ELSE NULL END,
         inventory_watermark = $3, override_reason = $4,
         override_freshness_age_minutes = $5
       WHERE id = $1`,
      [
        receiptId,
        passed ? "PASSED" : "BLOCKED",
        await currentInventoryWatermark(client),
        reason.data,
        Math.floor(health.ageMinutes ?? 0),
      ],
    );
    await writeAudit(client, {
      actorType: "ADMIN",
      actorId: String(actor.id),
      action: "ARUBA_PREFLIGHT_OVERRIDDEN",
      eventClass: "CRITICAL",
      entityType: "ARUBA_PREFLIGHT_RECEIPT",
      entityId: receiptId,
      metadata: {
        readbackId,
        freshnessAgeMinutes: Math.floor(health.ageMinutes ?? 0),
        draftVersion: receipt.rows[0].draft_version,
        projectionSha256: receipt.rows[0].projection_sha256,
      },
      reason: reason.data,
      requestId: actor.requestId,
    });
    return { passed, readbackId };
  });
}

export async function resolveArubaDocumentMatch(
  remoteDocumentId: string,
  orderId: string,
  rawReason: unknown,
  actor: ArubaReadActor,
) {
  const reason = z.string().trim().min(10).max(500).safeParse(rawReason);
  if (!actor.canApprove) throw new AppError("ARUBA_READ_SESSION_FORBIDDEN", 403);
  if (!isDatabaseId(remoteDocumentId) || !isDatabaseId(orderId) || !reason.success) {
    throw new AppError("ARUBA_INVENTORY_INVALID", 422);
  }
  return withTransaction(async (client) => {
    const match = await client.query<{
      status: string;
      method: string | null;
      order_id: string | null;
      candidates_json: Array<{
        candidateId?: string;
        compatible?: boolean;
        refundIds?: string[];
      }>;
      remote_status: ArubaRemoteStatus;
      document_type: "TD01" | "TD04";
    }>(
      `SELECT matches.status, matches.method, matches.order_id, matches.candidates_json,
              remote.remote_status, remote.document_type
       FROM aruba_document_matches AS matches
       JOIN aruba_remote_documents AS remote ON remote.id = matches.remote_document_id
       WHERE matches.remote_document_id = $1
         AND remote.environment = $2 AND remote.account_reference = $3
       FOR UPDATE OF matches, remote`,
      [remoteDocumentId, environment(), accountReference()],
    );
    const current = match.rows[0];
    if (
      !current ||
      !current.candidates_json.some(
        (candidate) => candidate.candidateId === orderId && candidate.compatible,
      )
    ) {
      throw new AppError("ARUBA_PROFILE_CONFLICT", 409);
    }
    const invoice =
      current.document_type === "TD04"
        ? await client.query<{ document_id: string }>(
            `SELECT document_orders.document_id
             FROM document_orders JOIN documents ON documents.id = document_orders.document_id
             WHERE document_orders.order_id = $1 AND document_orders.document_kind = 'INVOICE'
               AND documents.status = 'APPROVED' ORDER BY documents.id DESC LIMIT 1`,
            [orderId],
          )
        : null;
    const selectedCandidate = current.candidates_json.find(
      (candidate) => candidate.candidateId === orderId && candidate.compatible,
    );
    await client.query(
      `UPDATE aruba_document_matches SET status = 'MATCHED', method = 'MANUAL',
         order_id = $2, billing_case_id = (SELECT billing_case_id FROM orders WHERE id = $2),
         related_invoice_document_id = $3, refund_ids = $4, decided_by = $5, decision_reason = $6,
         decided_at = now(), updated_at = now() WHERE remote_document_id = $1`,
      [
        remoteDocumentId,
        orderId,
        invoice?.rows[0]?.document_id ?? null,
        selectedCandidate?.refundIds ?? [],
        actor.id,
        reason.data,
      ],
    );
    let documentId: string | null = null;
    if (isEmissionConfirmed(current.remote_status)) {
      const official = await client.query<{
        storage_object_id: string;
        relative_path: string;
        sha256: string;
        size_bytes: number;
      }>(
        `SELECT files.storage_object_id, storage.relative_path, storage.sha256, storage.size_bytes
         FROM aruba_files AS files
         JOIN storage_objects AS storage ON storage.id = files.storage_object_id
         WHERE files.remote_document_id = $1 AND files.kind = 'ARUBA_XML'
         ORDER BY files.imported_at DESC LIMIT 1`,
        [remoteDocumentId],
      );
      const file = official.rows[0];
      if (!file || file.size_bytes > ARUBA_IMPORT_MAX_BYTES) {
        throw new AppError("ARUBA_IMPORT_INVALID", 409);
      }
      const root = path.resolve(getConfig().DOCUMENT_STORAGE_ROOT);
      const absolutePath = path.resolve(root, file.relative_path);
      if (!absolutePath.startsWith(`${root}${path.sep}`)) {
        throw new AppError("DOCUMENT_STORAGE_FAILED", 500);
      }
      const bytes = await readFile(absolutePath);
      if (
        bytes.byteLength !== file.size_bytes ||
        createHash("sha256").update(bytes).digest("hex") !== file.sha256
      ) {
        throw new AppError("DOCUMENT_STORAGE_FAILED", 500);
      }
      documentId = await materializeMatchedExternalDocument(
        client,
        remoteDocumentId,
        file.storage_object_id,
        validateUntrustedXml(bytes),
      );
    }
    await writeAudit(client, {
      actorType: "ADMIN",
      actorId: String(actor.id),
      action: "ARUBA_DOCUMENT_MATCH_RESOLVED",
      eventClass: "CRITICAL",
      entityType: "ARUBA_REMOTE_DOCUMENT",
      entityId: remoteDocumentId,
      before: { status: current.status, method: current.method, orderId: current.order_id },
      after: { status: "MATCHED", method: "MANUAL", orderId, documentId },
      reason: reason.data,
      requestId: actor.requestId,
    });
    return { matched: true, documentId };
  });
}
