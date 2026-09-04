import assert from "node:assert/strict";
import test from "node:test";

import { arubaReadbackFingerprint, arubaReadbackJobPayloadSchema } from "./aruba-api-readback.ts";

test("il payload di readback distingue invio, lookup puntuale e checkpoint avanzato", () => {
  assert.equal(
    arubaReadbackJobPayloadSchema.safeParse({
      readbackKind: "submission",
      submissionId: "42",
    }).success,
    true,
  );
  assert.equal(
    arubaReadbackJobPayloadSchema.safeParse({
      readbackKind: "targeted",
      lookupType: "idSdi",
      lookupValue: "x".repeat(201),
    }).success,
    false,
  );
  assert.equal(
    arubaReadbackJobPayloadSchema.safeParse({
      readbackKind: "advanced",
      creationStart: "2026-09-01T00:00:00.000Z",
      creationEnd: "2026-09-03T00:00:00.000Z",
      page: 2,
      groupIds: ["group-1", "group-2"],
      groupIndex: 1,
    }).success,
    true,
  );
});

test("la ricerca avanzata rifiuta finestre oltre 48 ore e checkpoint incoerenti", () => {
  assert.equal(
    arubaReadbackJobPayloadSchema.safeParse({
      readbackKind: "advanced",
      creationStart: "2026-09-01T00:00:00.000Z",
      creationEnd: "2026-09-03T00:00:00.001Z",
    }).success,
    false,
  );
  assert.equal(
    arubaReadbackJobPayloadSchema.safeParse({
      readbackKind: "advanced",
      creationStart: "2026-09-01T00:00:00.000Z",
      creationEnd: "2026-09-01T01:00:00.000Z",
      groupIds: ["group-1"],
      groupIndex: 2,
    }).success,
    false,
  );
});

test("il fingerprint puntuale separa filename e ID SdI senza esporre il valore", () => {
  const filename = arubaReadbackFingerprint({ lookupType: "filename", lookupValue: "a.xml" });
  const idSdi = arubaReadbackFingerprint({ lookupType: "idSdi", lookupValue: "a.xml" });
  assert.match(filename, /^[0-9a-f]{64}$/);
  assert.notEqual(filename, idSdi);
  assert.equal(filename.includes("a.xml"), false);
});
