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
  await page.evaluate(() => {
    const original = document.startViewTransition?.bind(document);
    const testWindow = window as Window & { __navigationViewTransitions?: number };
    testWindow.__navigationViewTransitions = 0;
    if (original) {
      document.startViewTransition = (callback) => {
        testWindow.__navigationViewTransitions = (testWindow.__navigationViewTransitions ?? 0) + 1;
        return original(callback);
      };
    }
  });

  const trigger = page.getByRole("button", { name: "Apri il menu di navigazione" });
  const menu = page.getByRole("dialog", { name: "Navigazione principale" });
  await trigger.click();
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("link")).toHaveCount(7);
  await expect(menu.getByRole("link", { name: "Controlli", exact: true })).toBeVisible();
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
  await page.route(
    "**/_.data*",
    async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 250));
      await route.continue();
    },
    { times: 1 },
  );
  const dashboardLink = page.getByRole("link", { name: "Dashboard", exact: true }).first();
  await dashboardLink.click();
  await expect(dashboardLink).toHaveAttribute("aria-busy", "true");
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("heading", { name: "Dashboard", exact: true })).toBeVisible();
  expect(
    await page.evaluate(
      () =>
        (window as Window & { __navigationViewTransitions?: number }).__navigationViewTransitions,
    ),
  ).toBe(0);

  const routeContent = page.locator(".route-content");
  await expect(routeContent).toBeVisible();
  await expect
    .poll(() =>
      routeContent.evaluate((element) =>
        getComputedStyle(element)
          .animationDuration.split(",")
          .some((duration) => Number.parseFloat(duration) > 0),
      ),
    )
    .toBe(true);

  const searchTrigger = page.getByRole("button", { name: "Apri la ricerca globale" });
  const searchPanel = page.getByRole("dialog", { name: "Ricerca globale" });
  await searchTrigger.click();
  await expect(searchPanel).toHaveAttribute("data-state", "open");
  await expect
    .poll(() =>
      searchPanel.evaluate((element) =>
        getComputedStyle(element)
          .animationDuration.split(",")
          .some((duration) => Number.parseFloat(duration) > 0),
      ),
    )
    .toBe(true);

  await page.keyboard.press("Escape");
  await expect(searchPanel).toHaveAttribute("data-state", "closing");
  await expect(searchPanel).not.toBeVisible();
  await expect(searchTrigger).toBeFocused();

  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.getByRole("link", { name: "Attività", exact: true }).first().click();
  await expect(page).toHaveURL(/\/attivita$/);
  await expect(page.locator(".route-content")).toHaveCSS("animation-name", "none");
  await searchTrigger.click();
  await expect(searchPanel).toBeVisible();
  await expect
    .poll(() => searchPanel.evaluate((element) => getComputedStyle(element).animationName))
    .toBe("none");
  await page.keyboard.press("Escape");
  await expect(searchPanel).not.toBeVisible();
});
