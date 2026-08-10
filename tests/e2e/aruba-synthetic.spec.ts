import { expect, test } from "@playwright/test";
import path from "node:path";

import { validateVisibleDocuments } from "../../scripts/aruba-helper.ts";

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
  await page.getByLabel("Seleziona documenti").setInputFiles(xml);
  await expect(page.getByRole("cell", { name: "Documento valido" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Invia" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Salva in bozze" })).toBeDisabled();
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
