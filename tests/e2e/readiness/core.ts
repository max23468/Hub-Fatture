import { expect, test } from "@playwright/test";
import assert from "node:assert/strict";
import { readdir, rm } from "node:fs/promises";
import pg from "pg";

import { SESSION_TTL_SECONDS } from "../../../src/config.server.ts";
import { latestMigrationFileName } from "../../../src/migration-files.ts";
import { verifyHistoricalAndCreditNoteFlow } from "./historical-credit-note-flow.ts";
import { verifyUnconfiguredArubaApiUi } from "./aruba-settings-layout.ts";
import { verifyConfiguredArubaApiUi } from "./configured-aruba-api-ui.ts";
import { verifyFiscalProfileApi } from "./fiscal-profile-api.ts";
import { expectPreparedPendingOrder, expectUnpreparedPendingOrder } from "./pending-payments.ts";
import {
  databaseUrl,
  expectApprovalLabelsReadable,
  expectDesktopContentOutsideSidebar,
  expectPlainLanguage,
  expectPreparationOrderReference,
  expectViewportFits,
  expectVisibleFieldsetTitlesInside,
  refreshOperationalControlsProjection,
  resetReadinessState,
  storageRoot,
  waitForUiMotionToSettle,
} from "./support.ts";

test.describe.configure({ mode: "serial" });

test.afterAll(async () => {
  await rm(storageRoot, { recursive: true, force: true });
});

