import { createHash } from "node:crypto";
import path from "node:path";

import { AppError } from "../errors.ts";
import { z } from "zod";
import { validateUntrustedXml } from "../aruba.ts";
import { acceptedInvoiceFromXml, fiscalProfileSchema, type FiscalProfile } from "../documents.ts";
import { validateFatturaXml } from "../fatturapa.server.ts";
import {
  draftTriggerSchema,
  POSTGRES_INTEGER_MAX,
  triggerStatus,
  type OrderInput,
} from "../orders.ts";
import { preIssueRefund } from "../refunds.ts";
import { writeAudit } from "./audit.server.ts";
import { getPool, withTransaction } from "./client.server.ts";
import { archiveImportedInvoiceXml } from "./documents.server.ts";
import {
  groupOrder,
  reconcilePreIssueInvoiceAmount,
  serializeOrderMutations,
  type Actor,
} from "./order-import.server.ts";

const POSTGRES_BIGINT_MAX = "9223372036854775807";
const historicalReconciliationSchema = z.object({
  outcome: z.enum(["ALREADY_INVOICED", "NOT_INVOICED"]),
  reference: z.string().trim().min(10).max(500),
});

function fiscalContract(profile: FiscalProfile) {
  const { phone: _phone, email: _email, ...seller } = profile.seller;
  const {
    lastObservedYear: _year,
    lastObservedNumber: _number,
    sourceXmlSha256: _sha256,
    approvedAt: _approvedAt,
    ...numbering
  } = profile.numbering;
  return { ...profile, seller, numbering };
}

function hasOrderReference(references: string[], provider: string, displayNumber: string) {
  const expectedProvider = provider.toLowerCase();
  const expectedNumber = displayNumber.toLowerCase();
  return references.some((reference) => {
    const value = reference.toLowerCase();
    if (!value.includes(expectedProvider)) return false;
    const boundary = /[\p{L}\p{N}]/u;
    for (let index = value.indexOf(expectedNumber); index >= 0;) {
      if (
        !boundary.test(value[index - 1] ?? "") &&
        !boundary.test(value[index + expectedNumber.length] ?? "")
      ) {
        return true;
      }
      index = value.indexOf(expectedNumber, index + expectedNumber.length);
    }
    return false;
  });
}

function attributedInvoiceAmount(
  invoice: ReturnType<typeof acceptedInvoiceFromXml>,
  provider: string,
  displayNumber: string,
) {
  const matchingLines = invoice.input.lines.filter((line) =>
    hasOrderReference([line.description], provider, displayNumber),
  );
  if (matchingLines.length > 0) {
    return matchingLines.reduce((sum, line) => sum + line.unitAmount * line.quantity, 0);
  }
  return invoice.input.lines.length === 1 &&
    hasOrderReference(invoice.references, provider, displayNumber)
    ? invoice.totalAmount
    : null;
}

function normalizedIdentityPart(value: unknown) {
  return typeof value === "string"
    ? value.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("it")
    : "";
}

function matchesRecipientWithoutTaxId(
  customer: Record<string, unknown>,
  recipient: ReturnType<typeof acceptedInvoiceFromXml>["input"]["recipient"],
) {
  const billingAddress =
    customer.billingAddress && typeof customer.billingAddress === "object"
      ? (customer.billingAddress as Record<string, unknown>)
      : {};
  const customerName =
    normalizedIdentityPart(customer.companyName) ||
    normalizedIdentityPart([customer.firstName, customer.lastName].filter(Boolean).join(" "));
  const recipientName =
    normalizedIdentityPart(recipient.businessName) ||
    normalizedIdentityPart([recipient.firstName, recipient.lastName].filter(Boolean).join(" "));
  const customerAddress = ["line1", "postalCode", "city", "countryCode"].map((key) =>
    normalizedIdentityPart(billingAddress[key]),
  );
  const recipientAddress = ["line1", "postalCode", "city", "countryCode"].map((key) =>
    normalizedIdentityPart(recipient.address[key as keyof typeof recipient.address]),
  );
  return (
    Boolean(customerName && recipientName && customerAddress.every(Boolean)) &&
    customerName === recipientName &&
    customerAddress.length === recipientAddress.length &&
    customerAddress.every((value, index) => value === recipientAddress[index])
  );
}

