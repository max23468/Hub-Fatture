import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";

import type pg from "pg";

import {
  documentInputSchema,
  fiscalNumberLabel,
  fiscalProfileSchema,
  foreignCustomerFallbackTaxCode,
  generateFatturaXml,
  projectFatturaXml,
  type DocumentInput,
  type FiscalProfile,
} from "../documents.ts";
import { AppError } from "../errors.ts";
import { validateFatturaXml } from "../fatturapa.server.ts";
import { getConfig } from "../config.server.ts";
import { isDatabaseId } from "./order-commands.server.ts";
import { writeAudit } from "./audit.server.ts";
import { getPool, withTransaction } from "./client.server.ts";

interface FiscalActor {
  id: number;
  canApprove: boolean;
  requestId: string;
}

interface CaseOrder {
  id: string;
  provider: "SHOPIFY" | "EBAY";
  display_number: string;
  gross_amount: number;
  payment_status: string;
  customer_snapshot_json: Record<string, unknown>;
}

interface CaseRow {
  id: string;
  revision: number;
  status: string;
  currency: "EUR";
  customer_snapshot_json: Record<string, unknown>;
  orders: CaseOrder[];
}

interface DraftRow {
  id: string;
  status: "DRAFT" | "APPROVED";
  document_date: string;
  fiscal_profile_version: number;
  source_total_amount: number;
  total_amount: number;
  difference_amount: number;
  difference_reason: string | null;
  draft_version: number;
  projection_sha256: string;
  lines: Array<{
    order_id: string;
    description: string;
    quantity: number;
    unit_amount: number;
  }>;
}

const romeDate = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Rome",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
const comparisonMoney = new Intl.NumberFormat("it-IT", {
  style: "currency",
  currency: "EUR",
});

function today(): string {
  return romeDate.format(new Date());
}

function sourceLine(order: CaseOrder) {
  const label = order.provider === "SHOPIFY" ? "Shopify" : "eBay";
  return {
    orderId: order.id,
    description: `Vendita beni usati - Ordine ${label} ${order.display_number}`,
    quantity: 1,
    unitAmount: order.gross_amount,
  };
}

