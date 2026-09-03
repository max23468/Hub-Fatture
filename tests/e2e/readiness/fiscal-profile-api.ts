import { expect, type Page } from "@playwright/test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import pg from "pg";

import { appBaseUrl, databaseUrl } from "./support.ts";

export async function verifyFiscalProfileApi(page: Page) {
  const csrfCookie = (await page.context().cookies()).find(({ name }) => name === "csrf");
  assert.ok(csrfCookie);
  const acceptedInvoiceXml = await readFile(
    "tests/fixtures/fatturapa/accepted-invoice.anonymized.xml",
  );
  const acceptedCreditNoteXml = await readFile(
    "tests/fixtures/fatturapa/accepted-credit-note.anonymized.xml",
  );
  const fiscalProfileApi = page.context().request;
  const currentProfile = await fiscalProfileApi.get("/api/profilo-fiscale");
  expect(currentProfile.status()).toBe(200);
  expect(await currentProfile.json()).toMatchObject({
    profile: { version: 1, status: "MOCK", taxRegime: "RF14", taxNature: "N5" },
  });

  const missingConfirmation = await fiscalProfileApi.post("/api/profilo-fiscale", {
    headers: { origin: appBaseUrl },
    multipart: {
      csrf: csrfCookie.value,
      expectedVersion: "1",
      profileXml: {
        name: "accepted-invoice.xml",
        mimeType: "application/xml",
        buffer: acceptedInvoiceXml,
      },
    },
  });
  expect(missingConfirmation.status()).toBe(422);
  expect(await missingConfirmation.json()).toMatchObject({
    code: "FISCAL_PROFILE_CONFIRMATION_REQUIRED",
  });

  const activatedProfile = await fiscalProfileApi.post("/api/profilo-fiscale", {
    headers: { origin: appBaseUrl },
    multipart: {
      csrf: csrfCookie.value,
      confirmation: "DOCUMENTI_SDI_ACCETTATI",
      expectedVersion: "1",
      profileXml: {
        name: "accepted-invoice.xml",
        mimeType: "application/xml",
        buffer: acceptedInvoiceXml,
      },
      latestDocumentXml: {
        name: "accepted-credit-note.xml",
        mimeType: "application/xml",
        buffer: acceptedCreditNoteXml,
      },
    },
  });
  expect(activatedProfile.status()).toBe(201);
  expect(await activatedProfile.json()).toMatchObject({
    profile: { version: 2, status: "AUDITED", taxRegime: "RF14", taxNature: "N5" },
    created: true,
  });

  const repeatedActivation = await fiscalProfileApi.post("/api/profilo-fiscale", {
    headers: { origin: appBaseUrl },
    multipart: {
      csrf: csrfCookie.value,
      confirmation: "DOCUMENTI_SDI_ACCETTATI",
      expectedVersion: "1",
      profileXml: {
        name: "accepted-invoice.xml",
        mimeType: "application/xml",
        buffer: acceptedInvoiceXml,
      },
      latestDocumentXml: {
        name: "accepted-credit-note.xml",
        mimeType: "application/xml",
        buffer: acceptedCreditNoteXml,
      },
    },
  });
  expect(repeatedActivation.status()).toBe(200);
  expect(await repeatedActivation.json()).toMatchObject({
    profile: { version: 2, status: "AUDITED" },
    created: false,
  });

  const cleanup = new pg.Client({ connectionString: databaseUrl });
  await cleanup.connect();
  const auditCount = await cleanup.query<{ count: string }>(
    "SELECT count(*) AS count FROM audit_events WHERE action = 'FISCAL_PROFILE_ACTIVATED'",
  );
  expect(Number(auditCount.rows[0]!.count)).toBe(1);
  await cleanup.query("BEGIN");
  try {
    await cleanup.query(
      `DELETE FROM audit_events
       WHERE action = 'FISCAL_PROFILE_ACTIVATED'
         AND metadata_json ->> 'fiscalProfileVersion' = '2'`,
    );
    await cleanup.query("UPDATE fiscal_profiles SET status = 'RETIRED' WHERE version = 2");
    await cleanup.query("UPDATE fiscal_profiles SET status = 'MOCK' WHERE version = 1");
    await cleanup.query("DELETE FROM fiscal_profiles WHERE version = 2");
    await cleanup.query("COMMIT");
  } catch (error) {
    await cleanup.query("ROLLBACK");
    throw error;
  } finally {
    await cleanup.end();
  }
}