export function isDatabaseId(id: string) {
  return (
    /^[1-9]\d*$/.test(id) &&
    (id.length < POSTGRES_BIGINT_MAX.length ||
      (id.length === POSTGRES_BIGINT_MAX.length && id <= POSTGRES_BIGINT_MAX))
  );
}

export async function getDraftTrigger() {
  const result = await getPool().query<{ value_json: unknown; version: number }>(
    "SELECT value_json, version FROM settings WHERE key = 'draft_trigger'",
  );
  return {
    value: draftTriggerSchema.parse(result.rows[0]?.value_json ?? "PAID"),
    version: result.rows[0]?.version ?? 0,
  };
}

export async function setDraftTrigger(value: unknown, expectedVersion: number, actor: Actor) {
  const trigger = draftTriggerSchema.safeParse(value);
  if (
    !trigger.success ||
    !Number.isInteger(expectedVersion) ||
    expectedVersion < 0 ||
    expectedVersion > POSTGRES_INTEGER_MAX
  ) {
    throw new AppError("ORDER_INVALID_INPUT", 422);
  }
  return withTransaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('setting:draft_trigger'))");
    await serializeOrderMutations(client);
    const setting = await client.query<{ version: number }>(
      "SELECT version FROM settings WHERE key = 'draft_trigger' FOR UPDATE",
    );
    if (setting.rows[0]?.version !== expectedVersion) {
      throw new AppError("CONFLICT_REVISION", 409);
    }
    const updated = await client.query<{ version: number }>(
      `UPDATE settings
       SET value_json = $1, version = version + 1, updated_at = now()
       WHERE key = 'draft_trigger'
       RETURNING version`,
      [JSON.stringify(trigger.data)],
    );
    await writeAudit(client, {
      actorType: "ADMIN",
      actorId: String(actor.id),
      action: "DRAFT_TRIGGER_CHANGED",
      eventClass: "CRITICAL",
      entityType: "SETTING",
      entityId: "draft_trigger",
      metadata: { value: trigger.data },
      requestId: actor.requestId,
    });
    const ungrouped = await client.query<{
      id: string;
      customer_id: string;
      customer_snapshot: Record<string, unknown>;
      local_order_date: string;
      currency: string;
      payment_status: OrderInput["paymentStatus"];
      fulfillment_status: OrderInput["fulfillmentStatus"];
      cancelled_at: string | null;
      historical: boolean;
      historical_reconciliation_outcome: "ALREADY_INVOICED" | "NOT_INVOICED" | null;
    }>(
      `SELECT orders.id, orders.customer_id,
              orders.normalized_snapshot_json -> 'customerSnapshot' AS customer_snapshot,
              orders.local_order_date::text, orders.currency, orders.payment_status,
              orders.fulfillment_status, orders.cancelled_at,
              orders.historical_reconciliation_outcome,
              coalesce((orders.normalized_snapshot_json ->> 'historical')::boolean, false)
                AS historical
       FROM orders
       WHERE orders.billing_case_id IS NULL`,
    );
    for (const order of ungrouped.rows) {
      const status =
        order.historical_reconciliation_outcome === "ALREADY_INVOICED"
          ? "INVOICED"
          : triggerStatus(
              {
                cancelledAt: order.cancelled_at,
                paymentStatus: order.payment_status,
                fulfillmentStatus: order.fulfillment_status,
                historical: order.historical && order.historical_reconciliation_outcome === null,
              },
              trigger.data,
            );
      const updatedOrder = await client.query(
        `UPDATE orders SET trigger_status = $2
         WHERE id = $1 AND billing_case_id IS NULL
         RETURNING id`,
        [order.id, status],
      );
      if (status === "ELIGIBLE" && updatedOrder.rowCount) {
        await groupOrder(
          client,
          {
            id: order.id,
            customerId: order.customer_id,
            customerSnapshot: order.customer_snapshot,
            localOrderDate: order.local_order_date,
            currency: order.currency,
          },
          actor,
        );
      }
    }
    return { value: trigger.data, version: updated.rows[0]!.version };
  });
}

