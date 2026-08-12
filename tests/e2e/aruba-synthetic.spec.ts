import { expect, test } from "@playwright/test";
import path from "node:path";

import {
  assertAccount,
  validateVisibleDocuments,
  waitForUploadAuthorization,
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
  await expect(assertAccount(page, "synthetic-aruba-account")).rejects.toThrow("DOM_UNRECOGNIZED");
  await page.reload();
  await page.getByLabel("Seleziona documenti").setInputFiles(xml);
  await expect(page.getByRole("cell", { name: "Documento valido" })).toBeVisible();
  for (const width of [1024, 600, 320]) {
    await page.setViewportSize({ width, height: width === 320 ? 780 : 800 });
    await expectViewportFits(page);
  }
  await page.setViewportSize({ width: 1280, height: 800 });
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
  await page.setViewportSize({ width: 320, height: 780 });
  await page.goto("/aruba-sintetica?scenario=sms");
  await page.getByLabel("Seleziona documenti").setInputFiles(xml);
  let heartbeats = 0;
  const authorization = waitForUploadAuthorization(
    page,
    "accepted-invoice.anonymized.xml",
    async () => {
      heartbeats += 1;
    },
  );
  await expect(page.getByRole("dialog")).toContainText(
    "Vuoi disattivare la protezione OTP su Carica Fatture?",
  );
  await expectViewportFits(page);
  await page.getByRole("button", { name: "Prosegui" }).click();
  await page.getByLabel("Inserisci il codice ricevuto per SMS").fill("123456");
  await page.getByRole("button", { name: "Verifica" }).click();
  await expect(authorization).resolves.toBeUndefined();
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
