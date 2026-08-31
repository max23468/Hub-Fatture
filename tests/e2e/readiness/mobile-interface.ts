import { expect, test } from "@playwright/test";

import { expectViewportFits } from "./support.ts";

test("il menu mobile anima e rende raggiungibili tutte le sezioni", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 780 });
  await page.goto("/setup");
  const setupHeading = page.getByRole("heading", {
    name: "Configura gli accessi",
  });
  if (await setupHeading.isVisible()) {
    await page.getByLabel("Codice di configurazione").fill("synthetic-bootstrap-token-for-tests");
    await page.getByLabel("Password per Massimo").fill("password-massimo");
    await page.getByLabel("Password per Codex").fill("password-codex");
    await page.getByRole("button", { name: "Crea gli account" }).click();
    await expect(page).toHaveURL(/\/login$/);
  }

  await page.goto("/login");
  await page.getByLabel("Nome utente").fill("Massimo");
  await page.getByLabel("Password").fill("password-massimo");
  await page.getByRole("button", { name: "Accedi" }).click();
  await expect(page).toHaveURL(/\/$/);

  const controlsCard = page.locator(".work-item").filter({
    hasText: "Controlli da risolvere",
  });
  await controlsCard.locator(".work-item__value").evaluate((value) => {
    value.textContent = "144";
  });
  const severityLines = controlsCard.locator(".work-item__details > span");
  await expect(severityLines).toHaveText(["0 bloccanti", "0 importanti", "0 ordinari"]);
  expect(
    await controlsCard.evaluate((card) => {
      const value = card.querySelector(".work-item__value")!.getBoundingClientRect();
      const copy = card.querySelector(".work-item__copy")!.getBoundingClientRect();
      const action = card.querySelector("a")!.getBoundingClientRect();
      const severityTops = [...card.querySelectorAll(".work-item__details > span")].map((detail) =>
        Math.round(detail.getBoundingClientRect().top),
      );
      const separatorsHidden = [
        ...card.querySelectorAll(".work-item__details > span:not(:last-child)"),
      ].every((detail) => getComputedStyle(detail, "::after").content === "none");
      return {
        valueBeforeCopy: value.right <= copy.left,
        actionBelowSummary: action.top >= Math.max(value.bottom, copy.bottom),
        fitsCard: card.scrollWidth <= card.clientWidth,
        severityRows: new Set(severityTops).size,
        separatorsHidden,
      };
    }),
  ).toEqual({
    valueBeforeCopy: true,
    actionBelowSummary: true,
    fitsCard: true,
    severityRows: 3,
    separatorsHidden: true,
  });

  const trigger = page.getByRole("button", {
    name: "Apri il menu di navigazione",
  });
  const menu = page.getByRole("dialog", { name: "Navigazione principale" });
  await trigger.click();
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("link")).toHaveCount(7);
  await expect(menu.getByRole("link", { name: "Dashboard", exact: true })).toHaveAttribute(
    "aria-current",
    "page",
  );
  expect(
    await menu.evaluate((element) =>
      getComputedStyle(element)
        .transitionDuration.split(",")
        .some((duration) => Number.parseFloat(duration) > 0),
    ),
  ).toBe(true);
  await expectViewportFits(page);

  await page.keyboard.press("Escape");
  await expect(menu).not.toBeVisible();
  await expect(trigger).toBeFocused();

  await trigger.click();
  await menu.getByRole("link", { name: "Attività", exact: true }).click();
  await expect(page).toHaveURL(/\/attivita$/);
  await expect(menu).not.toBeVisible();

  await trigger.click();
  await menu.getByRole("link", { name: "Controlli", exact: true }).click();
  await expect(page).toHaveURL(/\/controlli$/);
  const severitySummary = page.locator(".controls-severity-summary");
  await expect(severitySummary).toBeVisible();
  expect(
    await severitySummary.evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      return {
        fitsViewport: bounds.left >= 0 && bounds.right <= window.innerWidth,
        itemsFit: [...element.children].every((item) => item.scrollWidth <= item.clientWidth),
        labelsFit: [...element.querySelectorAll("dt")].every(
          (label) => label.scrollWidth <= label.clientWidth,
        ),
      };
    }),
  ).toEqual({ fitsViewport: true, itemsFit: true, labelsFit: true });
});