test("configura i due account e accede con entrambi", async ({ page }) => {
  test.setTimeout(240_000);
  // Ogni retry seriale ricrea fixture e database dal test, non da beforeAll.
  await resetReadinessState();
  await page.goto("/setup");
  await page.setViewportSize({ width: 320, height: 780 });
  await page.getByLabel("Codice di configurazione").fill("codice-di-configurazione-errato");
  await page.getByLabel("Password per Massimo").fill("password-massimo");
  await page.getByLabel("Password per Codex").fill("password-codex");
  await page.getByRole("button", { name: "Crea gli account" }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await expectViewportFits(page);
  await page.getByLabel("Codice di configurazione").fill("synthetic-bootstrap-token-for-tests");
  await page.getByLabel("Password per Massimo").fill("password-massimo");
  await page.getByLabel("Password per Codex").fill("password-codex");
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.getByRole("button", { name: "Crea gli account" }).click();

  await page.setViewportSize({ width: 320, height: 780 });
  await page.getByLabel("Nome utente").fill("mAsSiMo");
  await page.getByLabel("Password").fill("password-errata");
  await page.getByRole("button", { name: "Accedi" }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await expectViewportFits(page);
  await page.getByLabel("Nome utente").fill("mAsSiMo");
  await page.getByLabel("Password").fill("password-massimo");
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.getByRole("button", { name: "Accedi" }).click();

  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
  const persistentCookies = (await page.context().cookies()).filter(({ name }) =>
    ["csrf", "sessione"].includes(name),
  );
  expect(persistentCookies).toHaveLength(2);
  const expectedExpiry = Date.now() / 1000 + SESSION_TTL_SECONDS;
  expect(persistentCookies.every(({ expires }) => Math.abs(expires - expectedExpiry) < 60)).toBe(
    true,
  );
  await page.setViewportSize({ width: 320, height: 780 });
  await page.goto("/pagina-inesistente-di-esempio");
  await expect(page.getByRole("heading", { name: "La pagina non esiste" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Torna alla dashboard" })).toBeVisible();
  await expectViewportFits(page);
  await page.getByRole("link", { name: "Torna alla dashboard" }).click();
  await page.setViewportSize({ width: 1280, height: 720 });
  await expect(page.getByRole("heading", { name: "Da fare ora" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Stato operativo" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Collegamenti" })).toBeVisible();
  await expect(page.locator(".work-item")).toHaveCount(3);
  const dashboardActionBoxes = await page.locator(".work-item > a").evaluateAll((links) =>
    links.map((link) => {
      const box = link.getBoundingClientRect();
      return { height: box.height, top: box.top };
    }),
  );
  expect(
    Math.max(...dashboardActionBoxes.map(({ top }) => top)) -
      Math.min(...dashboardActionBoxes.map(({ top }) => top)),
  ).toBeLessThanOrEqual(1);
  expect(new Set(dashboardActionBoxes.map(({ height }) => height)).size).toBe(1);
  const dashboardDestinations = [
    ["Preparazioni approvabili", "/ordini?vista=fatturare", "Ordini"],
    ["Controlli da risolvere", "/controlli", "Controlli"],
    ["Pagamenti in attesa", "/ordini?vista=attesa", "Ordini"],
  ] as const;
  for (const [label, destination, heading] of dashboardDestinations) {
    const link = page.locator(".work-item").filter({ hasText: label }).getByRole("link");
    await expect(link).toHaveAttribute("href", destination);
    await link.click();
    await expect(page).toHaveURL(new RegExp(`${destination.replace("?", "\\?")}$`));
    await expect(page.getByRole("heading", { name: heading, exact: true })).toBeVisible();
    await page.goto("/");
  }
  await expect(page.locator(".connection")).toHaveCount(3);
  await expect(page.locator(".connection").filter({ hasText: "Aruba" })).toContainText(
    "Non collegato",
  );
  await expect(page.locator(".documents-chart__day")).toHaveCount(7);
  await page.getByRole("link", { name: "Documenti", exact: true }).click();
  await expect(page.getByRole("link", { name: "Vai agli ordini" })).toBeVisible();
  await page.getByRole("link", { name: "Attività", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Registro attività" })).toBeVisible();
  await page.getByRole("link", { name: "Dashboard", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
  const skipLink = page.getByRole("link", {
    name: "Vai al contenuto principale",
  });
  await skipLink.focus();
  await expect(skipLink).toBeVisible();
  await expectPlainLanguage(page);

  const sidebar = page.locator(".sidebar");
  const appMain = page.locator(".app-main");
  const brandName = sidebar.locator(".brand-lockup__name");
  const collapseSidebar = page.getByRole("button", {
    name: "Comprimi navigazione",
  });
  await expect(collapseSidebar).toHaveAttribute("aria-expanded", "true");
  await expect(sidebar).toHaveCSS("width", "256px");
  await expect(brandName).toHaveCSS("white-space", "nowrap");
  await collapseSidebar.click();
  await expect(page.locator("html")).toHaveAttribute("data-sidebar", "collapsed");
  await expect(page.getByRole("button", { name: "Espandi navigazione" })).toHaveAttribute(
    "aria-expanded",
    "false",
  );
  await expect(sidebar).toHaveCSS("width", "72px");
  await expect(appMain).toHaveCSS("margin-left", "72px");
  await expect(sidebar).toHaveCSS("z-index", "40");
  const controlsNavigation = page.getByRole("link", { name: "Controlli", exact: true }).first();
  await controlsNavigation.evaluate((element) => {
    const badge = document.createElement("span");
    badge.className = "nav-item__badge";
    badge.ariaHidden = "true";
    badge.textContent = "99+";
    element.append(badge);
  });
  expect(
    await controlsNavigation.evaluate((element) => {
      const navigation = element.getBoundingClientRect();
      const icon = element.querySelector("svg")!.getBoundingClientRect();
      const badge = element.querySelector<HTMLElement>(".nav-item__badge")!;
      const badgeBounds = badge.getBoundingClientRect();
      const navigationIcons = Array.from(
        element.closest("nav")!.querySelectorAll<SVGElement>(".nav-item > svg"),
      ).map((navigationIcon) => navigationIcon.getBoundingClientRect());
      const iconCenter = icon.left + icon.width / 2;
      return {
        badgeFits: badge.scrollWidth <= badge.clientWidth,
        contained:
          icon.left >= navigation.left &&
          badgeBounds.right <= navigation.right &&
          badgeBounds.top >= navigation.top &&
          badgeBounds.bottom <= navigation.bottom,
        iconAligned: navigationIcons.every(
          (navigationIcon) =>
            Math.abs(navigationIcon.left + navigationIcon.width / 2 - iconCenter) <= 0.5,
        ),
        smallerThanIcon: badgeBounds.height < icon.height,
        bottomRight:
          badgeBounds.left + badgeBounds.width / 2 > iconCenter &&
          badgeBounds.top + badgeBounds.height / 2 > icon.top + icon.height / 2,
      };
    }),
  ).toEqual({
    badgeFits: true,
    contained: true,
    iconAligned: true,
    smallerThanIcon: true,
    bottomRight: true,
  });
  const settingsNavigation = page.getByRole("link", { name: "Impostazioni", exact: true }).first();
  await settingsNavigation.hover();
  expect(
    await settingsNavigation.evaluate((element) => getComputedStyle(element, "::after").opacity),
  ).toBe("1");
  await settingsNavigation.focus();
  await expect(settingsNavigation).toBeFocused();
  await expect(settingsNavigation).toHaveAccessibleName("Impostazioni");
  expect(await page.evaluate(() => localStorage.getItem("sidebar"))).toBe("collapsed");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-sidebar", "collapsed");
  await expect(sidebar).toHaveCSS("width", "72px");
  const expandSidebar = page.getByRole("button", {
    name: "Espandi navigazione",
  });
  await expandSidebar.click();
  const brandTransitionFrames = await brandName.evaluate(async (element) => {
    const frames: Array<{
      height: number;
      lineHeight: number;
      opacity: number;
    }> = [];
    for (let frame = 0; frame < 4; frame += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const style = getComputedStyle(element);
      frames.push({
        height: element.getBoundingClientRect().height,
        lineHeight: Number.parseFloat(style.lineHeight),
        opacity: Number.parseFloat(style.opacity),
      });
    }
    return frames;
  });
  expect(brandTransitionFrames.every(({ height, lineHeight }) => height <= lineHeight + 1)).toBe(
    true,
  );
  await expect(brandName).toHaveCSS("opacity", "1");
  await page.getByRole("button", { name: "Comprimi navigazione" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-sidebar", "collapsed");

  const background = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  const lightBackground = await background();

  await page.getByLabel("Apri il menu di Massimo").click();
  const darkTheme = page.getByRole("button", { name: "Scuro" });
  await expect(darkTheme).toBeVisible();
  // Il pannello può essere riconciliato mentre i loader della Dashboard terminano: il click
  // forzato evita di attendere una stabilità geometrica non necessaria per questo controllo.
  await darkTheme.click({ force: true });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await waitForUiMotionToSettle(page.locator("body"));
  // I token risolvono con `light-dark()`: l'attributo da solo non prova che il tema cambi.
  expect(await background()).not.toBe(lightBackground);

  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  expect(await background()).not.toBe(lightBackground);
  await page.getByLabel("Apri il menu di Massimo").click();
  await expect(page.locator(".profile-menu__identity")).toContainText("Massimo");
  await expect(page.locator(".profile-menu__identity")).toContainText("Amministratore");
  await expect(page.locator(".profile-menu__permission")).toContainText(
    "Può gestire, approvare, numerare e autorizzare gli invii.",
  );
  await waitForUiMotionToSettle(page.locator(".profile-menu__panel"));
  expect(
    await page
      .locator(".profile-menu .theme-picker__choice svg")
      .evaluateAll((icons) => icons.map((icon) => icon.getBoundingClientRect().width)),
  ).toEqual([20, 20, 20]);
  await page.getByRole("link", { name: "Profilo e sicurezza" }).click();
  await expect(page).toHaveURL(/\/impostazioni#profilo-sicurezza$/);
  await expect(page.getByRole("heading", { name: "Profilo e sicurezza" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Sezioni delle impostazioni" })).toContainText(
    "E-mail al cliente",
  );
  await expect(page.getByRole("group", { name: "Tema" })).toBeVisible();
  await expect(
    page.getByRole("button", {
      name: "Salva regola di preparazione fattura",
    }),
  ).toBeDisabled();
  await expect(page.getByRole("button", { name: "Salva integrazione Aruba" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Salva modalità e-mail" })).toBeDisabled();
  await expect(
    page.getByText(
      "Scegli se inviare automaticamente, richiedere una conferma o disattivare gli invii da Hub Fatture.",
    ),
  ).toBeVisible();
  const customerEmailMode = page.getByLabel("Modalità invio copia");
  await expect(customerEmailMode.locator("option")).toHaveText([
    "Automatica dopo l’esito SdI",
    "Manuale con approvazione",
    "Disattivata",
  ]);
  await expect(page.getByText("Questa sessione", { exact: true })).toBeVisible();
  await expect(page.getByText(/Ogni accesso resta valido per un anno/)).toBeVisible();
  await expect(page.locator('.settings-nav__item[aria-current="location"]')).toHaveText(
    "Profilo e sicurezza",
  );
  await expect(page.locator(".settings-section")).toHaveCount(7);
  await waitForUiMotionToSettle(page.locator(".route-content"));
  expect(
    await page.locator(".settings-section .button").evaluateAll((buttons) =>
      buttons.every((button) => {
        const section = button.closest(".settings-section");
        if (!section) return false;
        return section.getBoundingClientRect().right - button.getBoundingClientRect().right >= 24;
      }),
    ),
  ).toBe(true);
  expect(
    await page
      .locator(".settings-profile-grid > *, .settings-profile-details > *")
      .evaluateAll((cards) => {
        const widths = cards.map((card) => card.getBoundingClientRect().width);
        return Math.max(...widths) - Math.min(...widths);
      }),
  ).toBeLessThanOrEqual(1);
  expect(
    await page.locator(".settings-facts-grid--four > div").evaluateAll((cards) => {
      const rects = cards.map((card) => card.getBoundingClientRect());
      return {
        count: rects.length,
        heightDelta:
          Math.max(...rects.map(({ height }) => height)) -
          Math.min(...rects.map(({ height }) => height)),
        widthDelta:
          Math.max(...rects.map(({ width }) => width)) -
          Math.min(...rects.map(({ width }) => width)),
      };
    }),
  ).toEqual({ count: 8, heightDelta: 0, widthDelta: 0 });
  expect(
    await page.locator(".settings-select").evaluateAll((wrappers) => {
      const visible = wrappers.filter((wrapper) => wrapper.getBoundingClientRect().width > 0);
      return (
        visible.length > 0 &&
        visible.every((wrapper) => {
          const select = wrapper.querySelector("select")!;
          const icon = wrapper.querySelector("svg")!;
          const selectBox = select.getBoundingClientRect();
          const iconBox = icon.getBoundingClientRect();
          return (
            getComputedStyle(select).appearance === "none" &&
            selectBox.right - iconBox.right >= 12 &&
            Number.parseFloat(getComputedStyle(select).paddingRight) >= 40
          );
        })
      );
    }),
  ).toBe(true);
  expect(
    await page.locator(".system-groups > .system-group").evaluateAll((cards) => {
      const [operations, data] = cards.map((card) => card.getBoundingClientRect());
      return Math.abs(operations!.height - data!.height);
    }),
  ).toBeLessThanOrEqual(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
    await page.evaluate(() => document.documentElement.clientWidth),
  );

  const denseSessionsClient = new pg.Client({
    connectionString: databaseUrl,
  });
  await denseSessionsClient.connect();
  await denseSessionsClient.query(
    `INSERT INTO sessions (id_hash, user_id, csrf_token_hash, expires_at, created_at, last_seen_at)
     SELECT 'dense-session-' || value,
            (SELECT id FROM users WHERE username = 'Massimo'),
            'synthetic-csrf-' || value,
            now() + interval '8 hours',
            now() - (value * interval '1 day'),
            now() - (value * interval '10 minutes')
     FROM generate_series(1, 30) AS value`,
  );
  await denseSessionsClient.end();
  await page.reload();
  await expect(page.locator(".session-list li")).toHaveCount(31);
  expect(
    await page.locator(".session-list").evaluate((list) => list.clientHeight),
  ).toBeLessThanOrEqual(304);
  expect(
    await page.locator(".session-list").evaluate((list) => list.scrollHeight > list.clientHeight),
  ).toBe(true);
  const latestMigration = page.getByText(latestMigrationFileName(await readdir("migrations")), {
    exact: true,
  });
  await expect(latestMigration).toBeVisible();
  await expect(page.getByText("Disabilitato", { exact: true })).toBeVisible();
  await expect(
    page.getByText("Nessuna ricevuta valida disponibile", { exact: true }),
  ).toBeVisible();
  await customerEmailMode.selectOption("DISABLED");
  await page.getByRole("button", { name: "Salva modalità e-mail" }).click();
  await expect(page).toHaveURL(/email=salvata/);
  await expect(page.getByRole("status")).toContainText("Modalità e-mail aggiornata");
  await expect(page.getByLabel("Modalità invio copia")).toHaveValue("DISABLED");
  await page.getByLabel("Modalità invio copia").selectOption("AUTOMATIC");
  const saveCustomerEmailMode = page.getByRole("button", {
    name: "Salva modalità e-mail",
  });
  await expect(saveCustomerEmailMode).toBeEnabled();
  await saveCustomerEmailMode.click();
  await expect(saveCustomerEmailMode).toBeDisabled();
  await expect(page.getByLabel("Modalità invio copia")).toHaveValue("AUTOMATIC");

  await verifyFiscalProfileApi(page);

  await page.getByLabel("Apri il menu di Massimo").click();
  await page.locator(".profile-menu").getByRole("button", { name: "Esci" }).click();
  await expect(page).toHaveURL(/\/login$/);
  await page.goto("/");
  await expect(page).toHaveURL(/\/login$/);
  await page.goto("/setup");
  await expect(page).toHaveURL(/\/login$/);

  await page.getByLabel("Nome utente").fill("CODEX");
  await page.getByLabel("Password").fill("password-codex");
  await page.getByRole("button", { name: "Accedi" }).click();
  await page.getByLabel("Apri il menu di Codex").click();
  await expect(page.locator(".profile-menu__identity")).toContainText("Codex");
  await expect(page.locator(".profile-menu__identity")).toContainText("Amministratore");
  await expect(page.locator(".profile-menu__permission")).toContainText(
    "Può gestire, approvare, numerare e autorizzare gli invii.",
  );

  await page.getByRole("link", { name: "Ordini", exact: true }).click();
  await page.getByRole("button", { name: "Carica ordini di esempio" }).click();
  await expect(page.getByRole("status")).toContainText(
    "Ordini di esempio caricati. Nuovi: 3; aggiornati: 0; meno recenti ignorati: 0.",
  );
  const searchRequests: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname === "/ricerca.data" && url.searchParams.get("q") === "Mario Rossi") {
      searchRequests.push(request.url());
    }
  });
  await page.getByLabel("Apri la ricerca globale").click();
  await expect(page.getByRole("dialog", { name: "Ricerca globale" })).toBeVisible();
  await page
    .getByLabel("Cerca in ordini, documenti, clienti, controlli e cronologia")
    .fill("Mario Rossi");
  const searchDialog = page.getByRole("dialog", { name: "Ricerca globale" });
  await expect(searchDialog.getByRole("heading", { name: "Ordini" })).toBeVisible();
  await expect(searchDialog.getByRole("heading", { name: "Clienti" })).toBeVisible();
  await expect.poll(() => searchRequests.length).toBe(1);
  await page.waitForTimeout(500);
  expect(searchRequests).toHaveLength(1);
  await page
    .getByLabel("Cerca in ordini, documenti, clienti, controlli e cronologia")
    .fill("000001");
  await expect(searchDialog.getByRole("heading", { name: "Cronologia" })).toBeVisible();
  await page
    .getByLabel("Cerca in ordini, documenti, clienti, controlli e cronologia")
    .fill("Mario Rossi");
  await expect(page.getByRole("link", { name: /Mario Rossi/ }).last()).toBeVisible();
  await page
    .getByRole("link", { name: /Mario Rossi/ })
    .last()
    .click();
  await expect(page.getByRole("heading", { name: "Mario Rossi" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Anagrafica corrente" })).toBeVisible();
  await expect(page.getByText("mario.rossi@example.invalid")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Ordini collegati" })).toBeVisible();
  await page.getByLabel("Apri la ricerca globale").click();
  await page
    .getByLabel("Cerca in ordini, documenti, clienti, controlli e cronologia")
    .fill("nessun risultato possibile");
  await expect(page.getByText("Nessun risultato", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Ricerca globale" })).toHaveCount(0);
  await expect(page.getByLabel("Apri la ricerca globale")).toBeFocused();
  await page.setViewportSize({ width: 320, height: 720 });
  await page.getByLabel("Apri la ricerca globale").click();
  await expect(page.getByRole("dialog", { name: "Ricerca globale" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Esc", exact: true })).toBeHidden();
  await expect(page.getByLabel("Cancella la ricerca")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Ricerca globale" })).toHaveCount(0);
  await expect(page.getByLabel("Apri la ricerca globale")).toBeFocused();
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.getByRole("link", { name: "Ordini", exact: true }).click();
  await expectPlainLanguage(page);
  await expect(page.getByRole("row")).toHaveCount(4);
  await page.getByRole("button", { name: "Espandi navigazione" }).click();
  await page.getByRole("link", { name: "Clienti", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Clienti", exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Riepilogo clienti" })).toContainText(
    "2 clienti importati",
  );
  const customerRows = page.locator(".customer-table tbody tr");
  await expect(customerRows).toHaveCount(2);
  expect(
    await customerRows.evaluateAll((rows) =>
      rows.every((row) => {
        const activityCell = row.querySelector<HTMLElement>(".customer-table__activity");
        return (
          activityCell !== null &&
          Math.abs(
            activityCell.getBoundingClientRect().bottom - row.getBoundingClientRect().bottom,
          ) < 1
        );
      }),
    ),
  ).toBe(true);
  const customerActionSpacing = await customerRows
    .first()
    .locator(".customer-table__action .dashboard-row-link")
    .evaluate((action) => {
      const label = action.querySelector<HTMLElement>("span");
      const icon = action.querySelector<SVGElement>("svg");
      if (!label || !icon) return null;
      const actionBox = action.getBoundingClientRect();
      return {
        left: label.getBoundingClientRect().left - actionBox.left,
        right: actionBox.right - icon.getBoundingClientRect().right,
      };
    });
  expect(customerActionSpacing).not.toBeNull();
  expect(Math.abs(customerActionSpacing!.left - customerActionSpacing!.right)).toBeLessThanOrEqual(
    2,
  );
  const marioCustomer = customerRows.filter({ hasText: "Mario Rossi" });
  await expect(marioCustomer).toContainText("mario.rossi@example.invalid");
  await expect(marioCustomer).toContainText("RSSMRA80A01H501U");
  await expect(page.getByRole("columnheader")).toHaveCount(7);
  await page
    .getByRole("link", {
      name: "Cliente: attiva per ordinare in senso crescente",
    })
    .click();
  await expect(page).toHaveURL(/ordina=cliente&direzione=asc/);
  await page
    .getByRole("link", {
      name: "Cliente: ordine crescente. Attiva per ordinare in senso decrescente",
    })
    .click();
  await expect(page).toHaveURL(/ordina=cliente&direzione=desc/);
  await expect(customerRows.first()).toContainText("Mario Rossi");
  expect(
    await customerRows.evaluateAll((rows) =>
      rows.every((row) => {
        const values = row.querySelectorAll<HTMLElement>(
          ".customer-table__primary a, .customer-table__clamp, .customer-table__truncate",
        );
        const action = row.querySelector<HTMLElement>(".customer-table__action a");
        return (
          [...values].every((value) => getComputedStyle(value).textOverflow !== "ellipsis") &&
          (action ? action.scrollWidth <= action.clientWidth : false)
        );
      }),
    ),
  ).toBe(true);
  await expect(page.getByRole("region", { name: "Elenco clienti" })).not.toContainText(
    "Dato fiscale",
  );
  await page.getByRole("search", { name: "Cerca clienti" }).getByLabel("Cerca").fill("Mario");
  await page.getByRole("search", { name: "Cerca clienti" }).getByRole("button").click();
  await expect(customerRows).toHaveCount(1);
  await page.getByRole("link", { name: "Mario Rossi", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Mario Rossi" })).toBeVisible();
  const customerBackLink = page.getByRole("link", {
    name: "Torna ai clienti",
  });
  const customerHeading = page.getByRole("heading", { name: "Mario Rossi" });
  const [customerBackLinkBox, customerHeadingBox] = await Promise.all([
    customerBackLink.boundingBox(),
    customerHeading.boundingBox(),
  ]);
  assert(customerBackLinkBox && customerHeadingBox);
  expect(customerBackLinkBox.y + customerBackLinkBox.height).toBeLessThan(customerHeadingBox.y);
  await expect(page.getByRole("heading", { name: "Anagrafica corrente" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Origine dei dati" })).toBeVisible();
  await expect(page.locator(".customer-source-list li")).toHaveCount(2);
  await expect(page.getByRole("heading", { name: "Ordini collegati" })).toBeVisible();
  await expect(
    page.locator("#customer-orders-title").locator("xpath=ancestor::section").locator("li"),
  ).toHaveCount(2);
  await customerBackLink.click();
  await expect(page).toHaveURL(/\/clienti$/);
  await expect(page.getByRole("heading", { name: "Clienti", exact: true })).toBeVisible();
  await expect(customerRows).toHaveCount(2);

  await page.setViewportSize({ width: 320, height: 780 });
  const initialMobileMenuTrigger = page.getByRole("button", {
    name: "Apri il menu di navigazione",
  });
  const initialMobileMenu = page.getByRole("dialog", {
    name: "Navigazione principale",
  });
  await expect(initialMobileMenuTrigger).toBeVisible();
  await expect(initialMobileMenuTrigger).toHaveAttribute("aria-expanded", "false");
  await expect
    .poll(() =>
      initialMobileMenuTrigger.evaluate((trigger) => {
        const center = trigger.getBoundingClientRect();
        const topmost = document.elementFromPoint(
          center.left + center.width / 2,
          center.top + center.height / 2,
        );
        return topmost !== null && trigger.contains(topmost);
      }),
    )
    .toBe(true);
  await initialMobileMenuTrigger.click();
  await expect(initialMobileMenu).toBeVisible();
  await expect(initialMobileMenu.getByRole("link")).toHaveCount(7);
  await expect(
    initialMobileMenu.getByRole("link", { name: "Controlli", exact: true }),
  ).toBeVisible();
  await expect(
    initialMobileMenu.getByRole("link", { name: "Attività", exact: true }),
  ).toBeVisible();
  await expect(
    initialMobileMenu.getByRole("link", {
      name: "Impostazioni",
      exact: true,
    }),
  ).toBeVisible();
  await expect(initialMobileMenuTrigger).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("Escape");
  await expect(initialMobileMenu).not.toBeVisible();
  await expect(initialMobileMenuTrigger).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.setViewportSize({ width: 1280, height: 720 });

  await page.getByRole("link", { name: "Ordini", exact: true }).click();
  await expect(page.getByLabel(/^Data ordine/)).toHaveValue("");
  const controlHeights = await page
    .getByRole("search", { name: "Filtra gli ordini" })
    .locator("input, select, button")
    .evaluateAll((controls) => controls.map((control) => control.getBoundingClientRect().height));
  expect(controlHeights.every((height) => Math.abs(height - 44) <= 0.01)).toBe(true);
  const salesChannelSelect = page.getByLabel("Canale di vendita");
  expect(
    await salesChannelSelect.evaluate((select) => {
      const style = getComputedStyle(select);
      return {
        appearance: style.appearance,
        paddingRight: Number.parseFloat(style.paddingRight),
      };
    }),
  ).toEqual({ appearance: "none", paddingRight: 44 });
  await expect(page.getByRole("heading", { name: "Elenco ordini" })).toBeVisible();
  const firstOrderRow = page.locator(".orders-table tbody tr").first();
  await expect(firstOrderRow).toBeVisible();
  expect(await firstOrderRow.evaluate((row) => row.getBoundingClientRect().height)).toBeLessThan(
    70,
  );
  expect(
    await firstOrderRow.evaluate((row) => {
      const actionCell = row.querySelector<HTMLElement>(".orders-table__action");
      const action = actionCell?.querySelector<HTMLElement>(".dashboard-row-link");
      return actionCell && action
        ? actionCell.getBoundingClientRect().right - action.getBoundingClientRect().right
        : 0;
    }),
  ).toBeGreaterThanOrEqual(12);
  expect(
    await firstOrderRow.evaluate((row) => {
      const action = row.querySelector<HTMLElement>(".orders-table__action a");
      return action ? action.scrollWidth <= action.clientWidth : false;
    }),
  ).toBe(true);
  const orderActionSpacing = await firstOrderRow
    .locator(".orders-table__action .dashboard-row-link")
    .evaluate((action) => {
      const label = action.querySelector<HTMLElement>("span");
      const icon = action.querySelector<SVGElement>("svg");
      if (!label || !icon) return null;
      const actionBox = action.getBoundingClientRect();
      return {
        left: label.getBoundingClientRect().left - actionBox.left,
        right: actionBox.right - icon.getBoundingClientRect().right,
      };
    });
  expect(orderActionSpacing).not.toBeNull();
  expect(Math.abs(orderActionSpacing!.left - orderActionSpacing!.right)).toBeLessThanOrEqual(2);
  expect(
    await firstOrderRow.evaluate((row) => {
      const detail = row.querySelector<HTMLAnchorElement>("td:first-child a");
      const action = row.querySelector<HTMLAnchorElement>(".orders-table__action a");
      return detail?.getAttribute("href") === action?.getAttribute("href");
    }),
  ).toBe(true);
  await expect(page.getByRole("navigation", { name: "Navigazione principale" })).not.toContainText(
    "Schede",
  );
  await page.getByLabel(/^Pagamento/).selectOption("PENDING");
  await page.getByRole("button", { name: "Filtra" }).click();
  await expect(page.getByRole("row")).toHaveCount(2);
  await expect(page.getByLabel(/^Pagamento/)).toHaveValue("PENDING");
  await expect(page.getByText("1 filtro attivo")).toBeVisible();
  await expect(page.getByRole("link", { name: "Azzera filtri" })).toBeVisible();

  await page.getByRole("link", { name: "Da fatturare" }).click();
  await expect(
    page.getByText(
      "Nessuna preparazione è approvabile finché il controllo globale dell’inventario Aruba non viene risolto.",
    ),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "Niente da fatturare" })).toBeVisible();

  const preparationClient = new pg.Client({ connectionString: databaseUrl });
  await preparationClient.connect();
  const preparation = await preparationClient.query<{ id: string }>(
    `SELECT id::text FROM billing_cases
      WHERE status IN ('READY', 'NEEDS_REVIEW')
      ORDER BY id
      LIMIT 1`,
  );
  await preparationClient.end();
  assert(preparation.rows[0]);
  await page.goto(`/ordini/preparazione/${preparation.rows[0].id}`);
  await expect(page.getByRole("heading", { name: /^Preparazione fattura \d{6}$/ })).toBeVisible();
  await expectPlainLanguage(page);
  await expect(page.getByText("Preparazione fattura creata")).toBeVisible();
  await expect(page.getByText("BILLING_CASE_CREATED")).toHaveCount(0);
  const preparationOverview = page.locator(".preparation-overview__card");
  await expect(preparationOverview).toHaveCount(1);
  const overviewGeometry = await preparationOverview.evaluate((overview) => {
    const orders = overview.querySelector<HTMLElement>(".preparation-overview__orders");
    const ordersHeading = orders?.querySelector<HTMLElement>("h3");
    const facts = overview.querySelector<HTMLElement>(".preparation-overview__facts");
    const action = overview.querySelector<HTMLElement>(".preparation-overview__action");
    const input = overview.querySelector<HTMLInputElement>("input[name='reason']");
    const button = overview.querySelector<HTMLButtonElement>("button.button--warning");
    if (!orders || !ordersHeading || !facts || !action || !input || !button) return null;
    const overviewBox = overview.getBoundingClientRect();
    const ordersBox = orders.getBoundingClientRect();
    const factsBox = facts.getBoundingClientRect();
    const actionBox = action.getBoundingClientRect();
    const inputBox = input.getBoundingClientRect();
    const buttonBox = button.getBoundingClientRect();
    return {
      actionSpansContent: actionBox.left <= ordersBox.left && actionBox.right >= ordersBox.right,
      buttonAlignment: Math.abs(inputBox.bottom - buttonBox.bottom),
      bottomGap: overviewBox.bottom - actionBox.bottom,
      factsAboveOrders: factsBox.bottom <= ordersBox.top,
      headingCount: overview.querySelectorAll(":scope > h2").length,
      ordersHeadingGap: ordersHeading.getBoundingClientRect().top - ordersBox.top,
    };
  });
  expect(overviewGeometry).not.toBeNull();
  expect(overviewGeometry?.actionSpansContent).toBe(true);
  expect(overviewGeometry?.buttonAlignment ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(1);
  expect(overviewGeometry?.bottomGap ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(36);
  expect(overviewGeometry?.factsAboveOrders).toBe(true);
  expect(overviewGeometry?.headingCount).toBe(1);
  expect(overviewGeometry?.ordersHeadingGap ?? 0).toBeGreaterThanOrEqual(24);
  const initialActivityDates = await page
    .locator(".preparation-activity__timeline time")
    .evaluateAll((dates) => dates.map((item) => item.getBoundingClientRect().right));
  expect(initialActivityDates.length).toBeGreaterThan(1);
  expect(Math.max(...initialActivityDates) - Math.min(...initialActivityDates)).toBeLessThanOrEqual(
    1,
  );
  await page.getByLabel(/^Motivo della scelta/).fill("Ordine di test");
  await page.getByRole("button", { name: "Non trasmettere" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Ordine di test" })).toBeVisible();
  const archivedPreparation = await page
    .getByRole("heading", { name: /^Preparazione fattura \d{6}$/ })
    .textContent();
  await page.getByRole("link", { name: "Ordini", exact: true }).click();
  await page.getByRole("link", { name: "Annullati" }).click();
  await expect(page.getByRole("heading", { name: "Preparazioni non trasmesse" })).toBeVisible();
  await expect(page.getByRole("cell", { name: "Da non trasmettere", exact: true })).toBeVisible();
  await page
    .getByRole("link", { name: `Apri ${archivedPreparation}` })
    .first()
    .click();
  await page.getByRole("button", { name: "Riattiva preparazione" }).click();
  await expect(page.getByRole("button", { name: "Non trasmettere" })).toBeVisible();

  // Separazione di un ordine e reinserimento dello stesso ordine compatibile.
  await page.getByRole("button", { name: "Separa dalla preparazione" }).first().click();
  await expect(page.getByRole("button", { name: "Separa dalla preparazione" })).toHaveCount(0);
  await page.getByLabel("Aggiungi un ordine compatibile").selectOption({ index: 0 });
  await page.getByRole("button", { name: "Aggiungi", exact: true }).click();
  await expect(page.getByText("Ordine separato dalla preparazione")).toBeVisible();
  await expect(page.getByRole("button", { name: "Separa dalla preparazione" })).toHaveCount(2);

  await page.getByRole("link", { name: /^Shopify/ }).click();
  await expect(page.getByText("Pagato", { exact: true })).toBeVisible();
  await expect(page.getByText("Spedito", { exact: true })).toBeVisible();
  await expect(page.getByText("Fattura in preparazione", { exact: true })).toBeVisible();
  await expectPlainLanguage(page);
  await expect(page.getByText("PRIVATE_IT")).toHaveCount(0);
  await expect(page.locator(".order-detail-grid > .order-detail-panel")).toHaveCount(2);
  await expect(
    page.locator(".detail-subsection").getByRole("heading", { name: "Pagamenti" }),
  ).toBeVisible();
  await expect(page.locator(".customer-comparison__section")).toHaveCount(2);
  await page.setViewportSize({ width: 1280, height: 800 });
  const orderDetailPanelHeights = await page
    .locator(".order-detail-grid > .order-detail-panel")
    .evaluateAll((panels) => panels.map((panel) => panel.getBoundingClientRect().height));
  expect(orderDetailPanelHeights).toHaveLength(2);
  expect(Math.abs(orderDetailPanelHeights[0]! - orderDetailPanelHeights[1]!)).toBeLessThanOrEqual(
    1,
  );
  for (const width of [1280, 1024, 320]) {
    await page.setViewportSize({ width, height: width === 320 ? 780 : 800 });
    await expectViewportFits(page);
  }
  await page.setViewportSize({ width: 1280, height: 720 });

  await page.getByRole("link", { name: "Ordini", exact: true }).click();
  await page.getByRole("link", { name: "In attesa" }).click();
  await expectUnpreparedPendingOrder(page);
  await page.goto("/ordini?stato=WAITING_FOR_TRIGGER");
  await page.getByRole("link", { name: "Shopify #S-1002", exact: true }).click();
  await page.getByRole("button", { name: "Prepara la fattura ora" }).click();
  await expect(page.getByRole("heading", { name: /^Preparazione fattura \d{6}$/ })).toBeVisible();
  await expect(page.getByText("Preparazione anticipata richiesta")).toBeVisible();
  await page.goto("/ordini?vista=attesa");
  await expectPreparedPendingOrder(page);

  const connectionClient = new pg.Client({ connectionString: databaseUrl });
  await connectionClient.connect();
  await connectionClient.query(
    `INSERT INTO connections
       (provider, environment, account_reference, encrypted_credentials, status, created_at,
        last_synced_at)
     VALUES
       ('SHOPIFY', 'DEVELOPMENT', 'shop.example.invalid', 'synthetic', 'CONNECTED',
        '2026-08-01T10:00:00Z', now()),
       ('EBAY', 'SANDBOX', 'ebay-synthetic', 'synthetic', 'CONNECTED',
        '2026-08-10T10:00:00Z', now())
     ON CONFLICT (provider, environment) DO UPDATE SET
       status = 'CONNECTED', created_at = EXCLUDED.created_at,
       last_synced_at = EXCLUDED.last_synced_at`,
  );
  await page.goto("/");
  const arubaConnection = page.locator(".connection").filter({ hasText: "Aruba" });
  await expect(arubaConnection).toContainText("Non collegato");
  await expect(page.getByText("Aggiornamenti da completare", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Impostazioni" }).click();
  const arubaSync = page.locator(".aruba-sync-card");
  await expect(arubaSync.getByRole("heading", { name: "Aggiornamento necessario" })).toBeVisible();
  await expect(
    arubaSync.getByText(
      "L’inventario è vecchio o l’ultima lettura non è riuscita. Avvia una nuova sincronizzazione.",
    ),
  ).toBeVisible();
  await expect(arubaSync).not.toContainText(/preferito|browser/i);
  expect(
    await page.evaluate(() => {
      const probe = document.createElement("div");
      probe.className = "settings-manual-readback";
      document.body.append(probe);
      const marginTop = Number.parseFloat(getComputedStyle(probe).marginTop);
      probe.remove();
      return marginTop;
    }),
  ).toBeGreaterThanOrEqual(16);
  await page.setViewportSize({ width: 320, height: 780 });
  await expectViewportFits(page);
  expect(
    await page
      .locator(".aruba-inventory-card dl")
      .evaluate((grid) => getComputedStyle(grid).gridTemplateColumns.split(" ").length),
  ).toBe(1);
  expect(
    await page
      .locator(".aruba-inventory-card")
      .evaluate((card) => Number.parseFloat(getComputedStyle(card).paddingTop)),
  ).toBeGreaterThanOrEqual(16);
  const inventoryStatus = page.locator(".aruba-inventory-card .settings-status");
  expect(
    await inventoryStatus.evaluate((status) => status.getBoundingClientRect().right),
  ).toBeLessThanOrEqual(320);
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto("/");
  await connectionClient.query(
    `INSERT INTO aruba_sync_runs
       (id, environment, api_environment, account_reference, kind, authority_mode, status,
        window_start, window_end, checkpoint_start, checkpoint_end, lease_expires_at,
        completed_at, full_scan_completed_at)
     VALUES
       ('00000000-0000-4000-8000-000000000072', 'MOCK', 'DEMO',
        'synthetic-aruba-account', 'FULL', 'CANONICAL', 'COMPLETED', now() - interval '2 days',
        now(), now() - interval '2 days', now(), now(), now(), now())`,
  );
  await connectionClient.query(
    `INSERT INTO aruba_batches
       (id, environment, mode, account_reference, manifest_sha256, document_count, status,
        requires_reconciliation, created_by, last_readback_at)
     VALUES
       ('00000000-0000-4000-8000-000000000073', 'MOCK', 'DOCUMENT_ONLY', 'synthetic', $1, 1,
        'RECONCILIATION_REQUIRED', true, (SELECT id FROM users ORDER BY id LIMIT 1), now())`,
    ["7".repeat(64)],
  );
  await refreshOperationalControlsProjection();
  await page.goto("/");
  await expect(arubaConnection).not.toContainText("Mai letto");
  await expect(page.getByText("1 errore tecnico aperto", { exact: true })).toBeVisible();
  await expect(
    page.locator(".work-item").filter({ hasText: "Controlli da risolvere" }),
  ).toContainText("1");
  await connectionClient.query(
    "DELETE FROM aruba_batches WHERE id = '00000000-0000-4000-8000-000000000073'",
  );
  await page.getByRole("link", { name: "Impostazioni" }).click();
  await expect(page.getByLabel("Importa ordini Shopify dal")).toHaveAttribute("type", "date");
  await expect(page.getByLabel("Importa ordini Shopify dal")).toHaveValue("2026-07-25");
  await expect(page.getByLabel("Importa ordini eBay dal")).toHaveValue("2026-08-03");
  await page.goto("/impostazioni?historyStart=2026-08-09&historyProvider=EBAY#connessioni");
  await expect(page.getByLabel("Importa ordini Shopify dal")).toHaveValue("2026-07-25");
  await expect(page.getByLabel("Importa ordini eBay dal")).toHaveValue("2026-08-09");
  await expect(page.getByRole("button", { name: "Controlla intervallo" })).toHaveCount(2);
  await expect(page.getByRole("button", { name: "Importa storico" })).toHaveCount(2);
  await connectionClient.query(
    `INSERT INTO sync_cursors (provider, stream, cursor, overlap_from)
     VALUES ('SHOPIFY', 'history_import', 'ready', now())`,
  );
  await connectionClient.end();
  await page.reload();
  const shopifyConnection = page
    .locator(".connection-panel")
    .filter({ has: page.getByRole("heading", { name: "Shopify" }) });
  await expect(
    shopifyConnection.getByText(
      "Import iniziale completato. Gli aggiornamenti automatici sono attivi.",
    ),
  ).toBeVisible();
  expect(
    await shopifyConnection.evaluate((panel) => {
      const actions = panel.querySelector(".connection-panel__actions")!;
      const history = panel.querySelector(".connection-history")!;
      return history.getBoundingClientRect().top - actions.getBoundingClientRect().bottom;
    }),
  ).toBeGreaterThanOrEqual(16);
  await expect
    .poll(() =>
      page.locator(".connection-panel").evaluateAll((panels) => {
        const rects = panels.map((panel) => panel.getBoundingClientRect());
        const alignedTops = [
          "header",
          ".connection-panel__facts",
          ".connection-panel__actions",
          ".connection-history",
        ].every((selector) => {
          const tops = panels.map(
            (panel) => panel.querySelector(selector)!.getBoundingClientRect().top,
          );
          return Math.max(...tops) - Math.min(...tops) <= 1;
        });
        return {
          alignedTops,
          heightDelta:
            Math.max(...rects.map(({ height }) => height)) -
            Math.min(...rects.map(({ height }) => height)),
          widthDelta:
            Math.max(...rects.map(({ width }) => width)) -
            Math.min(...rects.map(({ width }) => width)),
        };
      }),
    )
    .toEqual({ alignedTops: true, heightDelta: 0, widthDelta: 0 });
  await page.getByLabel("Prepara la fattura").selectOption("FULFILLED");
  await page.getByRole("button", { name: "Salva regola di preparazione fattura" }).click();
  await expect(page.getByRole("status")).toContainText("Impostazione aggiornata");
  await page
    .getByRole("combobox", { name: /^Commissioni Shopify Payments/ })
    .selectOption("INCLUDE");
  await page
    .getByRole("button", {
      name: "Salva regola commissioni Shopify Payments",
    })
    .click();
  await expect(page.getByRole("status")).toContainText("Regola Shopify Payments aggiornata");
  await expect(page.getByRole("combobox", { name: /^Commissioni Shopify Payments/ })).toHaveValue(
    "INCLUDE",
  );
  await page
    .getByRole("combobox", { name: /^Commissioni Shopify Payments/ })
    .selectOption("DEDUCT");
  await page
    .getByRole("button", {
      name: "Salva regola commissioni Shopify Payments",
    })
    .click();
  await expect(page.getByRole("combobox", { name: /^Commissioni Shopify Payments/ })).toHaveValue(
    "DEDUCT",
  );
  await expectPlainLanguage(page);
  await page.getByRole("link", { name: "Ordini", exact: true }).click();
  await page.getByLabel(/^Pagamento/).selectOption("PENDING");
  await page.getByRole("button", { name: "Filtra" }).click();
  await expect(page.getByRole("row")).toHaveCount(2);
  await expect(page.getByLabel(/^Pagamento/)).toHaveValue("PENDING");
  await page.getByRole("link", { name: /^Apri preparazione fattura \d{6}$/ }).click();

  // Il terzo pool dichiara il pagamento come causa primaria, anche se restano controlli secondari.
  await expect(page.getByRole("heading", { name: "Cose da controllare" })).toBeVisible();
  await expect(page.getByText("Pagamento non ancora acquisito")).toBeVisible();
  await expect(page.getByRole("status")).toContainText(
    "passerà automaticamente fra le approvabili o nei controlli quando il pagamento sarà acquisito",
  );
  await expect(page.getByRole("button", { name: "Approva fattura" })).toHaveCount(0);

  // La correzione dei dati cliente si chiude direttamente dall'applicazione.
  const recipientDisclosure = page
    .locator("details.preparation-disclosure")
    .filter({ hasText: "Dati del destinatario" });
  await expect(recipientDisclosure).toHaveAttribute("open", "");
  await expect(page.getByLabel("Cognome")).toBeVisible();
  await page.getByLabel("Cognome").fill("Rossi Verificato");
  await expect(page.getByRole("group", { name: "Cliente" })).toBeVisible();
  await expect(page.getByRole("group", { name: "Indirizzo di fatturazione" })).toBeVisible();
  await expect(page.getByRole("group", { name: "Dati fiscali" })).toBeVisible();
  await expectVisibleFieldsetTitlesInside(page);
  await page.getByLabel("Motivo della correzione").fill("Dati confermati dal cliente");
  await page.getByRole("button", { name: "Salva dati cliente" }).click();
  await expect(page.getByText("Anagrafica cliente corretta")).toBeVisible();
  await expect(page.getByText(/^Corretta il /)).toBeVisible();

  // Un aggiornamento arrivato dopo la preparazione deve mostrare le differenze e offrire
  // un modo esplicito per chiudere soltanto quel controllo.
  const sourceReviewCaseId = new URL(page.url()).pathname.split("/").at(-1)!;
  const sourceReviewClient = new pg.Client({ connectionString: databaseUrl });
  await sourceReviewClient.connect();
  await sourceReviewClient.query(
    `WITH target_order AS (
       SELECT id, normalized_snapshot_json
       FROM orders
       WHERE billing_case_id = $1
       ORDER BY id
       LIMIT 1
     )
     INSERT INTO order_source_revisions
       (order_id, billing_case_id, previous_normalized_snapshot_json,
        current_normalized_snapshot_json)
     SELECT id, $1,
            jsonb_set(
              jsonb_set(
                jsonb_set(
                  jsonb_set(
                    normalized_snapshot_json,
                    '{customerSnapshot,displayName}',
                    '"Cliente precedente"'::jsonb
                  ),
                  '{customerSnapshot,certifiedEmail}',
                  '"vecchia-pec@example.invalid"'::jsonb
                ),
                '{customerSnapshot,shippingAddress,line1}',
                '"Via spedizione precedente 4"'::jsonb
              ),
              '{shippingAmount}',
              '100'::jsonb
            ),
            normalized_snapshot_json
     FROM target_order`,
    [sourceReviewCaseId],
  );
  await sourceReviewClient.query(
    `UPDATE orders
     SET trigger_status = 'NEEDS_REVIEW',
         normalized_snapshot_json = jsonb_set(
           normalized_snapshot_json, '{sourceConflictRequired}', 'true'::jsonb)
     WHERE billing_case_id = $1`,
    [sourceReviewCaseId],
  );
  await sourceReviewClient.query(
    `UPDATE billing_cases
     SET status = 'NEEDS_REVIEW', revision = revision + 1, updated_at = now()
     WHERE id = $1`,
    [sourceReviewCaseId],
  );
  await sourceReviewClient.end();
  await page.reload();
  await expect(page.getByText("L’ordine è cambiato dopo la preparazione")).toBeVisible();
  await expect(page.getByRole("columnheader", { name: "Prima" })).toBeVisible();
  await expect(page.getByRole("columnheader", { name: "Adesso" })).toBeVisible();
  await expect(page.getByRole("cell", { name: "Cliente precedente" })).toBeVisible();
  await expect(page.getByRole("cell", { name: "vecchia-pec@example.invalid" })).toBeVisible();
  await expect(page.getByRole("cell", { name: /Via spedizione precedente 4/ })).toBeVisible();
  await expect(page.getByRole("row", { name: /Spese di spedizione 1,00/ })).toBeVisible();
  const firstSourceChange = page.locator(".source-changes-table tbody tr").first();
  const firstSourceChangeAscending = await firstSourceChange.innerText();
  await page
    .getByRole("button", {
      name: "Dato: ordine crescente. Attiva per ordinare in senso decrescente",
    })
    .click();
  await expect(firstSourceChange).not.toHaveText(firstSourceChangeAscending);
  await page
    .getByRole("checkbox", {
      name: "Confermo di avere confrontato gli aggiornamenti ricevuti con la preparazione corrente.",
    })
    .check();
  await page.getByRole("button", { name: "Segna gli aggiornamenti come verificati" }).click();
  await expect(page.getByText("Aggiornamento dell’ordine verificato")).toBeVisible();
  await expect(page.getByText("L’ordine è cambiato dopo la preparazione")).toHaveCount(0);
  // Il pagamento pendente è indipendente e deve continuare a bloccare la preparazione.
  await expect(page.getByText("Pagamento non ancora acquisito")).toBeVisible();

  const privacyClient = new pg.Client({ connectionString: databaseUrl });
  await privacyClient.connect();
  await privacyClient.query(
    `INSERT INTO webhook_events
       (provider, external_event_id, topic, payload_sha256, request_payload_json, status)
     VALUES ('SHOPIFY', 'privacy-readiness-request', 'CUSTOMERS_DATA_REQUEST', $1,
       '{"customerIds":["gid://shopify/Customer/2001"],"orderIds":["gid://shopify/Order/1001"]}',
       'PENDING')`,
    ["a".repeat(64)],
  );
  await privacyClient.query(
    `UPDATE orders
     SET trigger_status = 'NEEDS_REVIEW',
         normalized_snapshot_json = jsonb_set(
           normalized_snapshot_json, '{sourceConflictRequired}', 'true'::jsonb)
     WHERE billing_case_id = $1`,
    [sourceReviewCaseId],
  );
  const manualChoiceStorageId = (
    await privacyClient.query<{ id: string }>(
      `INSERT INTO storage_objects (kind, relative_path, sha256, size_bytes, content_type)
       VALUES ('ARUBA_XML', 'e2e/manual-choice.xml', repeat('8', 64), 10,
               'application/xml') RETURNING id`,
    )
  ).rows[0]!.id;
  const manualChoiceRemoteId = (
    await privacyClient.query<{ id: string }>(
      `INSERT INTO aruba_remote_documents
        (environment, account_reference, remote_id, document_type, fiscal_year,
         document_date, total_amount, remote_status, remote_status_observed_at,
         metadata_digest, xml_sha256)
       VALUES ('MOCK', 'synthetic-aruba-account', 'e2e-manual-choice', 'TD01', 2026,
         '2026-08-20', 1000, 'DELIVERED', now(), repeat('9', 64), repeat('8', 64))
       RETURNING id`,
    )
  ).rows[0]!.id;
  await privacyClient.query(
    `INSERT INTO aruba_files (remote_document_id, storage_object_id, kind)
     VALUES ($1, $2, 'ARUBA_XML')`,
    [manualChoiceRemoteId, manualChoiceStorageId],
  );
  await privacyClient.query(
    `INSERT INTO aruba_document_matches
      (remote_document_id, status, method, matcher_version, candidates_json)
     SELECT $1, 'UNMATCHED', 'NONE', 1,
            jsonb_build_array(jsonb_build_object(
              'candidateId', orders.id::text, 'orderIds', jsonb_build_array(orders.id::text),
              'potential', false, 'reviewable', false, 'compatible', false,
              'signals', jsonb_build_object('provider', true, 'nearDate', true,
                'recipient', true, 'total', false)
            ))
     FROM orders WHERE billing_case_id = $2 ORDER BY id LIMIT 1`,
    [manualChoiceRemoteId, sourceReviewCaseId],
  );
  const orderReference = (
    await privacyClient.query<{ reference: string }>(
      `SELECT orders.display_number || ' ' ||
                CASE orders.provider WHEN 'SHOPIFY' THEN 'Shopify' ELSE 'eBay' END AS reference
       FROM orders
       WHERE orders.billing_case_id = $1
       ORDER BY orders.id
       LIMIT 1`,
      [sourceReviewCaseId],
    )
  ).rows[0]!.reference;
  await privacyClient.end();
  await refreshOperationalControlsProjection();
  await page.getByRole("link", { name: "Controlli" }).click();
  await expect(page.getByRole("heading", { name: "Controlli", exact: true })).toBeVisible();
  await expect(page.locator(".controls-queue")).toContainText("Richiesta dati cliente");
  await expect(
    page.locator(`.control-row[data-control-id="ARUBA_REMOTE:${manualChoiceRemoteId}"]`),
  ).toContainText(orderReference);
  const controlsOverviewLayout = await page.locator(".controls-overview").evaluate((overview) => {
    const navigation = overview.querySelector<HTMLElement>(".view-nav")!;
    const summary = overview.querySelector<HTMLElement>(".controls-severity-summary")!;
    const introduction = document.querySelector<HTMLElement>(".controls-title p:last-child")!;
    const lastSummaryItem = summary.lastElementChild as HTMLElement;
    const navigationBox = navigation.getBoundingClientRect();
    const summaryBox = summary.getBoundingClientRect();
    return {
      compactSummary:
        Math.abs(summaryBox.right - lastSummaryItem.getBoundingClientRect().right) <= 1,
      aligned:
        Math.abs(
          navigationBox.top + navigationBox.height / 2 - (summaryBox.top + summaryBox.height / 2),
        ) <= 1,
      introductionGap:
        Math.min(navigationBox.top, summaryBox.top) - introduction.getBoundingClientRect().bottom,
      matchingHeight: Math.abs(navigationBox.height - summaryBox.height) <= 1,
      sameRow: navigationBox.right + 12 <= summaryBox.left,
      summaryHeight: summaryBox.height,
    };
  });
  expect(controlsOverviewLayout).toMatchObject({
    compactSummary: true,
    aligned: true,
    introductionGap: expect.any(Number),
    matchingHeight: true,
    sameRow: true,
  });
  expect(controlsOverviewLayout.summaryHeight).toBeCloseTo(44, 3);
  expect(controlsOverviewLayout.introductionGap).toBeGreaterThanOrEqual(12);
  const selectedControlDecoration = await page
    .locator(".control-row--selected")
    .evaluate((row) => ({
      leadingDecoration: getComputedStyle(row, "::before").content,
      selectionShadow: getComputedStyle(row).boxShadow,
    }));
  expect(selectedControlDecoration).toEqual({
    leadingDecoration: "none",
    selectionShadow: "none",
  });
  const filtersButtonFits = await page
    .locator(".controls-filters button")
    .evaluate((applyFilters) => applyFilters.scrollWidth <= applyFilters.clientWidth);
  expect(filtersButtonFits).toBe(true);
  await expect(page.getByRole("searchbox", { name: "Cerca" })).toBeVisible();
  await expect(page.getByText("controlli trovati")).toBeVisible();
  await page.getByLabel("Motivo dell’attesa").selectOption("PROVIDER");
  await page.getByLabel("Assegnato a").selectOption("Codex");
  await page.getByRole("button", { name: "Sposta in attesa" }).click();
  await expect(page).toHaveURL(/\/controlli\?vista=attesa/);
  await expect(page.getByText("Risposta del fornitore")).toBeVisible();
  await expect(
    page.locator(".control-waiting-facts").getByText("Codex", { exact: true }),
  ).toBeVisible();
  await expectDesktopContentOutsideSidebar(page);
  await page.getByRole("button", { name: "Riporta da risolvere" }).click();
  await expect(page.getByRole("status")).toContainText("di nuovo nella coda da risolvere");
  await page.goto(`/controlli?id=ARUBA_REMOTE%3A${manualChoiceRemoteId}`);
  await expect(page.getByRole("button", { name: "Collega come fattura già emessa" })).toBeVisible();
  await expect(page.getByLabel("Motivo della differenza")).toBeVisible();
  await expect(
    page.getByRole("checkbox", {
      name: "Confermo che il documento Aruba appartiene all’ordine e che la differenza deve restare registrata",
    }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Nessun candidato è corretto" })).toBeVisible();
  await expect(
    page.getByRole("checkbox", {
      name: "Confermo di avere confrontato il documento Aruba con tutti i candidati proposti",
    }),
  ).toBeVisible();
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 780 });
    await expectViewportFits(page);
    const dueDateContainment = await page.getByLabel("Scadenza").evaluate((input) => {
      const inputBox = input.getBoundingClientRect();
      const fieldBox = input.closest("label")!.getBoundingClientRect();
      const formBox = input.closest("form")!.getBoundingClientRect();
      return {
        insideField: inputBox.left >= fieldBox.left && inputBox.right <= fieldBox.right,
        insideForm: inputBox.left >= formBox.left && inputBox.right <= formBox.right,
      };
    });
    expect(dueDateContainment).toEqual({ insideField: true, insideForm: true });
  }
  await expect(page.getByRole("button", { name: "Collega come fattura già emessa" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Nessun candidato è corretto" })).toBeVisible();
  const manualChoiceCleanup = new pg.Client({ connectionString: databaseUrl });
  await manualChoiceCleanup.connect();
  await manualChoiceCleanup.query("DELETE FROM operational_controls WHERE source_id = $1", [
    manualChoiceRemoteId,
  ]);
  await manualChoiceCleanup.query("DELETE FROM aruba_files WHERE remote_document_id = $1", [
    manualChoiceRemoteId,
  ]);
  await manualChoiceCleanup.query("DELETE FROM aruba_remote_documents WHERE id = $1", [
    manualChoiceRemoteId,
  ]);
  await manualChoiceCleanup.query("DELETE FROM storage_objects WHERE id = $1", [
    manualChoiceStorageId,
  ]);
  await manualChoiceCleanup.end();
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto("/controlli");
  await page.evaluate(() => window.scrollTo(0, 260));
  const privacyControl = page.locator(".control-row").filter({ hasText: "Richiesta dati cliente" });
  await privacyControl.scrollIntoViewIfNeeded();
  const controlsScrollBeforeSelection = await page.evaluate(() => window.scrollY);
  await privacyControl.click();
  await expect
    .poll(async () =>
      Math.abs((await page.evaluate(() => window.scrollY)) - controlsScrollBeforeSelection),
    )
    .toBeLessThanOrEqual(12);
  await expect(page.locator(".control-detail")).toContainText("gid://shopify/Customer/2001");
  await expect(page.locator(".control-detail")).toContainText("gid://shopify/Order/1001");
  await expect(page.locator(".controls-queue")).toBeVisible();
  expect(
    await page
      .locator(".controls-workspace")
      .evaluate((workspace) => getComputedStyle(workspace).gridTemplateColumns.split(" ").length),
  ).toBe(2);
  await page.setViewportSize({ width: 320, height: 780 });
  const backToControls = page.getByRole("button", { name: "Torna ai controlli" });
  await expect(backToControls).toBeVisible();
  await expect(page.locator(".controls-queue")).toBeHidden();
  await expect(page.locator("#control-detail-title")).toBeInViewport();
  await backToControls.click();
  await expect(page).toHaveURL(/\/controlli$/);
  await expect(page.locator(".controls-queue")).toBeVisible();
  await expect(page.locator(".control-detail")).toBeHidden();
  const preparationControl = page
    .locator(".control-row")
    .filter({ hasText: "Ordine aggiornato dopo la preparazione" });
  await preparationControl.scrollIntoViewIfNeeded();
  const mobileScrollBeforeSelection = await page.evaluate(() => window.scrollY);
  // Il click DOM evita l'auto-scroll di Playwright: qui il contratto da verificare
  // è la posizione che l'utente aveva prima di toccare una riga già visibile.
  await preparationControl.evaluate((row) => (row as HTMLElement).click());
  await expect(page.locator(".controls-queue")).toBeHidden();
  await expect(page.locator("#control-detail-title")).toHaveText(
    "Ordine aggiornato dopo la preparazione",
  );
  await expect(page.locator("#control-detail-title")).toBeFocused();
  await expect(page.locator("#control-detail-title")).toBeInViewport();
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  await backToControls.click();
  await expect(page.locator(".controls-queue")).toBeVisible();
  await expect(preparationControl).toBeFocused();
  await expect
    .poll(async () =>
      Math.abs((await page.evaluate(() => window.scrollY)) - mobileScrollBeforeSelection),
    )
    .toBeLessThanOrEqual(16);
  const mobilePrivacyControl = page
    .locator(".control-row")
    .filter({ hasText: "Richiesta dati cliente" });
  await mobilePrivacyControl.evaluate((row) => row.scrollIntoView({ block: "nearest" }));
  const mobileScrollBeforeReturn = await page.evaluate(() => window.scrollY);
  await mobilePrivacyControl.evaluate((row) => (row as HTMLElement).click());
  await expect(page.locator(".controls-queue")).toBeHidden();
  await expect(page.locator("#control-detail-title")).toBeFocused();
  await backToControls.click();
  await expect(mobilePrivacyControl).toBeFocused();
  await expect
    .poll(async () =>
      Math.abs((await page.evaluate(() => window.scrollY)) - mobileScrollBeforeReturn),
    )
    .toBeLessThanOrEqual(16);
  await page.goto(
    "/controlli?tipo=SHOPIFY_PRIVACY_REQUEST&id=SHOPIFY_PRIVACY%3Aprivacy-readiness-request",
  );
  await expect(page.locator(".controls-queue")).toBeHidden();
  await expect(page.locator("#control-detail-title")).toHaveText(
    "Richiesta dati cliente da completare",
  );
  await expect(page.locator("#control-detail-title")).toBeFocused();
  await backToControls.click();
  await expect(page).toHaveURL(/\/controlli\?tipo=SHOPIFY_PRIVACY_REQUEST$/);
  await expect(page.locator(".controls-queue")).toBeVisible();
  await expect(page.locator(".control-detail")).toBeHidden();
  const resolvedPreparationClient = new pg.Client({ connectionString: databaseUrl });
  await resolvedPreparationClient.connect();
  await resolvedPreparationClient.query(
    "UPDATE orders SET trigger_status = 'GROUPED' WHERE billing_case_id = $1",
    [sourceReviewCaseId],
  );
  await resolvedPreparationClient.end();
  await page.setViewportSize({ width: 1280, height: 720 });
  await page
    .getByRole("checkbox", {
      name: "Confermo di avere evaso la richiesta privacy",
    })
    .check();
  await page.getByRole("button", { name: "Conferma completamento" }).click();
  await expect(page.getByRole("status")).toContainText("Azione completata");
  await expect(page).toHaveURL(/\/controlli\?tipo=SHOPIFY_PRIVACY_REQUEST&esito=completato$/);
  await expect(page.getByRole("heading", { name: "Nessun controllo da risolvere" })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expectViewportFits(page);
  await page.getByRole("button", { name: "Apri il menu di navigazione" }).click();
  await page
    .getByRole("dialog", { name: "Navigazione principale" })
    .getByRole("link", { name: "Attività", exact: true })
    .click();
  await expect(page.getByRole("heading", { name: "Registro attività" })).toBeVisible();
  await page.getByLabel("Tipo di attività").selectOption("CUSTOMER_CORRECTED");
  await page.getByRole("button", { name: "Filtra" }).click();
  // Il filtro applica davvero l'azione scelta e l'audit distingue i due account.
  await expect(page.getByRole("row")).toHaveCount(2);
  await expect(page.getByRole("cell", { name: "Anagrafica cliente corretta" })).toBeVisible();
  await expect(page.locator('td[data-label="Autore"]')).toHaveText(/Codex$/);
  await expect(page.getByRole("link", { name: /^Preparazione fattura \d{6}$/ })).toBeVisible();
  await expect(page.getByText(/^Motivo: Dati confermati dal cliente$/)).toBeVisible();

  await page.setViewportSize({ width: 320, height: 720 });
  await expect(page.locator(".table-wrap--history tr").first()).toBeVisible();
  expect(
    await page
      .locator(".table-wrap--history tr")
      .first()
      .evaluate((row) => row.getBoundingClientRect().height),
  ).toBeLessThan(240);
  const mobileMenuTrigger = page.getByRole("button", {
    name: "Apri il menu di navigazione",
  });
  const mobileMenu = page.getByRole("dialog", {
    name: "Navigazione principale",
  });
  await mobileMenuTrigger.click();
  await mobileMenu.getByRole("link", { name: "Clienti", exact: true }).click();
  await expect(page.locator(".customer-table tbody tr").first()).toBeVisible();
  await expect(mobileMenu).not.toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    ),
  ).toBe(true);
  await mobileMenuTrigger.click();
  await expect(mobileMenu.getByRole("link", { name: "Clienti", exact: true })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await mobileMenu.getByRole("link", { name: "Ordini", exact: true }).click();
  await expect(page.locator("tbody tr").first()).toBeVisible();
  const mobileOrderRow = page.locator(".orders-table tbody tr").first();
  await expect(mobileOrderRow).toHaveCSS("display", "grid");
  expect(await mobileOrderRow.evaluate((row) => row.getBoundingClientRect().height)).toBeLessThan(
    380,
  );
  expect(
    await mobileOrderRow.evaluate((row) => {
      const action = row.querySelector<HTMLElement>(".orders-table__action a");
      return action ? row.getBoundingClientRect().right - action.getBoundingClientRect().right : 0;
    }),
  ).toBeGreaterThanOrEqual(12);
  const viewportFits = await page.evaluate(
    () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
  );
  expect(viewportFits).toBe(true);
  await page.goto("/ordini?vista=annullati");
  const activeView = page.locator('.view-nav__item[aria-current="page"]');
  await expect(activeView).toBeVisible();
  expect(
    await activeView.evaluate((item) => item.getBoundingClientRect().left),
  ).toBeGreaterThanOrEqual(0);
  expect(
    await activeView.evaluate((item) => item.getBoundingClientRect().right),
  ).toBeLessThanOrEqual(320);

  await mobileMenuTrigger.click();
  await expect(mobileMenu.getByRole("link")).toHaveCount(7);
  await mobileMenu.getByRole("link", { name: "Impostazioni", exact: true }).click();
  const sectionPicker = page.getByLabel("Vai alla sezione");
  await expect(sectionPicker).toBeVisible();
  await sectionPicker.selectOption("sistema");
  await expect(page.getByRole("heading", { name: "Dettagli tecnici" })).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    ),
  ).toBe(true);

  await page.setViewportSize({ width: 1280, height: 720 });
  await page.getByLabel("Apri il menu di Codex").click();
  await page.locator(".profile-menu").getByRole("button", { name: "Esci" }).click();
  await expect(page).toHaveURL(/\/login$/);
  await page.getByLabel("Nome utente", { exact: true }).fill("MASSIMO");
  await page.getByLabel("Password").fill("password-massimo");
  await page.getByRole("button", { name: "Accedi" }).click();
  const preparationLayoutClient = new pg.Client({
    connectionString: databaseUrl,
  });
  await preparationLayoutClient.connect();
  await preparationLayoutClient.query(
    `UPDATE aruba_sync_runs
     SET completed_at = now() - interval '2 hours',
         full_scan_completed_at = now() - interval '2 hours'
     WHERE environment = 'MOCK'
       AND account_reference = 'synthetic-aruba-account'
       AND completed_at IS NOT NULL`,
  );
  await preparationLayoutClient.end();
  await page.getByRole("link", { name: "Ordini", exact: true }).click();
  await page.getByRole("link", { name: "Da fatturare" }).click();
  await expectPreparationOrderReference(page);
  await page
    .getByRole("link", { name: `Apri ${archivedPreparation}` })
    .first()
    .click();
  await expect(page.getByRole("heading", { name: "Controllo fattura" })).toBeVisible();
  await expect(page.getByText("Nessun problema rilevato")).toBeVisible();
  await expect(page.getByText("RF14 · N5 · FPR · versione 1").first()).toBeVisible();
  await expect(page.getByRole("table", { name: "Destinatario" })).toHaveCount(0);
  await page.getByText("Mostra confronto fiscale completo").click();
  await expect(page.getByRole("table", { name: "Destinatario" })).toContainText("Origine");
  await expect(page.getByRole("table", { name: "Righe" })).toContainText("Proiezione XML");
  await expect(page.getByRole("table", { name: "Pagamento" })).toContainText("TP02 · MP08");
  await expect(page.getByRole("table", { name: "Dati tecnici e fiscali" })).toContainText(
    "TD01 · FPR12 · FPR",
  );
  await expect(page.getByText("Modifica dati fattura")).toBeVisible();
  const openPreparationDisclosures = page.locator("details.preparation-disclosure[open]");
  await expect(openPreparationDisclosures).toHaveCount(2);
  await expect(page.getByRole("button", { name: "Salva modifiche" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Salva modifiche" })).toBeDisabled();
  await page.getByText("Mostra XML tecnico", { exact: true }).click();
  const preparationId = new URL(page.url()).pathname.split("/").at(-1)!;
  const compactLayoutClient = new pg.Client({
    connectionString: databaseUrl,
  });
  await compactLayoutClient.connect();
  await compactLayoutClient.query(
    `UPDATE billing_cases SET status = 'NEEDS_REVIEW' WHERE id = $1`,
    [preparationId],
  );
  await page.reload();
  await page.setViewportSize({ width: 1280, height: 800 });
  const workflowGrid = page.locator(".preparation-workflow-grid");
  const compactWorkflowColumns = await workflowGrid.evaluate((element) =>
    getComputedStyle(element).gridTemplateColumns.split(" ").filter(Boolean),
  );
  expect(compactWorkflowColumns).toHaveLength(2);
  const workflowBox = await workflowGrid.boundingBox();
  const inventoryBox = await page.locator(".preparation-inventory").boundingBox();
  const activityBox = await page.locator(".preparation-activity").boundingBox();
  const approvalBox = await page.locator(".preparation-approval").boundingBox();
  expect(workflowBox).not.toBeNull();
  expect(inventoryBox).not.toBeNull();
  expect(activityBox).not.toBeNull();
  expect(approvalBox).not.toBeNull();
  expect(Math.abs(inventoryBox!.y - approvalBox!.y)).toBeLessThanOrEqual(2);
  expect(Math.abs(inventoryBox!.height - approvalBox!.height)).toBeLessThanOrEqual(2);
  expect(Math.abs(activityBox!.width - workflowBox!.width)).toBeLessThanOrEqual(2);
  expect(activityBox!.y).toBeGreaterThanOrEqual(
    Math.max(inventoryBox!.y + inventoryBox!.height, approvalBox!.y + approvalBox!.height),
  );
  const activityDates = await page
    .locator(".preparation-activity__timeline time")
    .evaluateAll((dates) => dates.map((item) => item.getBoundingClientRect().right));
  expect(activityDates.length).toBeGreaterThan(1);
  expect(Math.max(...activityDates) - Math.min(...activityDates)).toBeLessThanOrEqual(1);
  await compactLayoutClient.query(`UPDATE billing_cases SET status = 'READY' WHERE id = $1`, [
    preparationId,
  ]);
  await compactLayoutClient.end();
  await page.reload();
  const expandedWorkflowColumns = await workflowGrid.evaluate((element) =>
    getComputedStyle(element).gridTemplateColumns.split(" ").filter(Boolean),
  );
  expect(expandedWorkflowColumns).toHaveLength(1);
  const expandedWorkflowBox = await workflowGrid.boundingBox();
  const expandedInventoryBox = await page.locator(".preparation-inventory").boundingBox();
  const expandedApprovalBox = await page.locator(".preparation-approval").boundingBox();
  expect(expandedWorkflowBox).not.toBeNull();
  expect(expandedInventoryBox).not.toBeNull();
  expect(expandedApprovalBox).not.toBeNull();
  expect(Math.abs(expandedInventoryBox!.width - expandedWorkflowBox!.width)).toBeLessThanOrEqual(2);
  expect(Math.abs(expandedApprovalBox!.width - expandedWorkflowBox!.width)).toBeLessThanOrEqual(2);
  for (const width of [1280, 900, 320]) {
    await page.setViewportSize({ width, height: width === 320 ? 780 : 800 });
    await expectViewportFits(page);
    await expectVisibleFieldsetTitlesInside(page);
    await expectApprovalLabelsReadable(page);
    await expect(page.getByRole("button", { name: "Approva fattura" })).toBeVisible();
  }
  const mobileWorkflowColumns = await workflowGrid.evaluate((element) =>
    getComputedStyle(element).gridTemplateColumns.split(" ").filter(Boolean),
  );
  expect(mobileWorkflowColumns).toHaveLength(1);
  await page.setViewportSize({ width: 1280, height: 720 });
  await expect(page.getByRole("group", { name: "Conferma finale" })).toContainText(
    "prossimo numero fiscale disponibile",
  );
  await expect(page.locator('input[name="confirmApproval"]')).toHaveCount(0);
  const approvalResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" && response.url().includes("/ordini/preparazione/"),
  );
  await page.getByRole("button", { name: "Approva fattura" }).click();
  if ((await approvalResponse).status() >= 400) {
    await page.getByRole("alert").waitFor();
    throw new Error((await page.getByRole("alert").textContent()) ?? "Approvazione non riuscita");
  }
  await expect(page.getByRole("button", { name: "Approva fattura" })).toHaveCount(0);
  await page.getByRole("link", { name: "Documenti", exact: true }).click();
  const approvedDocument = page.locator(".document-row").filter({ hasText: "Approvato" }).first();
  await expect(approvedDocument).toBeVisible();
  await approvedDocument.locator(".document-row__tools > summary").click();
  const xmlLink = approvedDocument.getByRole("link", { name: "Scarica XML" });
  const xmlHref = await xmlLink.getAttribute("href");
  expect(xmlHref).toMatch(/^\/documenti\/\d+\/xml$/);
  const xmlDownload = await page.request.get(xmlHref!);
  expect(xmlDownload.ok()).toBe(true);
  expect(xmlDownload.headers()["content-disposition"]).toMatch(
    /^attachment; filename="fattura-\d+\.xml"$/,
  );
  expect(xmlDownload.headers()["content-type"]).toContain("application/xml");
  expect((await xmlDownload.body()).subarray(0, 5).toString()).toBe("<?xml");

  await expect(
    page
      .locator(".document-batch-list")
      .getByText("Solo documento; nessuna trasmissione pianificata", {
        exact: true,
      })
      .first(),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Genera codice di avvio" })).toHaveCount(0);
  const outboundBatchClient = new pg.Client({
    connectionString: databaseUrl,
  });
  await outboundBatchClient.connect();
  const outboundBatch = await outboundBatchClient.query<{
    mode: string;
    transport: string;
    status: string;
  }>(
    `SELECT mode, transport, status
     FROM aruba_batches
     ORDER BY created_at DESC, id DESC
     LIMIT 1`,
  );
  await outboundBatchClient.end();
  expect(outboundBatch.rows[0]).toEqual({
    mode: "DOCUMENT_ONLY",
    transport: "API",
    status: "DOCUMENT_ONLY",
  });

  await page.getByRole("link", { name: "Impostazioni" }).click();
  const arubaSettings = page.locator("#aruba");
  const credentialForm = await verifyUnconfiguredArubaApiUi(page, arubaSettings);

  await verifyConfiguredArubaApiUi(page, arubaSettings, credentialForm);

  await verifyHistoricalAndCreditNoteFlow(page);
});
