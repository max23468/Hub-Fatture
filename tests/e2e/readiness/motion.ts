import { expect, test } from "@playwright/test";

import { expectViewportFits } from "./support.ts";

test("il sistema di movimento resta fluido, leggibile e riducibile", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 780 });
  await page.goto("/setup");
  const setupHeading = page.getByRole("heading", { name: "Configura gli accessi" });
  if (await setupHeading.isVisible()) {
    await page.getByLabel("Codice di configurazione").fill("synthetic-bootstrap-token-for-tests");
    await page.getByLabel("Password per Massimo").fill("password-massimo");
    await page.getByLabel("Password per Codex").fill("password-codex");
    await page.getByRole("button", { name: "Crea gli account" }).click();
  }

  await page.goto("/login");
  await page.getByLabel("Nome utente").fill("Massimo");
  await page.getByLabel("Password").fill("password-massimo");
  await page.getByRole("button", { name: "Accedi" }).click();

  const trigger = page.getByRole("button", { name: "Apri il menu di navigazione" });
  const menu = page.getByRole("dialog", { name: "Navigazione principale" });
  await trigger.click();
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("link")).toHaveCount(6);
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

  await page.setViewportSize({ width: 1280, height: 720 });
  const routeContent = page.locator(".route-content");
  await expect(routeContent).toBeVisible();
  expect(
    await routeContent.evaluate((element) =>
      Number.parseFloat(getComputedStyle(element).animationDuration),
    ),
  ).toBeGreaterThan(0);

  const searchTrigger = page.getByRole("button", { name: "Apri la ricerca globale" });
  const searchPanel = page.getByRole("dialog", { name: "Ricerca globale" });
  await searchTrigger.click();
  await expect(searchPanel).toHaveAttribute("data-state", "open");
  expect(
    await searchPanel.evaluate((element) =>
      Number.parseFloat(getComputedStyle(element).animationDuration),
    ),
  ).toBeGreaterThan(0);

  await page.keyboard.press("Escape");
  await expect(searchPanel).toHaveAttribute("data-state", "closing");
  await expect(searchPanel).not.toBeVisible();
  await expect(searchTrigger).toBeFocused();

  await page.emulateMedia({ reducedMotion: "reduce" });
  await searchTrigger.click();
  await expect(searchPanel).toBeVisible();
  await expect
    .poll(() => searchPanel.evaluate((element) => getComputedStyle(element).animationName))
    .toBe("none");
  await page.keyboard.press("Escape");
  await expect(searchPanel).not.toBeVisible();
});
