import { expect, test } from "@playwright/test";
import path from "node:path";

import {
  assertAccount,
  validateVisibleDocuments,
  waitForUploadAuthorization,
} from "../../scripts/aruba-helper.ts";

const xml = "tests/fixtures/fatturapa/accepted-invoice.anonymized.xml";

test("la pagina Aruba sintetica copre autenticazione, validazione e rimozione", async ({
  page,
}) => {
  await page.goto("/aruba-sintetica?scenario=login");
  await expect(page.locator('[data-aruba-state="login-required"]')).toContainText(
    "Completa manualmente password, OTP o CAPTCHA",
  );
  await page.getByRole("button", { name: "Autenticazione completata" }).click();
  await expect(page.locator('[data-aruba-state="upload-ready"]')).toBeVisible();

  await page.goto("/aruba-sintetica?scenario=valid");
  await expect(assertAccount(page, "synthetic-aruba-account")).resolves.toBeUndefined();
  await page.locator("[data-aruba-account]").evaluate((element) => {
    element.setAttribute("hidden", "");
  });
  await expect(assertAccount(page, "synthetic-aruba-account")).rejects.toThrow("DOM_UNRECOGNIZED");
  await page.reload();
  await page.getByLabel("Seleziona documenti").setInputFiles(xml);
  await expect(page.getByRole("cell", { name: "Documento valido" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Invia" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Salva in bozze" })).toBeDisabled();
  const visibleRow = page.locator("tbody tr").first();
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
  await page.getByLabel("Seleziona documenti").setInputFiles(xml);
  await expect(page.getByRole("cell", { name: "Dettagli errori" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Invia" })).toBeDisabled();
  await page.getByRole("button", { name: "Rimuovi" }).click();
  await expect(page.getByRole("row")).toHaveCount(0);
});

test("l'helper attende l'autorizzazione SMS dopo la selezione degli XML", async ({ page }) => {
  await page.goto("/aruba-sintetica?scenario=sms");
  await page.getByLabel("Seleziona documenti").setInputFiles(xml);
  const authorization = waitForUploadAuthorization(page, "accepted-invoice.anonymized.xml");
  await expect(page.getByRole("dialog")).toContainText(
    "Vuoi disattivare la protezione OTP su Carica Fatture?",
  );
  await page.getByRole("button", { name: "Prosegui" }).click();
  await page.getByLabel("Inserisci il codice ricevuto per SMS").fill("123456");
  await page.getByRole("button", { name: "Verifica" }).click();
  await expect(authorization).resolves.toBeUndefined();
  await expect(page.getByRole("cell", { name: "Documento valido" })).toBeVisible();
});

test("la pagina sintetica espone gli stati inattesi e incerti", async ({ page }) => {
  await page.goto("/aruba-sintetica?scenario=unexpected");
  await expect(page.locator('[data-aruba-state="unexpected"]')).toBeVisible();

  await page.goto("/aruba-sintetica?scenario=uncertain");
  await page.getByLabel("Seleziona documenti").setInputFiles(xml);
  await page.getByRole("button", { name: "Invia" }).click();
  await expect(page.getByText("Stato non disponibile", { exact: true })).toBeVisible();

  await page.goto("/aruba-sintetica?scenario=foreign");
  await page.getByLabel("Seleziona documenti").setInputFiles(xml);
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