export async function reconcileHistoricalOrder(
  id: string,
  raw: { outcome: unknown; reference: unknown; invoiceXml?: Buffer },
  actor: Actor & { canApprove: boolean },
) {
  if (!actor.canApprove) throw new AppError("ORDER_HISTORY_RECONCILIATION_FORBIDDEN", 403);
  if (!isDatabaseId(id)) return null;
  const parsed = historicalReconciliationSchema.safeParse(raw);
  if (!parsed.success || actor.id === undefined) throw new AppError("ORDER_INVALID_INPUT", 422);
  let importedInvoice: ReturnType<typeof acceptedInvoiceFromXml> | null = null;
  let importedTaxIdentifiers = new Set<string>();
  let invoicePath: string | null = null;
  if (parsed.data.outcome === "ALREADY_INVOICED") {
    if (!raw.invoiceXml?.byteLength) {
      throw new AppError("ORDER_HISTORY_INVOICE_REQUIRED", 422);
    }
    try {
      const xml = validateUntrustedXml(raw.invoiceXml);
      await validateFatturaXml(xml);
      importedInvoice = acceptedInvoiceFromXml(xml, new Date().toISOString());
      importedTaxIdentifiers = new Set(
        importedInvoice.input.recipient.taxIdentifiers.map((identifier) => identifier.value),
      );
      const digest = createHash("sha256").update(xml).digest("hex");
      invoicePath = path.posix.join(
        "invoices",
        "history",
        String(importedInvoice.year),
        `${importedInvoice.documentNumber.replaceAll(" ", "-").replaceAll("/", "-")}-${digest}.xml`,
      );
    } catch (error) {
      if (error instanceof AppError && error.code === "DOCUMENT_STORAGE_FAILED") throw error;
      throw new AppError("ORDER_HISTORY_INVOICE_INVALID", 422);
    }
  }
  return withTransaction(async (client) => {
    let archivedInvoice: Awaited<ReturnType<typeof archiveImportedInvoiceXml>> | null = null;
    try {
      if (importedInvoice && invoicePath) {
        archivedInvoice = await archiveImportedInvoiceXml(client, invoicePath, importedInvoice.xml);
      }
      await client.query("SELECT pg_advisory_xact_lock_shared(hashtext('setting:draft_trigger'))");
      await serializeOrderMutations(client);
      const order = await client.query<{
        id: string;
        customer_id: string;
        customer_snapshot: Record<string, unknown>;
        local_order_date: string;
        currency: string;
        payment_status: OrderInput["paymentStatus"];
        provider: "SHOPIFY" | "EBAY";
        display_number: string;
        fulfillment_status: OrderInput["fulfillmentStatus"];
        cancelled_at: string | null;
        trigger_status: string;
        historical: boolean;
        historical_reconciled_at: Date | null;
        historical_reconciliation_outcome: "ALREADY_INVOICED" | "NOT_INVOICED" | null;
        historical_invoice_id: string | null;
        gross_amount: number;
        tax_identifiers: string[];
        refunds: Array<{
          id: string;
          status: string;
          amount: number | null;
          completed_date: string | null;
        }>;
      }>(
        `SELECT orders.id, orders.customer_id, orders.provider, orders.display_number,
              orders.normalized_snapshot_json -> 'customerSnapshot' AS customer_snapshot,
              orders.local_order_date::text, orders.currency, orders.payment_status,
              orders.fulfillment_status, orders.cancelled_at, orders.trigger_status,
              coalesce((orders.normalized_snapshot_json ->> 'historical')::boolean, false)
                AS historical,
              orders.historical_reconciled_at, orders.gross_amount,
              orders.historical_reconciliation_outcome,
              (SELECT document_orders.document_id::text
               FROM document_orders JOIN documents ON documents.id = document_orders.document_id
               WHERE document_orders.order_id = orders.id
                 AND document_orders.document_kind = 'INVOICE'
                 AND documents.origin = 'ARUBA_HISTORY' LIMIT 1) AS historical_invoice_id,
              coalesce((
                SELECT jsonb_agg(order_tax_identifiers.normalized_value)
                FROM order_tax_identifiers WHERE order_tax_identifiers.order_id = orders.id
              ), '[]'::jsonb) AS tax_identifiers,
              coalesce((
                SELECT jsonb_agg(jsonb_build_object(
                  'id', refunds.id::text, 'status', refunds.status, 'amount', refunds.amount,
                  'completed_date',
                    (refunds.completed_at AT TIME ZONE 'Europe/Rome')::date::text
                )) FROM refunds WHERE refunds.order_id = orders.id
              ), '[]'::jsonb) AS refunds
       FROM orders WHERE orders.id = $1 FOR UPDATE`,
        [id],
      );
      const current = order.rows[0];
      if (!current) {
        await archivedInvoice?.cleanupIfUnreferenced();
        return null;
      }
      const attachingInvoice =
        current.historical_reconciliation_outcome === "ALREADY_INVOICED" &&
        parsed.data.outcome === "ALREADY_INVOICED" &&
        !current.historical_invoice_id;
      if (!current.historical || (!attachingInvoice && current.historical_reconciled_at)) {
        throw new AppError("CONFLICT_REVISION", 409);
      }
      if (!attachingInvoice && current.trigger_status !== "LEGACY_BILLING_REVIEW") {
        throw new AppError("CONFLICT_REVISION", 409);
      }
      const trigger = await client.query<{ value_json: unknown }>(
        "SELECT value_json FROM settings WHERE key = 'draft_trigger' FOR SHARE",
      );
      const refundEffect = preIssueRefund(current.gross_amount, current.refunds);
      const historicalInvoiceAmount = importedInvoice
        ? attributedInvoiceAmount(importedInvoice, current.provider, current.display_number)
        : null;
      const historicalInvoiceDate = importedInvoice?.documentDate;
      const completedHistoricalRefunds = current.refunds.filter(
        (refund) => refund.status === "COMPLETED",
      );
      const preIssueHistoricalRefunds = completedHistoricalRefunds.filter(
        (refund) => refund.completed_date! < historicalInvoiceDate!,
      );
      const historicalRefundsNeedReview = current.refunds.some(
        (refund) =>
          refund.status === "AMBIGUOUS" ||
          (refund.status === "COMPLETED" &&
            (refund.amount === null ||
              !refund.completed_date ||
              refund.completed_date === historicalInvoiceDate)),
      );
      const expectedHistoricalInvoiceTotal =
        current.gross_amount -
        preIssueHistoricalRefunds.reduce((sum, refund) => sum + refund.amount!, 0);
      if (
        parsed.data.outcome === "ALREADY_INVOICED" &&
        (historicalRefundsNeedReview ||
          expectedHistoricalInvoiceTotal < 0 ||
          historicalInvoiceAmount !== expectedHistoricalInvoiceTotal)
      ) {
        throw new AppError("ORDER_HISTORY_INVOICE_INVALID", 422);
      }
      const nextStatus =
        parsed.data.outcome === "ALREADY_INVOICED"
          ? "INVOICED"
          : refundEffect.state === "TOTAL"
            ? "REFUNDED_BEFORE_ISSUE"
            : triggerStatus(
                {
                  cancelledAt: current.cancelled_at,
                  paymentStatus: current.payment_status,
                  fulfillmentStatus: current.fulfillment_status,
                  historical: false,
                },
                draftTriggerSchema.parse(trigger.rows[0]?.value_json ?? "PAID"),
              );
      let invoiceDocumentId: string | null = null;
      if (parsed.data.outcome === "ALREADY_INVOICED") {
        await client.query("SELECT pg_advisory_xact_lock(hashtext('fiscal-profile'))");
        const activeProfile = await client.query<{ version: number; profile_json: unknown }>(
          "SELECT version, profile_json FROM fiscal_profiles WHERE status IN ('MOCK', 'AUDITED')",
        );
        const profile = fiscalProfileSchema.safeParse(activeProfile.rows[0]?.profile_json);
        if (
          !profile.success ||
          !importedInvoice ||
          !archivedInvoice ||
          !invoicePath ||
          !hasOrderReference(
            importedInvoice.references,
            current.provider,
            current.display_number,
          ) ||
          (current.tax_identifiers.length > 0
            ? !current.tax_identifiers.some((identifier) => importedTaxIdentifiers.has(identifier))
            : !matchesRecipientWithoutTaxId(
                current.customer_snapshot,
                importedInvoice.input.recipient,
              )) ||
          JSON.stringify(fiscalContract(profile.data)) !==
            JSON.stringify(fiscalContract(importedInvoice.profile))
        ) {
          throw new AppError("ORDER_HISTORY_INVOICE_INVALID", 422);
        }
        const existing = await client.query<{
          id: string;
          origin: string;
          xml_sha256: string;
        }>(
          `SELECT id, origin, xml_sha256 FROM documents
         WHERE series = 'FPR' AND fiscal_year = $1 AND fiscal_number = $2
         FOR UPDATE`,
          [importedInvoice.year, importedInvoice.number],
        );
        const previous = existing.rows[0];
        if (
          previous &&
          (previous.origin !== "ARUBA_HISTORY" || previous.xml_sha256 !== archivedInvoice.sha256)
        ) {
          throw new AppError("ORDER_HISTORY_INVOICE_INVALID", 422);
        }
        invoiceDocumentId = previous?.id ?? null;
        if (!invoiceDocumentId) {
          const billingCase = await client.query<{ id: string }>(
            `INSERT INTO billing_cases
            (customer_id, local_order_date, currency, status, customer_snapshot_json,
             fiscal_profile_version)
           VALUES ($1, $2, 'EUR', 'CLOSED', $3, $4) RETURNING id`,
            [
              current.customer_id,
              importedInvoice.documentDate,
              JSON.stringify(current.customer_snapshot),
              activeProfile.rows[0]!.version,
            ],
          );
          const storage = await client.query<{ id: string }>(
            `INSERT INTO storage_objects
            (kind, relative_path, sha256, size_bytes, content_type)
           VALUES ('INVOICE_XML', $1, $2, $3, 'application/xml')
           ON CONFLICT (relative_path) DO UPDATE SET relative_path = EXCLUDED.relative_path
           RETURNING id`,
            [invoicePath, archivedInvoice.sha256, archivedInvoice.sizeBytes],
          );
          const snapshot = {
            generatorVersion: 2,
            ...importedInvoice.input,
            sourceTotal: importedInvoice.totalAmount,
            total: importedInvoice.totalAmount,
            difference: 0,
            differenceReason: null,
          };
          const document = await client.query<{ id: string }>(
            `INSERT INTO documents
            (billing_case_id, kind, status, document_type, series, fiscal_year,
             fiscal_number, document_date, fiscal_profile_version, currency, total_amount,
             source_total_amount, difference_amount, projection_sha256, approved_at,
             xml_sha256, immutable_snapshot_json, fiscal_profile_snapshot_json,
             storage_object_id, payment_status, payment_method, recipient_snapshot_json, origin)
           VALUES ($1, 'INVOICE', 'APPROVED', 'TD01', 'FPR', $2, $3, $4, $5, 'EUR',
             $6, $6, 0, $7, now(), $7, $8, $9, $10, 'PAID', $11, $12, 'ARUBA_HISTORY')
           RETURNING id`,
            [
              billingCase.rows[0]!.id,
              importedInvoice.year,
              importedInvoice.number,
              importedInvoice.documentDate,
              activeProfile.rows[0]!.version,
              importedInvoice.totalAmount,
              archivedInvoice.sha256,
              JSON.stringify(snapshot),
              JSON.stringify(importedInvoice.profile),
              storage.rows[0]!.id,
              importedInvoice.input.paymentMethod,
              JSON.stringify(importedInvoice.input.recipient),
            ],
          );
          invoiceDocumentId = document.rows[0]!.id;
        }
        await client.query(
          `INSERT INTO document_orders (document_id, document_kind, order_id, amount)
         VALUES ($1, 'INVOICE', $2, $3)`,
          [invoiceDocumentId, id, historicalInvoiceAmount],
        );
      }
      await client.query(
        `UPDATE orders SET trigger_status = $2, historical_reconciliation_outcome = $3,
         historical_reconciliation_reference = $4,
         historical_reconciled_at = coalesce(historical_reconciled_at, now())
       WHERE id = $1`,
        [id, nextStatus, parsed.data.outcome, parsed.data.reference],
      );
      if (parsed.data.outcome === "ALREADY_INVOICED") {
        await client.query(
          `UPDATE refunds
           SET applied_before_issue = (id::text = ANY($2::text[])), updated_at = now()
           WHERE order_id = $1 AND status = 'COMPLETED'`,
          [id, preIssueHistoricalRefunds.map((refund) => refund.id)],
        );
        await client.query(
          `INSERT INTO jobs (type, payload_json)
         SELECT 'process_refund', jsonb_build_object('refundId', refunds.id::text)
         FROM refunds WHERE refunds.order_id = $1
           AND refunds.status IN ('COMPLETED', 'AMBIGUOUS')
           AND NOT refunds.applied_before_issue AND refunds.credit_document_id IS NULL
         ON CONFLICT DO NOTHING`,
          [id],
        );
      }
      await writeAudit(client, {
        actorType: actor.type ?? "ADMIN",
        actorId: String(actor.id),
        action: "ORDER_HISTORY_RECONCILED",
        eventClass: "CRITICAL",
        entityType: "ORDER",
        entityId: id,
        after: {
          outcome: parsed.data.outcome,
          reference: parsed.data.reference,
          invoiceDocumentId,
        },
        requestId: actor.requestId,
      });
      const caseId =
        nextStatus === "ELIGIBLE" || nextStatus === "REFUNDED_BEFORE_ISSUE"
          ? await groupOrder(
              client,
              {
                id: current.id,
                customerId: current.customer_id,
                customerSnapshot: current.customer_snapshot,
                localOrderDate: current.local_order_date,
                currency: current.currency,
                isolated: nextStatus === "REFUNDED_BEFORE_ISSUE",
              },
              actor,
            )
          : null;
      if (caseId && nextStatus === "REFUNDED_BEFORE_ISSUE") {
        await client.query("UPDATE orders SET trigger_status = $2 WHERE id = $1", [id, nextStatus]);
      }
      if (caseId && nextStatus === "ELIGIBLE" && refundEffect.state === "PARTIAL") {
        await reconcilePreIssueInvoiceAmount(client, id, caseId, refundEffect.billableAmount);
      }
      return { caseId, outcome: parsed.data.outcome, invoiceDocumentId };
    } catch (error) {
      await archivedInvoice?.cleanupIfUnreferenced();
      throw error;
    }
  });
}

