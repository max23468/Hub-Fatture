import { expect, test } from "@playwright/test";
import path from "node:path";

import {
  assertAccount,
  finalSendButton,
  removeUploads,
  validateVisibleDocuments,
  waitForUploadedDocument,
} from "../../scripts/aruba-helper.ts";

const xml = "tests/fixtures/fatturapa/accepted-invoice.anonymized.xml";

async function expectViewportFits(page: import("@playwright/test").Page) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    ),
  ).toBe(true);
}

test("la pagina Aruba sintetica copre autenticazione, validazione e rimozione", async ({
  page,
}) => {
  await page.goto("/aruba-sintetica?scenario=login");
  await page.setViewportSize({ width: 320, height: 780 });
  await expect(page.locator('[data-aruba-state="login-required"]')).toContainText(
    "Completa manualmente password, OTP o CAPTCHA",
  );
  await expectViewportFits(page);
  await page.getByRole("button", { name: "Autenticazione completata" }).click();
  await expect(page.locator('[data-aruba-state="upload-ready"]')).toBeVisible();

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/aruba-sintetica?scenario=valid");
  await expect(assertAccount(page, "synthetic-aruba-account")).resolves.toBeUndefined();
  await page.locator("[data-aruba-account]").evaluate((element) => {
    element.setAttribute("hidden", "");
  });
  await page.evaluate(() => {
    const accountButton = document.createElement("button");
    accountButton.textContent = "synthetic-aruba-account";
    document.body.append(accountButton);
  });
  await expect(assertAccount(page, "synthetic-aruba-account")).resolves.toBeUndefined();
  await page
    .getByRole("button", { name: "synthetic-aruba-account", exact: true })
    .evaluate((element) => {
      element.textContent = "synthetic-aruba-account secondario";
    });
  await expect(assertAccount(page, "synthetic-aruba-account")).rejects.toThrow("DOM_UNRECOGNIZED");
  await page.reload();
  await page.getByLabel("SELEZIONA DOCUMENTI").setInputFiles(xml);
  await expect(
    waitForUploadedDocument(page, "accepted-invoice.anonymized.xml"),
  ).resolves.toBeUndefined();
  await expect(page.getByRole("cell", { name: "Documento valido" })).toBeVisible();
  for (const width of [1024, 600, 320]) {
    await page.setViewportSize({ width, height: width === 320 ? 780 : 800 });
    await expectViewportFits(page);
  }
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(page.getByRole("button", { name: "INVIA TUTTE", exact: true })).toBeEnabled();
  await expect(finalSendButton(page, 1)).resolves.toBeTruthy();
  await expect(
    page.getByRole("button", { name: "SALVA IN BOZZE", exact: true }).first(),
  ).toBeDisabled();
  const visibleRow = page.locator("tbody tr").first();
  await visibleRow.evaluate((element) => {
    element.removeAttribute("data-fiscal-number");
    element.removeAttribute("data-document-date");
    element.removeAttribute("data-total-cents");
  });
  await visibleRow.evaluate((element) => {
    const hiddenClone = element.cloneNode(true) as HTMLElement;
    hiddenClone.hidden = true;
    element.parentElement!.append(hiddenClone);
  });
  const validDocument = {
    id: "1",
    filename: path.basename(xml),
    fiscalNumber: "FPR 0001/26",
    documentDate: "2026-08-10",
    totalAmount: 12345,
  };
  await expect(validateVisibleDocuments(page, { documents: [validDocument] })).resolves.toEqual([
    { id: "1", status: "VALID" },
  ]);
  await visibleRow.evaluate((element) => {
    element.parentElement!.append(element.cloneNode(true));
  });
  await expect(validateVisibleDocuments(page, { documents: [validDocument] })).rejects.toThrow(
    "DOM_UNRECOGNIZED",
  );
  await page
    .locator("tbody tr")
    .last()
    .evaluate((element) => element.remove());
  await expect(
    validateVisibleDocuments(page, {
      documents: [
        {
          id: "1",
          filename: path.basename(xml),
          fiscalNumber: "FPR 9999/99",
          documentDate: "2099-12-31",
          totalAmount: 1,
        },
      ],
    }),
  ).rejects.toThrow("DOM_UNRECOGNIZED");

  await page.goto("/aruba-sintetica?scenario=invalid");
  await page.getByLabel("SELEZIONA DOCUMENTI").setInputFiles(xml);
  await expect(page.getByRole("cell", { name: "Dettagli errori" })).toBeVisible();
  await expect(page.getByRole("button", { name: "INVIA TUTTE", exact: true })).toBeDisabled();
  await removeUploads(page, {
    documents: [{ filename: "accepted-invoice.anonymized.xml" }],
  });
  await expect(page.getByRole("row")).toHaveCount(0);
});

test("l'helper gestisce in sicurezza una challenge post-upload inattesa", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 780 });
  await page.goto("/aruba-sintetica?scenario=security-challenge");
  await page.getByLabel("SELEZIONA DOCUMENTI").setInputFiles(xml);
  let heartbeats = 0;
  const upload = waitForUploadedDocument(page, "accepted-invoice.anonymized.xml", async () => {
    heartbeats += 1;
  });
  await expect(page.getByRole("dialog")).toContainText(
    "Vuoi disattivare la protezione OTP su Carica Fatture?",
  );
  await expectViewportFits(page);
  await page.getByRole("button", { name: "Prosegui" }).click();
  await page.getByLabel("Inserisci il codice ricevuto per SMS").fill("123456");
  await page.getByRole("button", { name: "Verifica" }).click();
  await expect(upload).resolves.toBeUndefined();
  expect(heartbeats).toBe(1);
  await expect(page.getByRole("cell", { name: "Documento valido" })).toBeVisible();
});

test("la pagina sintetica espone gli stati inattesi e incerti", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 780 });
  await page.goto("/aruba-sintetica?scenario=unexpected");
  await expect(page.locator('[data-aruba-state="unexpected"]')).toBeVisible();
  await expectViewportFits(page);

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/aruba-sintetica?scenario=uncertain");
  await page.getByLabel("SELEZIONA DOCUMENTI").setInputFiles(xml);
  await page.getByRole("button", { name: "INVIA TUTTE", exact: true }).click();
  await expect(page.getByText("Stato non disponibile", { exact: true })).toBeVisible();

  await page.goto("/aruba-sintetica?scenario=foreign");
  await page.getByLabel("SELEZIONA DOCUMENTI").setInputFiles(xml);
  await expect(
    validateVisibleDocuments(page, {
      documents: [
        {
          id: "1",
          filename: path.basename(xml),
          fiscalNumber: "FPR 9999/99",
          documentDate: "2099-12-31",
          totalAmount: 1,
        },
      ],
    }),
  ).rejects.toThrow("DOM_UNRECOGNIZED");
});
