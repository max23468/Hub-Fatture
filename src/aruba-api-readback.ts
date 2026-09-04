import { createHash } from "node:crypto";

import { z } from "zod";

import { ARUBA_API_V2_CONTRACT } from "./integrations/aruba-api.server.ts";

const submissionPayloadSchema = z.strictObject({
  readbackKind: z.literal("submission"),
  submissionId: z.string().regex(/^\d+$/),
});

const targetedPayloadSchema = z
  .strictObject({
    readbackKind: z.literal("targeted"),
    lookupType: z.enum(["id", "filename", "idSdi"]),
    lookupValue: z.string().trim().min(1).max(255),
    requestedBy: z.string().optional(),
  })
  .superRefine((value, context) => {
    if (value.lookupType === "idSdi" && value.lookupValue.length > 200) {
      context.addIssue({ code: "too_big", maximum: 200, origin: "string", inclusive: true });
    }
  });

const advancedPayloadSchema = z
  .strictObject({
    readbackKind: z.literal("advanced"),
    creationStart: z.iso.datetime({ offset: true }),
    creationEnd: z.iso.datetime({ offset: true }),
    modifiedStart: z.iso.datetime({ offset: true }).optional(),
    modifiedEnd: z.iso.datetime({ offset: true }).optional(),
    receiverCountry: z
      .string()
      .regex(/^[A-Z]{2}$/)
      .optional(),
    receiverVatCode: z.string().max(64).optional(),
    receiverFiscalCode: z.string().max(64).optional(),
    documentType: z.enum(["TD01", "TD04"]).optional(),
    status: z.enum(ARUBA_API_V2_CONTRACT.documentedInvoiceStatuses).optional(),
    page: z.number().int().positive().default(1),
    groupIds: z.array(z.string().trim().min(1).max(255)).max(100).default([]),
    groupIndex: z.number().int().nonnegative().default(0),
    pageTerminal: z.boolean().default(false),
    pages: z.number().int().nonnegative().default(0),
    groups: z.number().int().nonnegative().default(0),
    documents: z.number().int().nonnegative().default(0),
  })
  .superRefine((value, context) => {
    const start = Date.parse(value.creationStart);
    const end = Date.parse(value.creationEnd);
    if (end <= start || end - start > 48 * 60 * 60_000) {
      context.addIssue({
        code: "custom",
        message: "La finestra di creazione deve essere di 48 ore al massimo.",
      });
    }
    if (Boolean(value.modifiedStart) !== Boolean(value.modifiedEnd)) {
      context.addIssue({
        code: "custom",
        message: "La finestra di modifica deve essere completa.",
      });
    }
    if (
      value.modifiedStart &&
      value.modifiedEnd &&
      Date.parse(value.modifiedEnd) <= Date.parse(value.modifiedStart)
    ) {
      context.addIssue({ code: "custom", message: "La finestra di modifica non è valida." });
    }
    if (value.groupIndex > value.groupIds.length) {
      context.addIssue({ code: "custom", message: "Il checkpoint dei gruppi non è valido." });
    }
  });

export const arubaReadbackJobPayloadSchema = z.discriminatedUnion("readbackKind", [
  submissionPayloadSchema,
  targetedPayloadSchema,
  advancedPayloadSchema,
]);

export type ArubaReadbackJobPayload = z.infer<typeof arubaReadbackJobPayloadSchema>;
type ArubaTargetedLookup = Pick<
  z.infer<typeof targetedPayloadSchema>,
  "lookupType" | "lookupValue"
>;

export function arubaReadbackFingerprint(value: ArubaTargetedLookup) {
  return createHash("sha256").update(`${value.lookupType}:${value.lookupValue}`).digest("hex");
}