export async function forcePrepareOrder(id: string, actor: Actor) {
  if (!isDatabaseId(id)) return null;
  return withTransaction(async (client) => {
    await serializeOrderMutations(client);
    const identity = await client.query<{
      provider: string;
      external_account_id: string;
      external_order_id: string;
    }>("SELECT provider, external_account_id, external_order_id FROM orders WHERE id = $1", [id]);
    if (!identity.rows[0]) return null;
    const source = identity.rows[0];
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `order:${source.provider}:${source.external_account_id}:${source.external_order_id}`,
    ]);
    const order = await client.query<{
      id: string;
      customer_id: string;
      billing_case_id: string | null;
      customer_snapshot: Record<string, unknown>;
      local_order_date: string;
      currency: string;
      cancelled_at: string | null;
      payment_status: OrderInput["paymentStatus"];
      historical: boolean;
      historical_reconciliation_outcome: "ALREADY_INVOICED" | "NOT_INVOICED" | null;
    }>(
      `SELECT orders.id, orders.customer_id, orders.billing_case_id,
              orders.normalized_snapshot_json -> 'customerSnapshot' AS customer_snapshot,
              orders.local_order_date::text,
              orders.currency, orders.cancelled_at, orders.payment_status,
              orders.historical_reconciliation_outcome,
              coalesce((orders.normalized_snapshot_json ->> 'historical')::boolean, false)
                AS historical
       FROM orders
       WHERE orders.id = $1
       FOR UPDATE OF orders`,
      [id],
    );
    const current = order.rows[0];
    if (!current) return null;
    if (current.billing_case_id) return current.billing_case_id;
    if (
      (current.historical && current.historical_reconciliation_outcome !== "NOT_INVOICED") ||
      current.cancelled_at ||
      current.payment_status === "REFUNDED"
    ) {
      throw new AppError("ORDER_NOT_PREPARABLE", 409);
    }
    return groupOrder(
      client,
      {
        id: current.id,
        customerId: current.customer_id,
        customerSnapshot: current.customer_snapshot,
        localOrderDate: current.local_order_date,
        currency: current.currency,
      },
      actor,
      true,
    );
  });
}