function recipient(snapshot: Record<string, unknown>): DocumentInput["recipient"] {
  const address = (snapshot.billingAddress ?? {}) as Record<string, unknown>;
  const taxIdentifiers = Array.isArray(snapshot.taxIdentifiers) ? snapshot.taxIdentifiers : [];
  return {
    kind: snapshot.kind as DocumentInput["recipient"]["kind"],
    displayName: stringValue(snapshot.displayName),
    firstName: stringValue(snapshot.firstName),
    lastName: stringValue(snapshot.lastName),
    businessName: stringValue(snapshot.companyName),
    certifiedEmail: stringValue(snapshot.certifiedEmail),
    recipientCode: stringValue(snapshot.recipientCode),
    taxIdentifiers: taxIdentifiers.map((value) => {
      const item = value as Record<string, unknown>;
      return {
        type: item.type as "CODICE_FISCALE" | "PARTITA_IVA" | "ALTRO",
        value: String(item.value ?? item.normalizedValue ?? ""),
        countryCode: stringValue(item.countryCode),
      };
    }),
    address: {
      line1: String(address.line1 ?? ""),
      postalCode: String(address.postalCode ?? ""),
      city: String(address.city ?? ""),
      province: stringValue(address.province),
      countryCode: String(address.countryCode ?? ""),
    },
  };
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

async function loadCase(client: pg.Pool | pg.PoolClient, id: string, lock = false) {
  const result = await client.query<CaseRow>(
    `SELECT billing_cases.id, billing_cases.revision, billing_cases.status,
            billing_cases.currency, billing_cases.customer_snapshot_json,
            coalesce(case_orders.orders, '[]') AS orders
     FROM billing_cases
     LEFT JOIN LATERAL (
       SELECT jsonb_agg(jsonb_build_object(
         'id', orders.id::text,
         'provider', orders.provider,
         'display_number', orders.display_number,
         'gross_amount', orders.gross_amount,
         'payment_status', orders.payment_status,
         'customer_snapshot_json', orders.normalized_snapshot_json -> 'customer'
       ) ORDER BY orders.id) AS orders
       FROM orders WHERE orders.billing_case_id = billing_cases.id
     ) AS case_orders ON true
     WHERE billing_cases.id = $1
     ${lock ? "FOR UPDATE OF billing_cases" : ""}`,
    [id],
  );
  return result.rows[0] ?? null;
}

async function loadDraft(client: pg.Pool | pg.PoolClient, caseId: string, lock = false) {
  const result = await client.query<DraftRow>(
    `SELECT documents.*, documents.document_date::text,
            coalesce((
              SELECT jsonb_agg(jsonb_build_object(
                'order_id', document_lines.order_id::text,
                'description', document_lines.description,
                'quantity', document_lines.quantity,
                'unit_amount', document_lines.unit_amount
              ) ORDER BY document_lines.line_number)
              FROM document_lines WHERE document_lines.document_id = documents.id
            ), '[]') AS lines
     FROM documents
     WHERE billing_case_id = $1 AND kind = 'INVOICE'
     ${lock ? "FOR UPDATE" : ""}`,
    [caseId],
  );
  return result.rows[0] ?? null;
}

async function loadProfile(client: pg.Pool | pg.PoolClient, version?: number) {
  const result = await client.query<{
    version: number;
    status: "MOCK" | "AUDITED" | "RETIRED";
    profile_json: FiscalProfile;
  }>(
    version
      ? "SELECT version, status, profile_json FROM fiscal_profiles WHERE version = $1"
      : `SELECT version, status, profile_json FROM fiscal_profiles
         WHERE status IN ('MOCK', 'AUDITED') LIMIT 1`,
    version ? [version] : [],
  );
  const row = result.rows[0];
  if (!row) return null;
  const parsed = fiscalProfileSchema.safeParse(row.profile_json);
  if (!parsed.success) throw new AppError("DOCUMENT_FISCAL_PROFILE_MISSING", 409);
  return { ...row, profile_json: parsed.data };
}

function documentInput(caseRow: CaseRow, draft: DraftRow | null): DocumentInput {
  const parsed = documentInputSchema.safeParse({
    kind: "INVOICE",
    documentDate: draft?.status === "APPROVED" ? draft.document_date : today(),
    recipient: recipient(caseRow.customer_snapshot_json),
    lines:
      draft?.lines.map((line) => ({
        orderId: line.order_id,
        description: line.description,
        quantity: line.quantity,
        unitAmount: line.unit_amount,
      })) ?? caseRow.orders.map(sourceLine),
  });
  if (!parsed.success) throw new AppError("DOCUMENT_INVALID", 422);
  return parsed.data;
}

function joined(values: Array<string | undefined>): string {
  return values.filter(Boolean).join(" · ") || "—";
}

function recipientIdentity(value: DocumentInput["recipient"]): string {
  return (
    value.businessName ??
    ([value.firstName, value.lastName].filter(Boolean).join(" ") || value.displayName || "—")
  );
}

function projectedRecipientIdentity(value: DocumentInput["recipient"]): string {
  return (
    value.businessName ??
    value.displayName ??
    ([value.firstName, value.lastName].filter(Boolean).join(" ") || "—")
  );
}

function recipientAddress(value: DocumentInput["recipient"], projected = false): string {
  return joined([
    value.address.line1,
    joined([
      projected && value.address.countryCode !== "IT" ? "00000" : value.address.postalCode,
      value.address.city,
    ]),
    value.address.countryCode === "IT" ? value.address.province : undefined,
    value.address.countryCode,
  ]);
}

function recipientTaxes(value: DocumentInput["recipient"]): string {
  return joined(
    value.taxIdentifiers.map((identifier) =>
      joined([identifier.type, identifier.countryCode, identifier.value]),
    ),
  );
}

function projectedRecipientTaxes(value: DocumentInput["recipient"]): string {
  const vat =
    value.taxIdentifiers.find((identifier) => identifier.type === "PARTITA_IVA") ??
    (value.kind === "EU"
      ? (value.taxIdentifiers[0] ?? {
          countryCode: value.address.countryCode,
          type: "PARTITA_IVA" as const,
          value: foreignCustomerFallbackTaxCode,
        })
      : undefined);
  const fiscalCode = value.taxIdentifiers.find(
    (identifier) => identifier.type === "CODICE_FISCALE",
  );
  return joined([
    vat
      ? joined(["PARTITA_IVA", vat.countryCode ?? value.address.countryCode, vat.value])
      : undefined,
    fiscalCode ? joined(["CODICE_FISCALE", fiscalCode.value]) : undefined,
  ]);
}

function paymentStatus(value: string): string {
  return (
    {
      PAID: "Pagato",
      PENDING: "In attesa",
      REFUNDED: "Rimborsato",
    }[value] ?? "Da verificare"
  );
}

function sourceRecipients(
  orders: CaseOrder[],
  pick: (value: DocumentInput["recipient"]) => string,
) {
  return joined([...new Set(orders.map((order) => pick(recipient(order.customer_snapshot_json))))]);
}

function money(cents: number): string {
  return comparisonMoney.format(cents / 100);
}

function invoiceComparison(caseRow: CaseRow, input: DocumentInput, profile: FiscalProfile) {
  const destinationCode =
    input.recipient.kind === "EU" ? "XXXXXXX" : (input.recipient.recipientCode ?? "0000000");
  const sourceById = new Map(caseRow.orders.map((order) => [order.id, sourceLine(order)]));
  return {
    recipient: [
      {
        field: "identity" as const,
        source: sourceRecipients(caseRow.orders, recipientIdentity),
        draft: recipientIdentity(input.recipient),
        projected: projectedRecipientIdentity(input.recipient),
      },
      {
        field: "taxes" as const,
        source: sourceRecipients(caseRow.orders, recipientTaxes),
        draft: recipientTaxes(input.recipient),
        projected: projectedRecipientTaxes(input.recipient),
      },
      {
        field: "address" as const,
        source: sourceRecipients(caseRow.orders, recipientAddress),
        draft: recipientAddress(input.recipient),
        projected: recipientAddress(input.recipient, true),
      },
      {
        field: "delivery" as const,
        source: sourceRecipients(caseRow.orders, (value) =>
          joined([value.recipientCode, value.certifiedEmail]),
        ),
        draft: joined([input.recipient.recipientCode, input.recipient.certifiedEmail]),
        projected: joined([
          `SdI ${destinationCode}`,
          destinationCode === "0000000" ? input.recipient.certifiedEmail : undefined,
        ]),
      },
    ],
    lines: input.lines.map((line, index) => {
      const source = sourceById.get(line.orderId ?? "");
      return {
        field: String(index + 1),
        source: source
          ? joined([
              source.description,
              `1 × ${money(source.unitAmount)}`,
              money(source.unitAmount),
            ])
          : "—",
        draft: joined([
          line.description,
          `${line.quantity} × ${money(line.unitAmount)}`,
          money(line.quantity * line.unitAmount),
        ]),
        projected: joined([
          line.description,
          `${line.quantity} × ${money(line.unitAmount)}`,
          money(line.quantity * line.unitAmount),
          profile.taxNature,
        ]),
      };
    }),
    payment: [
      {
        field: "status" as const,
        source: joined(
          caseRow.orders.map(
            (order) =>
              `${order.provider === "SHOPIFY" ? "Shopify" : "eBay"} ${order.display_number}: ${paymentStatus(order.payment_status)}`,
          ),
        ),
        draft: caseRow.orders.some((order) => order.payment_status === "PENDING")
          ? "Pagamento pendente"
          : "Pagamento registrato",
        projected: `${profile.payment.condition} · ${profile.payment.invoiceMethod}`,
      },
    ],
    technical: [
      {
        field: "document" as const,
        source: joined(
          caseRow.orders.map(
            (order) =>
              `${order.provider === "SHOPIFY" ? "Shopify" : "eBay"} ${order.display_number}`,
          ),
        ),
        draft: joined([input.documentDate, profile.series]),
        projected: `TD01 · FPR12 · ${profile.series}`,
      },
      {
        field: "tax" as const,
        source: "—",
        draft: `${profile.seller.taxRegime} · ${profile.taxNature}`,
        projected: `${profile.seller.taxRegime} · ${profile.taxNature} · ${profile.legalReference}`,
      },
    ],
  };
}

export async function getInvoiceProjection(caseId: string) {
  if (!isDatabaseId(caseId)) return null;
  const caseRow = await loadCase(getPool(), caseId);
  if (!caseRow) return null;
  const draft = await loadDraft(getPool(), caseId);
  const profile = await loadProfile(getPool(), draft?.fiscal_profile_version);
  if (!profile) {
    return { caseRevision: caseRow.revision, profileMissing: true as const };
  }
  const input = documentInput(caseRow, draft);
  const projection = projectFatturaXml(profile.profile_json, input);
  await validateFatturaXml(projection.xml);
  const sourceTotal = caseRow.orders.reduce((sum, order) => sum + order.gross_amount, 0);
  const total = input.lines.reduce((sum, line) => sum + line.quantity * line.unitAmount, 0);
  return {
    caseRevision: caseRow.revision,
    profileMissing: false as const,
    profileVersion: profile.version,
    profileStatus: profile.status,
    draftVersion: draft?.draft_version ?? 0,
    documentDate: input.documentDate,
    lines: input.lines,
    sourceLines: caseRow.orders.map(sourceLine),
    sourceTotal,
    total,
    difference: total - sourceTotal,
    differenceReason: draft?.difference_reason ?? "",
    paymentPending: caseRow.orders.some((order) => order.payment_status === "PENDING"),
    projectionSha256: projection.sha256,
    xml: projection.xml,
    comparison: invoiceComparison(caseRow, input, profile.profile_json),
    approved: draft?.status === "APPROVED",
  };
}

export async function saveInvoiceDraft(
  caseId: string,
  raw: {
    caseRevision: unknown;
    draftVersion: unknown;
    lines: unknown;
    differenceReason: unknown;
  },
  actor: FiscalActor,
) {
  if (!isDatabaseId(caseId)) return null;
  const caseRevision = integer(raw.caseRevision);
  const draftVersion = integer(raw.draftVersion);
  const differenceReason = stringValue(raw.differenceReason);
  return withTransaction(async (client) => {
    const caseRow = await loadCase(client, caseId, true);
    if (!caseRow) return null;
    if (caseRow.revision !== caseRevision) throw new AppError("CONFLICT_REVISION", 409);
    if (!["DRAFT", "READY", "NEEDS_REVIEW"].includes(caseRow.status)) {
      throw new AppError("BILLING_CASE_NOT_EDITABLE", 409);
    }
    const current = await loadDraft(client, caseId, true);
    if (current?.status === "APPROVED") throw new AppError("BILLING_CASE_NOT_EDITABLE", 409);
    if ((current?.draft_version ?? 0) !== draftVersion) {
      throw new AppError("CONFLICT_REVISION", 409);
    }
    const profile = await loadProfile(client);
    if (!profile) throw new AppError("DOCUMENT_FISCAL_PROFILE_MISSING", 409);
    const documentDate = today();
    const parsed = documentInputSchema.safeParse({
      kind: "INVOICE",
      documentDate,
      recipient: recipient(caseRow.customer_snapshot_json),
      lines: raw.lines,
    });
    if (!parsed.success || !sameOrders(parsed.data.lines, caseRow.orders)) {
      throw new AppError("DOCUMENT_INVALID", 422);
    }
    const sourceTotal = caseRow.orders.reduce((sum, order) => sum + order.gross_amount, 0);
    const total = parsed.data.lines.reduce((sum, line) => sum + line.quantity * line.unitAmount, 0);
    if (total !== sourceTotal && !differenceReason) throw new AppError("DOCUMENT_INVALID", 422);
    const projection = projectFatturaXml(profile.profile_json, parsed.data);
    await validateFatturaXml(projection.xml);
    const nextVersion = draftVersion + 1;
    const document = await client.query<{ id: string }>(
      current
        ? `UPDATE documents SET document_date = $2, fiscal_profile_version = $3,
             total_amount = $4, source_total_amount = $5, difference_amount = $6,
             difference_reason = $7, draft_version = $8, projection_sha256 = $9,
             updated_at = now()
           WHERE id = $1 RETURNING id`
        : `INSERT INTO documents
             (billing_case_id, kind, status, document_type, series, document_date,
              fiscal_profile_version, currency, total_amount, source_total_amount,
              difference_amount, difference_reason, draft_version, projection_sha256)
           VALUES ($1, 'INVOICE', 'DRAFT', 'TD01', 'FPR', $2, $3, 'EUR', $4, $5, $6, $7, $8, $9)
           RETURNING id`,
      [
        current?.id ?? caseId,
        parsed.data.documentDate,
        profile.version,
        total,
        sourceTotal,
        total - sourceTotal,
        differenceReason ?? null,
        nextVersion,
        projection.sha256,
      ],
    );
    const documentId = document.rows[0]!.id;
    if (current) {
      await client.query("DELETE FROM document_lines WHERE document_id = $1", [documentId]);
      await client.query("DELETE FROM document_orders WHERE document_id = $1", [documentId]);
    }
    const ordersById = new Map(caseRow.orders.map((order) => [order.id, order]));
    for (const [index, line] of parsed.data.lines.entries()) {
      const order = ordersById.get(line.orderId!)!;
      await client.query(
        `INSERT INTO document_orders (document_id, document_kind, order_id, amount)
         VALUES ($1, 'INVOICE', $2, $3)`,
        [documentId, line.orderId, order.gross_amount],
      );
      await client.query(
        `INSERT INTO document_lines
          (document_id, order_id, line_number, description, quantity, unit_amount,
           total_amount, tax_nature)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'N5')`,
        [
          documentId,
          line.orderId,
          index + 1,
          line.description,
          line.quantity,
          line.unitAmount,
          line.quantity * line.unitAmount,
        ],
      );
    }
    await client.query(
      `UPDATE billing_cases SET revision = revision + 1, fiscal_profile_version = $2,
       updated_at = now() WHERE id = $1`,
      [caseId, profile.version],
    );
    await writeAudit(client, {
      actorType: "ADMIN",
      actorId: String(actor.id),
      action: "DOCUMENT_DRAFT_SAVED",
      eventClass: "CRITICAL",
      entityType: "DOCUMENT",
      entityId: documentId,
      metadata: {
        billingCaseId: caseId,
        documentKind: "INVOICE",
        fiscalProfileVersion: profile.version,
      },
      reason: differenceReason ?? null,
      requestId: actor.requestId,
    });
    return documentId;
  });
}

function sameOrders(lines: DocumentInput["lines"], orders: CaseOrder[]): boolean {
  const ids = lines.map((line) => line.orderId);
  const uniqueIds = new Set(ids);
  return (
    ids.length === orders.length &&
    uniqueIds.size === ids.length &&
    orders.every((order) => uniqueIds.has(order.id))
  );
}

function integer(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 2_147_483_647) {
    throw new AppError("CONFLICT_REVISION", 409);
  }
  return parsed;
}

