import { expect, test } from "@playwright/test";

import { expectViewportFits } from "./support.ts";

test("movimento e navigazione primaria restano fluidi, leggibili e affidabili", async ({
  page,
}) => {
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

  const clientDataRequests: string[] = [];
  await page.route("**/_.data*", async (route) => {
    clientDataRequests.push(route.request().url());
    await route.abort();
  });

  async function clickWithDocumentNavigation(pathname: string, click: () => Promise<void>) {
    const [request] = await Promise.all([
      page.waitForRequest((candidate) => {
        const url = new URL(candidate.url());
        return candidate.isNavigationRequest() && url.pathname === pathname;
      }),
      click(),
    ]);
    expect(request.resourceType()).toBe("document");
  }

  await trigger.click();
  await clickWithDocumentNavigation("/", () =>
    menu.getByRole("link", { name: "Dashboard", exact: true }).click(),
  );
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("heading", { name: "Dashboard", exact: true })).toBeVisible();

  await clickWithDocumentNavigation("/controlli", () =>
    page.getByRole("link", { name: "Apri controlli", exact: true }).click(),
  );
  await expect(page).toHaveURL(/\/controlli$/);
  await expect(page.getByRole("heading", { name: "Controlli", exact: true })).toBeVisible();

  await trigger.click();
  await clickWithDocumentNavigation("/", () =>
    menu.getByRole("link", { name: "Dashboard", exact: true }).click(),
  );
  const approvalCandidatesRequested = Promise.withResolvers<void>();
  const approvalCandidatesResponse = Promise.withResolvers<void>();
  await page.route("**/ordini/candidati-approvazione", async (route) => {
    approvalCandidatesRequested.resolve();
    await approvalCandidatesResponse.promise;
    await route.fulfill({
      json: {
        approvalCandidates: [],
        arubaMode: "DOCUMENT_ONLY",
        arubaConfiguredMode: "DOCUMENT_ONLY",
        arubaDowngradeRequired: false,
      },
    });
  });
  await clickWithDocumentNavigation("/ordini", () =>
    page.getByRole("link", { name: "Apri preparazioni", exact: true }).first().click(),
  );
  await expect(page).toHaveURL(/\/ordini\?vista=fatturare$/);
  await expect(page.getByRole("heading", { name: "Ordini", exact: true })).toBeVisible();
  await approvalCandidatesRequested.promise;
  approvalCandidatesResponse.resolve();
  expect(clientDataRequests).toEqual([]);

  await trigger.click();
  await clickWithDocumentNavigation("/", () =>
    menu.getByRole("link", { name: "Dashboard", exact: true }).click(),
  );

  await page.setViewportSize({ width: 1280, height: 720 });

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