interface StoredDocumentRow {
  id: string;
  billing_case_id: string;
  series: string;
  fiscal_year: number;
  fiscal_number: number;
  immutable_snapshot_json: unknown;
  fiscal_profile_snapshot_json: unknown;
  relative_path: string;
  sha256: string;
  size_bytes: number;
}

function errno(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function storagePath(relativePath: string): { root: string; absolutePath: string } {
  const root = path.resolve(getConfig().DOCUMENT_STORAGE_ROOT);
  const absolutePath = path.resolve(root, relativePath);
  if (!absolutePath.startsWith(`${root}${path.sep}`)) {
    throw new AppError("DOCUMENT_STORAGE_FAILED", 500);
  }
  return { root, absolutePath };
}

async function verifiedFile(
  filePath: string,
  sha256: string,
  sizeBytes: number,
): Promise<Buffer | null> {
  let contents;
  try {
    contents = await readFile(filePath);
  } catch (error) {
    if (errno(error, "ENOENT")) return null;
    throw new AppError("DOCUMENT_STORAGE_FAILED", 500);
  }
  if (
    contents.byteLength !== sizeBytes ||
    createHash("sha256").update(contents).digest("hex") !== sha256
  ) {
    throw new AppError("DOCUMENT_STORAGE_FAILED", 500);
  }
  return contents;
}

function regenerateStoredXml(row: StoredDocumentRow): string {
  const input = documentInputSchema.parse(row.immutable_snapshot_json);
  const profile = fiscalProfileSchema.parse(row.fiscal_profile_snapshot_json);
  const xml = generateFatturaXml(profile, input, {
    year: row.fiscal_year,
    number: row.fiscal_number,
  });
  if (
    Buffer.byteLength(xml) !== row.size_bytes ||
    createHash("sha256").update(xml).digest("hex") !== row.sha256
  ) {
    throw new AppError("DOCUMENT_STORAGE_FAILED", 500);
  }
  return xml;
}

async function materializeStoredXml(row: StoredDocumentRow, approvedXml?: string) {
  const { root, absolutePath } = storagePath(row.relative_path);
  const stageDirectory = path.join(root, ".staging");
  const stagePath = path.join(stageDirectory, `${row.id}-${row.sha256}.xml`);
  await mkdir(path.dirname(absolutePath), { recursive: true, mode: 0o700 });
  await mkdir(stageDirectory, { recursive: true, mode: 0o700 });
  if (await verifiedFile(absolutePath, row.sha256, row.size_bytes)) {
    await unlink(stagePath).catch((error: unknown) => {
      if (!errno(error, "ENOENT")) throw error;
    });
    return;
  }
  const xml = approvedXml ?? regenerateStoredXml(row);
  if (!(await verifiedFile(stagePath, row.sha256, row.size_bytes))) {
    const temporaryPath = `${stagePath}.${randomUUID()}.tmp`;
    try {
      const handle = await open(temporaryPath, "wx", 0o600);
      try {
        await handle.writeFile(xml);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporaryPath, stagePath);
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      throw error instanceof AppError ? error : new AppError("DOCUMENT_STORAGE_FAILED", 500);
    }
  }
  try {
    await link(stagePath, absolutePath);
  } catch (error) {
    if (!errno(error, "EEXIST")) throw new AppError("DOCUMENT_STORAGE_FAILED", 500);
    if (!(await verifiedFile(absolutePath, row.sha256, row.size_bytes))) {
      throw new AppError("DOCUMENT_STORAGE_FAILED", 500);
    }
  }
  await unlink(stagePath).catch((error: unknown) => {
    if (!errno(error, "ENOENT")) throw error;
  });
}

async function loadStoredDocuments(where = "", value?: string): Promise<StoredDocumentRow[]> {
  const result = await getPool().query<StoredDocumentRow>(
    `SELECT documents.id, documents.billing_case_id, documents.series,
            documents.fiscal_year, documents.fiscal_number,
            documents.immutable_snapshot_json, documents.fiscal_profile_snapshot_json,
            storage_objects.relative_path, storage_objects.sha256, storage_objects.size_bytes
     FROM documents
     JOIN storage_objects ON storage_objects.id = documents.storage_object_id
     WHERE documents.status = 'APPROVED' ${where}`,
    value ? [value] : [],
  );
  return result.rows;
}

export async function reconcileDocumentStorage(): Promise<void> {
  await Promise.all((await loadStoredDocuments()).map((row) => materializeStoredXml(row)));
}

export function startDocumentStorageReconciliation(): void {
  void reconcileDocumentStorage().catch((error: unknown) => console.error(error));
}

export async function approveInvoice(
  caseId: string,
  raw: {
    caseRevision: unknown;
    draftVersion: unknown;
    projectionSha256: unknown;
    confirmPending: boolean;
    confirmDifference: boolean;
  },
  actor: FiscalActor,
) {
  if (!actor.canApprove) throw new AppError("DOCUMENT_APPROVAL_FORBIDDEN", 403);
  if (!isDatabaseId(caseId)) return null;
  const caseRevision = integer(raw.caseRevision);
  const draftVersion = integer(raw.draftVersion);
  const expectedProjection = String(raw.projectionSha256 ?? "");
  let committed: {
    id: string;
    fiscalNumber: string;
    xml: string;
    storage: StoredDocumentRow;
  } | null;
  try {
    committed = await withTransaction(async (client) => {
      const caseRow = await loadCase(client, caseId, true);
      if (!caseRow) return null;
      if (caseRow.status !== "READY") throw new AppError("DOCUMENT_NOT_APPROVABLE", 409);
      if (caseRow.revision !== caseRevision) throw new AppError("CONFLICT_REVISION", 409);
      const draft = await loadDraft(client, caseId, true);
      if (!draft || draft.status !== "DRAFT" || draft.draft_version !== draftVersion) {
        throw new AppError("CONFLICT_REVISION", 409);
      }
      const profile = await loadProfile(client, draft.fiscal_profile_version);
      if (!profile || profile.status === "RETIRED") {
        throw new AppError("DOCUMENT_FISCAL_PROFILE_MISSING", 409);
      }
      if (getConfig().APP_ENV === "production" && profile.status !== "AUDITED") {
        throw new AppError("DOCUMENT_FISCAL_PROFILE_MISSING", 409);
      }
      const input = documentInput(caseRow, draft);
      const projected = projectFatturaXml(profile.profile_json, input);
      await validateFatturaXml(projected.xml);
      if (
        projected.sha256 !== expectedProjection ||
        draft.projection_sha256 !== expectedProjection
      ) {
        throw new AppError("DOCUMENT_PROJECTION_STALE", 409);
      }
      if (
        caseRow.orders.some((order) => order.payment_status === "PENDING") &&
        !raw.confirmPending
      ) {
        throw new AppError("DOCUMENT_NOT_APPROVABLE", 409);
      }
      if (draft.difference_amount !== 0 && !raw.confirmDifference) {
        throw new AppError("DOCUMENT_NOT_APPROVABLE", 409);
      }
      const year = Number(input.documentDate.slice(0, 4));
      const series = profile.profile_json.series;
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        `fiscal-number:${series}:${year}`,
      ]);
      const sequence = await client.query<{ next: number }>(
        `SELECT greatest(coalesce(max(fiscal_number), 0), $3::integer) + 1 AS next
         FROM documents WHERE status = 'APPROVED' AND series = $1 AND fiscal_year = $2`,
        [
          series,
          year,
          profile.profile_json.numbering.lastObservedYear === year
            ? profile.profile_json.numbering.lastObservedNumber
            : 0,
        ],
      );
      const fiscalNumber = Number(sequence.rows[0]!.next);
      const xml = generateFatturaXml(profile.profile_json, input, {
        year,
        number: fiscalNumber,
      });
      await validateFatturaXml(xml);
      const sha256 = createHash("sha256").update(xml).digest("hex");
      const relativePath = path.posix.join(
        "invoices",
        String(year),
        `${series}-${String(fiscalNumber).padStart(4, "0")}-${String(year).slice(-2)}.xml`,
      );
      storagePath(relativePath);
      const storage = await client.query<{ id: string }>(
        `INSERT INTO storage_objects
          (kind, relative_path, sha256, size_bytes, content_type)
         VALUES ('INVOICE_XML', $1, $2, $3, 'application/xml') RETURNING id`,
        [relativePath, sha256, Buffer.byteLength(xml)],
      );
      const approvedAt = new Date().toISOString();
      const snapshot = {
        kind: input.kind,
        documentDate: input.documentDate,
        recipient: input.recipient,
        lines: input.lines,
        sourceTotal: draft.source_total_amount,
        total: draft.total_amount,
        difference: draft.difference_amount,
        differenceReason: draft.difference_reason,
      };
      await client.query(
        `UPDATE documents SET status = 'APPROVED', fiscal_year = $2, fiscal_number = $3,
           document_date = $4, approved_at = $5, pending_payment_confirmed_at = $6,
           amount_difference_confirmed_at = $7, xml_sha256 = $8,
           immutable_snapshot_json = $9, fiscal_profile_snapshot_json = $10,
           storage_object_id = $11, updated_at = now()
         WHERE id = $1`,
        [
          draft.id,
          year,
          fiscalNumber,
          input.documentDate,
          approvedAt,
          raw.confirmPending ? approvedAt : null,
          raw.confirmDifference ? approvedAt : null,
          sha256,
          JSON.stringify(snapshot),
          JSON.stringify(profile.profile_json),
          storage.rows[0]!.id,
        ],
      );
      await client.query(
        `UPDATE billing_cases SET status = 'APPROVED', revision = revision + 1,
         updated_at = now() WHERE id = $1`,
        [caseId],
      );
      await client.query(
        `UPDATE orders SET trigger_status = 'INVOICED' WHERE billing_case_id = $1`,
        [caseId],
      );
      const label = fiscalNumberLabel(series, year, fiscalNumber);
      await writeAudit(client, {
        actorType: "ADMIN",
        actorId: String(actor.id),
        action: "DOCUMENT_NUMBERED",
        eventClass: "CRITICAL",
        entityType: "DOCUMENT",
        entityId: draft.id,
        metadata: {
          billingCaseId: caseId,
          documentKind: "INVOICE",
          fiscalNumber: label,
          fiscalProfileVersion: profile.version,
        },
        requestId: actor.requestId,
      });
      await writeAudit(client, {
        actorType: "ADMIN",
        actorId: String(actor.id),
        action: "DOCUMENT_APPROVED",
        eventClass: "CRITICAL",
        entityType: "DOCUMENT",
        entityId: draft.id,
        metadata: {
          billingCaseId: caseId,
          documentKind: "INVOICE",
          fiscalNumber: label,
          fiscalProfileVersion: profile.version,
        },
        requestId: actor.requestId,
      });
      return {
        id: draft.id,
        fiscalNumber: label,
        xml,
        storage: {
          id: draft.id,
          billing_case_id: caseId,
          series,
          fiscal_year: year,
          fiscal_number: fiscalNumber,
          immutable_snapshot_json: snapshot,
          fiscal_profile_snapshot_json: profile.profile_json,
          relative_path: relativePath,
          sha256,
          size_bytes: Buffer.byteLength(xml),
        },
      };
    });
  } catch (error) {
    if (error instanceof AppError) throw error;
    const recovered = await loadStoredDocuments("AND documents.billing_case_id = $1", caseId).catch(
      () => [],
    );
    if (!recovered[0]) throw error;
    await materializeStoredXml(recovered[0]);
    return {
      id: recovered[0].id,
      fiscalNumber: fiscalNumberLabel(
        recovered[0].series,
        recovered[0].fiscal_year,
        recovered[0].fiscal_number,
      ),
    };
  }
  if (!committed) return null;
  await materializeStoredXml(committed.storage, committed.xml);
  return { id: committed.id, fiscalNumber: committed.fiscalNumber };
}

export async function activateFiscalProfile(
  rawProfile: unknown,
  sourceXmlSha256: string,
  actor: FiscalActor,
) {
  if (!actor.canApprove) throw new AppError("DOCUMENT_APPROVAL_FORBIDDEN", 403);
  const profile = fiscalProfileSchema.safeParse(rawProfile);
  if (!profile.success || !/^[0-9a-f]{64}$/.test(sourceXmlSha256)) {
    throw new AppError("DOCUMENT_INVALID", 422);
  }
  return withTransaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('fiscal-profile'))");
    const active = (
      await client.query<{ profile_json: unknown }>(
        "SELECT profile_json FROM fiscal_profiles WHERE status IN ('MOCK', 'AUDITED')",
      )
    ).rows[0];
    const previous = fiscalProfileSchema.safeParse(active?.profile_json);
    if (
      previous.success &&
      previous.data.series === profile.data.series &&
      (previous.data.numbering.lastObservedYear > profile.data.numbering.lastObservedYear ||
        (previous.data.numbering.lastObservedYear === profile.data.numbering.lastObservedYear &&
          previous.data.numbering.lastObservedNumber > profile.data.numbering.lastObservedNumber))
    ) {
      throw new AppError("DOCUMENT_INVALID", 422);
    }
    await client.query(
      "UPDATE fiscal_profiles SET status = 'RETIRED' WHERE status IN ('MOCK', 'AUDITED')",
    );
    const version = Number(
      (
        await client.query<{ version: number }>(
          "SELECT coalesce(max(version), 0) + 1 AS version FROM fiscal_profiles",
        )
      ).rows[0]!.version,
    );
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO fiscal_profiles
        (version, status, profile_json, source_xml_sha256, audited_at)
       VALUES ($1, 'AUDITED', $2, $3, now()) RETURNING id`,
      [version, JSON.stringify(profile.data), sourceXmlSha256],
    );
    await writeAudit(client, {
      actorType: "ADMIN",
      actorId: String(actor.id),
      action: "FISCAL_PROFILE_ACTIVATED",
      eventClass: "CRITICAL",
      entityType: "FISCAL_PROFILE",
      entityId: inserted.rows[0]!.id,
      metadata: {
        fiscalProfileVersion: version,
        lastObservedYear: profile.data.numbering.lastObservedYear,
        lastObservedNumber: profile.data.numbering.lastObservedNumber,
      },
      requestId: actor.requestId,
    });
    return version;
  });
}

export async function listDocuments() {
  const result = await getPool().query<{
    id: string;
    billing_case_id: string;
    kind: string;
    status: string;
    series: string;
    fiscal_year: number | null;
    fiscal_number: number | null;
    document_date: string;
    total_amount: number;
    customer_name: string;
    xml_sha256: string | null;
  }>(
    `SELECT documents.id, documents.billing_case_id, documents.kind, documents.status,
            documents.series, documents.fiscal_year, documents.fiscal_number,
            documents.document_date::text, documents.total_amount, documents.xml_sha256,
            billing_cases.customer_snapshot_json ->> 'displayName' AS customer_name
     FROM documents JOIN billing_cases ON billing_cases.id = documents.billing_case_id
     ORDER BY documents.document_date DESC, documents.id DESC`,
  );
  return result.rows.map((row) => ({
    ...row,
    fiscal_label:
      row.fiscal_year && row.fiscal_number
        ? fiscalNumberLabel(row.series, row.fiscal_year, row.fiscal_number)
        : null,
  }));
}

export async function readDocumentXml(documentId: string): Promise<Buffer | null> {
  if (!isDatabaseId(documentId)) return null;
  const row = (await loadStoredDocuments("AND documents.id = $1", documentId))[0];
  if (!row || row.size_bytes > 4_900_000) return null;
  await materializeStoredXml(row);
  return verifiedFile(storagePath(row.relative_path).absolutePath, row.sha256, row.size_bytes);
}

export async function listMassApprovalCandidates() {
  const result = await getPool().query<{
    billing_case_id: string;
    case_revision: number;
    draft_version: number;
    projection_sha256: string;
    public_number: string;
    customer_name: string;
    total_amount: number;
  }>(
    `SELECT billing_cases.id AS billing_case_id, billing_cases.revision AS case_revision,
            documents.draft_version, documents.projection_sha256, billing_cases.public_number,
            billing_cases.customer_snapshot_json ->> 'displayName' AS customer_name,
            documents.total_amount
     FROM documents
     JOIN billing_cases ON billing_cases.id = documents.billing_case_id
     JOIN fiscal_profiles ON fiscal_profiles.version = documents.fiscal_profile_version
     WHERE documents.kind = 'INVOICE' AND documents.status = 'DRAFT'
       AND documents.difference_amount = 0 AND billing_cases.status = 'READY'
       AND fiscal_profiles.status IN ('MOCK', 'AUDITED')
       AND NOT EXISTS (
         SELECT 1 FROM orders
         WHERE orders.billing_case_id = billing_cases.id AND orders.payment_status = 'PENDING'
       )
     ORDER BY billing_cases.id
     LIMIT 100`,
  );
  return result.rows;
}

function approvalCandidate(value: string) {
  const match = /^(\d+):(\d+):(\d+):([0-9a-f]{64})$/.exec(value);
  if (!match || !isDatabaseId(match[1]!)) throw new AppError("DOCUMENT_INVALID", 422);
  return {
    caseId: match[1]!,
    caseRevision: integer(match[2]),
    draftVersion: integer(match[3]),
    projectionSha256: match[4]!,
  };
}

export async function approveInvoices(rawCandidates: string[], actor: FiscalActor) {
  if (!actor.canApprove) throw new AppError("DOCUMENT_APPROVAL_FORBIDDEN", 403);
  if (!rawCandidates.length || rawCandidates.length > 100) {
    throw new AppError("DOCUMENT_INVALID", 422);
  }
  const candidates = [
    ...new Map(
      rawCandidates.map((value) => {
        const candidate = approvalCandidate(value);
        return [candidate.caseId, candidate] as const;
      }),
    ).values(),
  ];
  const outcomes = await Promise.all(
    candidates.map(async (candidate) => {
      try {
        await approveInvoice(
          candidate.caseId,
          {
            caseRevision: candidate.caseRevision,
            draftVersion: candidate.draftVersion,
            projectionSha256: candidate.projectionSha256,
            confirmPending: false,
            confirmDifference: false,
          },
          actor,
        );
        return true;
      } catch (error) {
        if (!(error instanceof AppError)) throw error;
        return false;
      }
    }),
  );
  const approved = outcomes.filter(Boolean).length;
  return { approved, failed: candidates.length - approved };
}
