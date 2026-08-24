import { expect, test, type Page } from "@playwright/test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import pg from "pg";

import { runHelper } from "../../scripts/aruba-helper.ts";
import { SESSION_TTL_SECONDS } from "../../src/config.server.ts";

const databaseUrl =
  process.env.TEST_DATABASE_URL ??
  "postgres://hub_fatture:hub_fatture_test@127.0.0.1:5433/hub_fatture_test";
const appBaseUrl = process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:4173";
const storageRoot = path.resolve("storage/e2e-documents");

async function expectPlainLanguage(page: Page) {
  await expect(page.locator("body")).not.toContainText(
    /\b(?:trigger|fixture|sandbox)\b|sorgente|normalizzat/i,
  );
}

async function expectViewportFits(page: Page) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    ),
  ).toBe(true);
}

// Lo schema viene azzerato all'avvio del server, i dati a ogni worker: un retry riparte
// da database vuoto invece di trovare gli account già creati e saltare il flusso di setup.
test.beforeAll(async () => {
  if (!new URL(databaseUrl).pathname.endsWith("_test")) throw new Error("Database E2E non isolato");
  await rm(storageRoot, { recursive: true, force: true });
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  await client.query(
    "TRUNCATE users, sessions, login_attempts, audit_events, settings, customers, billing_cases, orders, fiscal_profiles RESTART IDENTITY CASCADE",
  );
  const profile = JSON.parse(await readFile("tests/fixtures/fatturapa/profile.mock.json", "utf8"));
  await client.query(
    "INSERT INTO fiscal_profiles (version, status, profile_json) VALUES (1, 'MOCK', $1)",
    [profile],
  );
  await client.query(
    `INSERT INTO settings (key, value_json) VALUES
       ('draft_trigger', '"PAID"'),
       ('aruba_mode', '"ASSISTED"'),
       ('shopify_payment_fee_mode', '"DEDUCT"'),
       ('customer_email_mode', '"AUTOMATIC"')
     ON CONFLICT (key) DO UPDATE SET value_json = EXCLUDED.value_json, version = 1`,
  );
  await client.end();
});

test.afterAll(async () => {
  await rm(storageRoot, { recursive: true, force: true });
});

// I test condividono gli account creati dal primo: in serie un retry li ripete tutti dall'inizio.
test.describe.configure({ mode: "serial" });

test("configura i due account e accede con entrambi", async ({ page, browserName }) => {
  test.setTimeout(240_000);
  await page.goto("/setup");
  await page.setViewportSize({ width: 320, height: 780 });
  await page.getByLabel("Codice di configurazione").fill("codice-di-configurazione-errato");
  await page.getByLabel("Password per Massimo").fill("password-massimo");
  await page.getByLabel("Password per Codex").fill("password-codex");
  await page.getByRole("button", { name: "Crea gli account" }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await expectViewportFits(page);
  await page.getByLabel("Codice di configurazione").fill("synthetic-bootstrap-token-for-tests");
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
  await expect(page.getByText("Note di credito da approvare")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Da fare ora" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Stato operativo" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Collegamenti" })).toBeVisible();
  await expect(page.locator(".work-item")).toHaveCount(4);
  const dashboardDestinations = [
    ["Preparazioni pronte", "/ordini?vista=fatturare", "Ordini"],
    ["Da verificare", "/ordini?vista=verificare", "Ordini"],
    ["Pagamenti in attesa", "/ordini?pagamento=PENDING", "Ordini"],
    ["Note di credito da approvare", "/attivita?tipo=note-credito", "Attività"],
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
  await expect(page.locator(".documents-chart__day")).toHaveCount(7);
  await page.getByRole("link", { name: "Documenti", exact: true }).click();
  await expect(page.getByRole("link", { name: "Vai agli ordini" })).toBeVisible();
  await page.getByRole("link", { name: "Attività", exact: true }).click();
  await expect(page.getByRole("link", { name: "Apri la cronologia" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Controlla le connessioni" })).toBeVisible();
  await page.getByRole("link", { name: "Dashboard", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
  const skipLink = page.getByRole("link", { name: "Vai al contenuto principale" });
  await skipLink.focus();
  await expect(skipLink).toBeVisible();
  await expectPlainLanguage(page);

  const sidebar = page.locator(".sidebar");
  const appMain = page.locator(".app-main");
  const brandName = sidebar.locator(".brand-lockup__name");
  const collapseSidebar = page.getByRole("button", { name: "Comprimi navigazione" });
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
  const expandSidebar = page.getByRole("button", { name: "Espandi navigazione" });
  await expandSidebar.click();
  const brandTransitionFrames = await brandName.evaluate(async (element) => {
    const frames: Array<{ height: number; lineHeight: number; opacity: number }> = [];
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
  // I token risolvono con `light-dark()`: l'attributo da solo non prova che il tema cambi.
  expect(await background()).not.toBe(lightBackground);

  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  expect(await background()).not.toBe(lightBackground);
  await page.getByLabel("Apri il menu di Massimo").click();
  await expect(page.locator(".profile-menu__identity")).toContainText("Massimo");
  await expect(page.locator(".profile-menu__identity")).toContainText("Titolare");
  await expect(page.locator(".profile-menu__permission")).toContainText(
    "Può approvare, numerare e autorizzare gli invii.",
  );
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
    page.getByRole("button", { name: "Salva regola di preparazione fattura" }),
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

  const denseSessionsClient = new pg.Client({ connectionString: databaseUrl });
  await denseSessionsClient.connect();
  await denseSessionsClient.query(
    `INSERT INTO sessions (id_hash, user_id, csrf_token_hash, expires_at, created_at, last_seen_at)
     SELECT 'dense-session-' || value,
            (SELECT id FROM users WHERE can_approve = true),
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
  const inboundMigration = page.getByText("033_support_safari_aruba_read_sync.sql", {
    exact: true,
  });
  await expect(inboundMigration).toBeVisible();
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
  const saveCustomerEmailMode = page.getByRole("button", { name: "Salva modalità e-mail" });
  await expect(saveCustomerEmailMode).toBeEnabled();
  await saveCustomerEmailMode.click();
  await expect(saveCustomerEmailMode).toBeDisabled();
  await expect(page.getByLabel("Modalità invio copia")).toHaveValue("AUTOMATIC");
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
  await expect(page.locator(".profile-menu__identity")).toContainText("Operatore");

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
  await page.getByLabel("Cerca ordini, fatture e clienti").fill("Mario Rossi");
  const searchDialog = page.getByRole("dialog", { name: "Ricerca globale" });
  await expect(searchDialog.getByRole("heading", { name: "Ordini" })).toBeVisible();
  await expect(searchDialog.getByRole("heading", { name: "Clienti" })).toBeVisible();
  await expect.poll(() => searchRequests.length).toBe(1);
  await page.waitForTimeout(500);
  expect(searchRequests).toHaveLength(1);
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
  await page.getByLabel("Cerca ordini, fatture e clienti").fill("nessun risultato possibile");
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
  const customerBackLink = page.getByRole("link", { name: "Torna ai clienti" });
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
  await page.getByRole("link", { name: "Da verificare", exact: true }).click();
  await expect(customerRows).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Nessun cliente da verificare" })).toBeVisible();

  await page.setViewportSize({ width: 320, height: 780 });
  const mobileMore = page.getByLabel("Apri altre sezioni");
  await expect(page.getByRole("link", { name: "Clienti", exact: true })).toBeVisible();
  await mobileMore.click();
  await expect(
    page.locator(".nav-more__menu").getByRole("link", { name: "Attività", exact: true }),
  ).toBeVisible();
  await expect(
    page.locator(".nav-more__menu").getByRole("link", { name: "Impostazioni", exact: true }),
  ).toBeVisible();
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
  expect([...new Set(controlHeights)]).toEqual([44]);
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
  await expect(page.getByRole("row")).toHaveCount(2);
  await expect(page.getByRole("cell", { name: "2", exact: true })).toBeVisible();
  await page.getByRole("link", { name: /^Apri preparazione fattura \d{6}$/ }).click();
  await expect(page.getByRole("heading", { name: /^Preparazione fattura \d{6}$/ })).toBeVisible();
  await expectPlainLanguage(page);
  await expect(page.getByText("Preparazione fattura creata")).toBeVisible();
  await expect(page.getByText("BILLING_CASE_CREATED")).toHaveCount(0);
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
  const archivedOrderFilters = page.getByRole("search", { name: "Filtra gli ordini" });
  await archivedOrderFilters.getByLabel("Cerca").fill("ordine-inesistente");
  await archivedOrderFilters.getByRole("button", { name: "Filtra" }).click();
  await expect(page.getByText("1 filtro attivo")).toBeVisible();
  await expect(page.getByRole("cell", { name: "Da non trasmettere", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Nessun ordine annullato" })).toBeVisible();
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
  await expect(page.getByText(/filtr[oi] attiv[oi]/)).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Azzera filtri" })).toHaveCount(0);
  await page.getByRole("link", { name: "Shopify #S-1002", exact: true }).click();
  await page.getByRole("button", { name: "Prepara la fattura ora" }).click();
  await expect(page.getByRole("heading", { name: /^Preparazione fattura \d{6}$/ })).toBeVisible();
  await expect(page.getByText("Preparazione anticipata richiesta")).toBeVisible();

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
  await expect(arubaConnection).toContainText("Mai letto");
  await expect(page.getByText("Aggiornamenti da completare", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Impostazioni" }).click();
  const arubaSync = page.locator(".aruba-sync-card");
  await expect(arubaSync.getByRole("heading", { name: "Aggiornamento necessario" })).toBeVisible();
  await expect(
    arubaSync.getByText(
      "L’inventario è vecchio o l’ultima lettura non è riuscita. Avvia una nuova sincronizzazione.",
    ),
  ).toBeVisible();
  await expect(arubaSync.getByRole("link", { name: "Apri Aruba" })).toHaveCount(0);
  await expect(arubaSync).toContainText("Solo il titolare può avviare la sincronizzazione Aruba.");
  await expect(page.getByText("Configura una volta il preferito")).toHaveCount(0);
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
    `INSERT INTO aruba_sync_sessions
       (id, environment, account_reference, device_id, token_hash, status,
        absolute_expires_at, completed_at, full_scan_completed_at, is_full_scan)
     VALUES
       ('00000000-0000-4000-8000-000000000072', 'MOCK', 'synthetic-aruba-account',
        'synthetic-device-readiness', repeat('6', 64), 'COMPLETED', now(), now(), now(), true)`,
  );
  await connectionClient.query(
    `INSERT INTO aruba_batches
       (id, environment, mode, account_reference, manifest_sha256, document_count, status,
        requires_reconciliation, created_by, last_readback_at)
     VALUES
       ('00000000-0000-4000-8000-000000000073', 'MOCK', 'ASSISTED', 'synthetic', $1, 1,
        'RECONCILIATION_REQUIRED', true, (SELECT id FROM users ORDER BY id LIMIT 1), now())`,
    ["7".repeat(64)],
  );
  await page.reload();
  await expect(arubaConnection).not.toContainText("Mai letto");
  await expect(page.getByText("Aggiornamenti da completare", { exact: true })).toBeVisible();
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
  expect(
    await page.locator(".connection-panel").evaluateAll((panels) => {
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
  ).toEqual({ alignedTops: true, heightDelta: 0, widthDelta: 0 });
  await page.getByLabel("Prepara la fattura").selectOption("FULFILLED");
  await page.getByRole("button", { name: "Salva regola di preparazione fattura" }).click();
  await expect(page.getByRole("status")).toContainText("Impostazione aggiornata");
  await page
    .getByRole("combobox", { name: /^Commissioni Shopify Payments/ })
    .selectOption("INCLUDE");
  await page.getByRole("button", { name: "Salva regola commissioni Shopify Payments" }).click();
  await expect(page.getByRole("status")).toContainText("Regola Shopify Payments aggiornata");
  await expect(page.getByRole("combobox", { name: /^Commissioni Shopify Payments/ })).toHaveValue(
    "INCLUDE",
  );
  await page
    .getByRole("combobox", { name: /^Commissioni Shopify Payments/ })
    .selectOption("DEDUCT");
  await page.getByRole("button", { name: "Salva regola commissioni Shopify Payments" }).click();
  await expect(page.getByRole("combobox", { name: /^Commissioni Shopify Payments/ })).toHaveValue(
    "DEDUCT",
  );
  await expectPlainLanguage(page);
  await page.getByRole("link", { name: "Ordini", exact: true }).click();
  await page.getByRole("link", { name: "Da verificare" }).click();
  await expect(page.getByRole("row")).toHaveCount(2);
  await expect(page.getByRole("cell", { name: "Da verificare", exact: true })).toBeVisible();
  await page.getByRole("link", { name: /^Apri preparazione fattura \d{6}$/ }).click();

  // Il controllo dichiara il fatto osservato, non una frase generica.
  await expect(page.getByRole("heading", { name: "Cose da controllare" })).toBeVisible();
  await expect(page.getByText("Pagamento non ancora acquisito")).toBeVisible();
  await expect(page.getByRole("status")).toContainText(
    "controlla i dati indicati come incompleti o modificati",
  );

  // La correzione dei dati cliente si chiude direttamente dall'applicazione.
  await page.getByLabel("Cognome").fill("Rossi Verificato");
  await expect(page.getByRole("group", { name: "Cliente" })).toBeVisible();
  await expect(page.getByRole("group", { name: "Indirizzo di fatturazione" })).toBeVisible();
  await expect(page.getByRole("group", { name: "Dati fiscali" })).toBeVisible();
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
    "UPDATE orders SET trigger_status = 'NEEDS_REVIEW' WHERE billing_case_id = $1",
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

  await page.getByRole("link", { name: "Attività" }).click();
  await expect(page.locator(".activity-overview")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Verifiche su ordini e documenti" }),
  ).toBeVisible();
  await expect(page.locator(".activity-table thead")).toContainText("Cliente");
  await expect(page.locator(".activity-table thead")).toContainText("Identificativo fiscale");
  await expect(page.locator(".activity-table thead")).toContainText("Canale / tipo");
  await expect(page.locator(".activity-table thead")).toContainText("Data ordine");
  await expect(page.locator(".activity-table thead")).toContainText("Ultimo aggiornamento");
  await expect(page.getByRole("link", { name: /^Preparazione \d{6}$/ })).toBeVisible();
  await expect(page.locator('td[data-label="Identificativo fiscale"]')).toContainText(
    "Non disponibile",
  );
  await page.setViewportSize({ width: 900, height: 800 });
  await expect(page.locator(".activity-table thead")).toHaveCSS("position", "static");
  await expect(page.locator(".activity-table tbody tr").first()).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    ),
  ).toBe(true);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator(".activity-table tbody tr").first()).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    ),
  ).toBe(true);
  expect(
    await page
      .locator('td[data-label="Identificativo fiscale"]')
      .first()
      .evaluate((cell) => {
        const value = cell.querySelector("strong");
        return value ? value.getBoundingClientRect().left - cell.getBoundingClientRect().left : 0;
      }),
  ).toBeGreaterThanOrEqual(150);
  expect(
    await page
      .locator(".activity-table tbody tr")
      .first()
      .evaluate((row) => row.getBoundingClientRect().height),
  ).toBeLessThan(380);
  await page.setViewportSize({ width: 1280, height: 720 });
  await expect(page.locator(".activity-table thead")).toHaveCSS("position", "static");
  expect(
    await page
      .locator(".activity-table .table-sort-button span")
      .evaluateAll((labels) =>
        labels.every(
          (label) =>
            getComputedStyle(label).textOverflow === "clip" &&
            label.scrollWidth <= label.clientWidth,
        ),
      ),
  ).toBe(true);
  const firstActivityRow = page.locator(".activity-table tbody tr").first();
  expect(
    await firstActivityRow.evaluate((row) => {
      const variableValues = row.querySelectorAll<HTMLElement>(
        "td:first-child a, td:nth-child(2) strong, td:nth-child(4) strong",
      );
      const identifier = row.querySelector<HTMLElement>("td:nth-child(3) strong");
      const action = row.querySelector<HTMLElement>(".activity-table__action a");
      return {
        actionFits: action ? action.scrollWidth <= action.clientWidth : false,
        identifierFits: identifier ? identifier.scrollWidth <= identifier.clientWidth : false,
        variableValuesUseAtMostTwoLines: Array.from(variableValues).every(
          (value) =>
            value.getBoundingClientRect().height <=
            Number.parseFloat(getComputedStyle(value).lineHeight) * 2 + 1,
        ),
      };
    }),
  ).toEqual({
    actionFits: true,
    identifierFits: true,
    variableValuesUseAtMostTwoLines: true,
  });
  expect(
    await page
      .locator(".activity-table__action")
      .first()
      .evaluate((cell) => {
        const button = cell.querySelector(".dashboard-row-link");
        if (!button) return 0;
        return cell.getBoundingClientRect().right - button.getBoundingClientRect().right;
      }),
  ).toBeGreaterThanOrEqual(12);
  await page.getByRole("link", { name: "Cronologia" }).click();
  await page.getByLabel("Tipo di attività").selectOption("CUSTOMER_CORRECTED");
  await page.getByRole("button", { name: "Filtra" }).click();
  // Il filtro applica davvero l'azione scelta e l'audit distingue i due account.
  await expect(page.getByRole("row")).toHaveCount(2);
  await expect(page.getByRole("cell", { name: "Anagrafica cliente corretta" })).toBeVisible();
  await expect(page.getByRole("cell", { name: "Codex", exact: true })).toBeVisible();
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
  await page.getByRole("link", { name: "Clienti", exact: true }).click();
  await expect(page.locator(".customer-table tbody tr").first()).toBeVisible();
  await expect(page.locator('.nav-item[aria-current="page"]')).toHaveText("Clienti");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    ),
  ).toBe(true);
  await page.getByRole("link", { name: "Ordini", exact: true }).click();
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
  await expect(page.locator('.nav-item[aria-current="page"]')).toHaveText("Ordini");
  const mobileNavigation = await page.locator(".nav-item").evaluateAll((items) =>
    items.map((item) => ({
      current: item.getAttribute("aria-current"),
      labelWidth: item.querySelector("span")?.getBoundingClientRect().width ?? 0,
      right: item.getBoundingClientRect().right,
    })),
  );
  expect(mobileNavigation.filter((item) => item.labelWidth > 1)).toHaveLength(1);
  expect(mobileNavigation.find((item) => item.current === "page")?.labelWidth).toBeGreaterThan(1);
  expect(mobileNavigation.every((item) => item.right <= 320)).toBe(true);
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

  await page.getByLabel("Apri altre sezioni").click();
  await page.getByRole("link", { name: "Impostazioni", exact: true }).click();
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
  await page.getByLabel("Nome utente").fill("MASSIMO");
  await page.getByLabel("Password").fill("password-massimo");
  await page.getByRole("button", { name: "Accedi" }).click();
  await page.getByRole("link", { name: "Ordini", exact: true }).click();
  await page.getByRole("link", { name: "Da fatturare" }).click();
  await page
    .getByRole("link", { name: `Apri ${archivedPreparation}` })
    .first()
    .click();
  await expect(page.getByRole("heading", { name: "Confronto fiscale" })).toBeVisible();
  await expect(page.getByText("RF14 · N5 · FPR · versione 1")).toBeVisible();
  await expect(page.getByRole("table", { name: "Destinatario" })).toContainText("Origine");
  await expect(page.getByRole("table", { name: "Righe" })).toContainText("Proiezione XML");
  await expect(page.getByRole("table", { name: "Pagamento" })).toContainText("TP02 · MP08");
  await expect(page.getByRole("table", { name: "Dati tecnici e fiscali" })).toContainText(
    "TD01 · FPR12 · FPR",
  );
  await page.getByRole("button", { name: "Salva e valida bozza" }).click();
  await expect(page.getByRole("group", { name: "Conferma finale" })).toContainText(
    "numero fiscale definitivo",
  );
  await page.getByLabel(/Confermo i dati riepilogati e autorizzo l’approvazione/).check();
  const approvalResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" && response.url().includes("/ordini/preparazione/"),
  );
  await page.getByRole("button", { name: "Approva, numera e prepara per Aruba" }).click();
  if ((await approvalResponse).status() >= 400) {
    await page.getByRole("alert").waitFor();
    throw new Error((await page.getByRole("alert").textContent()) ?? "Approvazione non riuscita");
  }
  await expect(
    page.getByRole("button", { name: "Approva, numera e prepara per Aruba" }),
  ).toHaveCount(0);
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

  await page.getByRole("button", { name: "Genera codice di avvio" }).click();
  const assistedToken = (await page.locator(".code-block").textContent())?.trim();
  expect(assistedToken).toHaveLength(43);
  const assistedManifestResponse = await fetch(`${appBaseUrl}/api/aruba/helper/manifest`, {
    headers: { Authorization: `Bearer ${assistedToken}` },
  });
  expect(assistedManifestResponse.ok).toBe(true);
  const assistedManifest = (await assistedManifestResponse.json()) as {
    documents: Array<{ id: string }>;
  };
  const assistedProfile = await mkdtemp(path.join(tmpdir(), "hub-fatture-aruba-assisted-"));
  try {
    expect(
      await runHelper({
        hubUrl: appBaseUrl,
        token: assistedToken!,
        profileDirectory: assistedProfile,
        browser: "chromium",
        headless: true,
        mockScenario: "login-auto",
        closeAfterStop: true,
      }),
    ).toBe("ASSISTED_STOP");
  } finally {
    await rm(assistedProfile, { recursive: true, force: true });
  }
  const revokedResponse = await fetch(`${appBaseUrl}/api/aruba/helper/eventi`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${assistedToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      type: "READBACK",
      documents: assistedManifest.documents.map((document) => ({
        id: document.id,
        status: "REMOVED",
      })),
    }),
  });
  expect(revokedResponse.status).toBe(401);
  await page.reload();
  await page.getByRole("button", { name: "Genera codice di avvio" }).click();
  const readbackToken = (await page.locator(".code-block").textContent())?.trim();
  const cleanupResponse = await fetch(`${appBaseUrl}/api/aruba/helper/eventi`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${readbackToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      type: "READBACK",
      documents: assistedManifest.documents.map((document) => ({
        id: document.id,
        status: "REMOVED",
      })),
    }),
  });
  expect(cleanupResponse.ok).toBe(true);

  await page.getByRole("link", { name: "Impostazioni" }).click();
  const ownerArubaSync = page.locator(".aruba-sync-card");
  const openAruba = ownerArubaSync.getByRole("link", { name: "Apri Aruba" });
  await expect(openAruba).toBeVisible();
  await expect(openAruba).toHaveAttribute("href", /\/aruba-sintetica\?scenario=inventory$/);
  const transmissionBox = page.locator(".settings-choice-card--compact");
  const desktopTransmissionSize = await transmissionBox.boundingBox();
  expect(desktopTransmissionSize?.width ?? 0).toBeLessThanOrEqual(736);
  expect(desktopTransmissionSize?.height ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(96);
  const bookmarklet = page.locator(".aruba-bookmarklet");
  await expect(
    page.getByRole("heading", { name: "Configura una volta il preferito" }),
  ).toBeVisible();
  const bookmarkletButton = bookmarklet.getByRole("link", { name: "Sincronizza Aruba" });
  await expect(bookmarkletButton).toHaveAttribute("href", /^javascript:/);
  await expect(bookmarkletButton).toContainText("↻ Sincronizza Aruba");
  const bookmarkletHref = await bookmarkletButton.getAttribute("href");
  expect(bookmarkletHref).toBeTruthy();
  await expect(bookmarklet).not.toContainText(/Node|npm|mise|Terminale|installer/i);
  expect(await bookmarklet.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
    true,
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await expectViewportFits(page);
  expect(await bookmarklet.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
    true,
  );
  for (const action of await bookmarklet.getByRole("link").all()) {
    const box = await action.boundingBox();
    const panel = await bookmarklet.boundingBox();
    expect(box && panel && box.x >= panel.x && box.x + box.width <= panel.x + panel.width).toBe(
      true,
    );
  }
  const mobileTransmissionSize = await transmissionBox.boundingBox();
  expect(mobileTransmissionSize?.width ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(358);
  expect(mobileTransmissionSize?.height ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(140);
  await page.setViewportSize({ width: 1280, height: 720 });
  const arubaPage = await page.context().newPage();
  const arubaPanelHref = await openAruba.getAttribute("href");
  expect(arubaPanelHref).toBeTruthy();
  const arubaHomeHref = new URL(arubaPanelHref!);
  arubaHomeHref.searchParams.set("scenario", "inventory-home");
  await arubaPage.goto(arubaHomeHref.toString());
  await expect(arubaPage.getByRole("heading", { name: "Home Aruba" })).toBeVisible();
  await arubaPage.locator("body").evaluate((body, href) => {
    const link = document.createElement("a");
    link.id = "e2e-aruba-bookmarklet";
    link.href = href;
    link.textContent = "Esegui sincronizzazione";
    body.append(link);
  }, bookmarkletHref!);
  const bridgePagePromise = page.context().waitForEvent("page", {
    predicate: (candidate) => candidate.url().includes("/aruba-ponte"),
  });
  await arubaPage.locator("#e2e-aruba-bookmarklet").click();
  const bridgePage = await bridgePagePromise;
  await expect(bridgePage.getByRole("status")).toContainText("Collegamento attivo");
  await expect(arubaPage.locator("#hub-fatture-aruba-status")).toContainText(
    "Seleziona Fatture inviate",
  );
  await arubaPage.evaluate(() => {
    const runtime = window as typeof window & { __arubaConcurrentPolling?: number };
    runtime.__arubaConcurrentPolling = window.setInterval(() => void fetch("/health"), 50);
  });
  await arubaPage.waitForTimeout(200);
  await arubaPage.getByRole("menuitem", { name: "Fatture inviate" }).click();
  await expect(arubaPage.locator("#hub-fatture-aruba-status")).toContainText(
    "Sincronizzazione completata",
    { timeout: 30_000 },
  );
  await expect(arubaPage.locator('[data-aruba-state="inventory-ready"]')).toHaveAttribute(
    "data-aruba-filter-revision",
    "0",
  );
  await expect(arubaPage.locator('[data-aruba-state="inventory-ready"]')).toBeVisible();
  await arubaPage.evaluate(() => {
    const runtime = window as typeof window & { __arubaConcurrentPolling?: number };
    window.clearInterval(runtime.__arubaConcurrentPolling);
    delete runtime.__arubaConcurrentPolling;
  });
  await bridgePage.waitForEvent("close", { timeout: 10_000 });
  const preflightDate = `${new Date().getUTCFullYear()}-01-03`;
  const preflightClient = new pg.Client({ connectionString: databaseUrl });
  await preflightClient.connect();
  await preflightClient.query(
    `INSERT INTO aruba_preflight_receipts
       (id, environment, account_reference, draft_version, projection_sha256,
        manifest_sha256, inventory_watermark, status, requested_by, request_json)
     SELECT gen_random_uuid(), sessions.environment, sessions.account_reference, 1,
            repeat('a', 64), repeat('b', 64), 0, 'REQUESTED', users.id, $1::jsonb
     FROM aruba_sync_sessions AS sessions
     CROSS JOIN LATERAL (SELECT id FROM users ORDER BY id LIMIT 1) AS users
     WHERE sessions.helper_version = 'preferito-1'
     ORDER BY sessions.started_at DESC LIMIT 1`,
    [
      JSON.stringify({
        documentType: "TD01",
        orderIds: [],
        refundIds: [],
        searches: [
          {
            displayNumber: "#PREFLIGHT-OLDER",
            documentType: "TD01",
            orderDate: preflightDate,
          },
        ],
      }),
    ],
  );
  await preflightClient.end();
  const secondBridgePagePromise = page.context().waitForEvent("page", {
    predicate: (candidate) => candidate.url().includes("/aruba-ponte"),
  });
  await arubaPage.locator("#e2e-aruba-bookmarklet").click();
  const secondBridgePage = await secondBridgePagePromise;
  await expect(secondBridgePage.getByRole("status")).toContainText("Collegamento attivo");
  await expect(arubaPage.locator("[data-aruba-filter-from]")).toHaveValue("", {
    timeout: 30_000,
  });
  await expect(arubaPage.locator("#hub-fatture-aruba-status")).toContainText(
    "Sincronizzazione completata",
    { timeout: 30_000 },
  );
  await secondBridgePage.waitForEvent("close", { timeout: 10_000 });
  await arubaPage.close();
  await page.reload();
  await expect(page.locator(".aruba-inventory-card dd").first()).not.toHaveText("0");
  const browserReadback = new pg.Client({ connectionString: databaseUrl });
  await browserReadback.connect();
  const detectedBrowser = await browserReadback.query<{ browser_name: string }>(
    `SELECT browser_name FROM aruba_sync_sessions
     WHERE helper_version = 'preferito-1'
     ORDER BY started_at DESC LIMIT 1`,
  );
  const bookmarkletSessions = await browserReadback.query<{
    status: string;
    full_scan: boolean;
  }>(
    `SELECT sessions.status, bool_and(pages.full_scan) AS full_scan
     FROM aruba_sync_sessions AS sessions
     JOIN aruba_sync_pages AS pages ON pages.sync_session_id = sessions.id
     WHERE sessions.helper_version = 'preferito-1' AND pages.stream <> '__manifest__'
     GROUP BY sessions.id, sessions.status, sessions.started_at
     ORDER BY sessions.started_at DESC LIMIT 2`,
  );
  await browserReadback.end();
  expect(detectedBrowser.rows[0]?.browser_name).toBe(
    browserName === "webkit" ? "safari" : "chrome",
  );
  expect(bookmarkletSessions.rows).toEqual([
    { status: "COMPLETED", full_scan: true },
    { status: "COMPLETED", full_scan: true },
  ]);
  await page.getByLabel("Modalità Aruba").selectOption("AUTOMATIC");
  const settingsResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" && response.url().includes("/impostazioni"),
  );
  await page.getByRole("button", { name: "Salva integrazione Aruba" }).click();
  expect((await settingsResponse).status()).toBeLessThan(400);
  await expect(page).toHaveURL(/aruba=salvata/);
  await expect(page.getByRole("status")).toContainText("Impostazioni Aruba aggiornate");
  await expect(page.getByLabel("Modalità Aruba")).toHaveValue("AUTOMATIC");
  await page.getByRole("link", { name: "Documenti", exact: true }).click();
  const retryResponse = page.waitForResponse(
    (response) => response.request().method() === "POST" && response.url().includes("/documenti"),
  );
  const retryButton = page.getByRole("button", { name: "Prepara nuovo tentativo" });
  await retryButton.focus();
  await retryButton.press("Enter");
  if ((await retryResponse).status() >= 400) {
    await page.getByRole("alert").waitFor();
    throw new Error((await page.getByRole("alert").textContent()) ?? "Retry Aruba non riuscito");
  }
  await expect(page).toHaveURL(/batch=creato/);
  await page.getByRole("button", { name: "Genera codice di avvio" }).first().click();
  const retryToken = (await page.locator(".code-block").textContent())?.trim();
  expect(retryToken).toHaveLength(43);
  const retryProfile = await mkdtemp(path.join(tmpdir(), "hub-fatture-aruba-retry-"));
  try {
    expect(
      await runHelper({
        hubUrl: appBaseUrl,
        token: retryToken!,
        profileDirectory: retryProfile,
        browser: "chromium",
        headless: true,
        closeAfterStop: true,
      }),
    ).toBe("ASSISTED_STOP");
  } finally {
    await rm(retryProfile, { recursive: true, force: true });
  }

  process.env.APP_ENV = "test";
  process.env.APP_BASE_URL = appBaseUrl;
  process.env.ADMIN_BOOTSTRAP_TOKEN = "synthetic-bootstrap-token-for-tests";
  process.env.DATABASE_URL = databaseUrl;
  process.env.DOCUMENT_STORAGE_ROOT = storageRoot;
  process.env.SMTP_TRANSPORT = "SYNTHETIC";
  const database = await import("../../src/db/client.server.ts");
  const aruba = await import("../../src/db/aruba.server.ts");
  const documentStorage = await import("../../src/db/document-storage.server.ts");
  const refunds = await import("../../src/db/refunds.server.ts");
  const email = await import("../../src/db/email.server.ts");
  const jobs = await import("../../src/db/connectors.server.ts");
  const orders = await import("../../src/db/orders.server.ts");
  const actorRow = (
    await database
      .getPool()
      .query<{ id: string }>("SELECT id FROM users WHERE username = 'Massimo'")
  ).rows[0]!;
  const actor = {
    id: Number(actorRow.id),
    canApprove: true,
    requestId: "m6-e2e-synthetic",
  };
  const historicalFixture = JSON.parse(
    await readFile("tests/fixtures/orders/normalized.mock.json", "utf8"),
  )[0];
  historicalFixture.externalOrderId = "release-candidate-history";
  historicalFixture.displayNumber = "#RC-HISTORY";
  historicalFixture.externalCustomerId = "release-candidate-customer";
  historicalFixture.customer.taxIdentifiers[0].value = "RSSMRA80A01H501U";
  historicalFixture.historical = true;
  await orders.importOrders([historicalFixture], {
    id: actor.id,
    requestId: "release-candidate-history",
  });
  await page.goto("/ordini?vista=verificare");
  await expect(page.getByRole("heading", { name: "Ordini storici da riconciliare" })).toBeVisible();
  await page.getByRole("link", { name: "Shopify #RC-HISTORY", exact: true }).click();
  const historicalInvoiceInput = page.getByLabel(
    "XML ufficiale della fattura Aruba, se già presente",
  );
  await expect(historicalInvoiceInput).not.toHaveAttribute("required", "");
  await page.getByLabel("Esito del confronto").selectOption("ALREADY_INVOICED");
  await expect(historicalInvoiceInput).toHaveAttribute("required", "");
  await expect(
    page.getByLabel(
      "Autorizzo l’eccezione manuale dopo aver verificato identità, indirizzo, data, totale e unicità del documento.",
    ),
  ).not.toBeChecked();
  await page
    .getByLabel("Riferimento verificato o motivazione")
    .fill("Documento Aruba FPR 9010/26 verificato");
  await historicalInvoiceInput.setInputFiles({
    name: "fattura-storica.xml",
    mimeType: "application/xml",
    buffer: Buffer.from(
      (await readFile("tests/fixtures/fatturapa/accepted-invoice.anonymized.xml", "utf8"))
        .replace("FPR 0001/26", "FPR 9010/26")
        .replace("#1001", "#RC-HISTORY")
        .replaceAll("123.45", "122.00"),
    ),
  });
  await page.getByRole("button", { name: "Registra la riconciliazione" }).click();
  await expect(page.getByText("Storico riconciliato")).toBeVisible();
  await expect(page.getByText("Fatturato", { exact: true })).toBeVisible();
  const invoice = (
    await database.getPool().query<{
      id: string;
      order_id: string;
      filename: string;
    }>(
      `SELECT documents.id, document_orders.order_id, batch_documents.filename
       FROM documents
       JOIN document_orders ON document_orders.document_id = documents.id
         AND document_orders.document_kind = 'INVOICE'
       JOIN LATERAL (
         SELECT aruba_batch_documents.filename
         FROM aruba_batch_documents
         JOIN aruba_batches ON aruba_batches.id = aruba_batch_documents.batch_id
         WHERE aruba_batch_documents.document_id = documents.id
         ORDER BY aruba_batches.created_at DESC LIMIT 1
       ) AS batch_documents ON true
       WHERE documents.kind = 'INVOICE' AND documents.status = 'APPROVED'
         AND documents.origin = 'HUB'
       ORDER BY documents.approved_at DESC LIMIT 1`,
    )
  ).rows[0]!;
  const officialPdf = Buffer.from(
    await readFile("tests/fixtures/aruba/official-pdf.synthetic.base64", "utf8"),
    "base64",
  );
  const deliveredNotification = await readFile(
    "tests/fixtures/aruba/notification-delivered.synthetic.xml",
    "utf8",
  );
  await aruba.importOfficialArubaFile(
    invoice.id,
    "ARUBA_XML",
    (await documentStorage.readDocumentXml(invoice.id))!,
    actor,
  );
  await aruba.importOfficialArubaFile(invoice.id, "ARUBA_PDF", officialPdf, actor);
  await aruba.importOfficialArubaFile(
    invoice.id,
    "SDI_NOTIFICATION",
    Buffer.from(deliveredNotification.replace("SYNTHETIC-DOCUMENT.xml", invoice.filename)),
    actor,
  );

  const refundId = (
    await database.getPool().query<{ id: string }>(
      `INSERT INTO refunds
        (provider, external_account_id, external_order_id, external_refund_id,
         order_id, status, amount, completed_at, raw_json)
       SELECT orders.provider, orders.external_account_id, orders.external_order_id,
              'm6-e2e-refund', orders.id, 'COMPLETED', 500, now(), '{}'
       FROM orders WHERE orders.id = $1 RETURNING id`,
      [invoice.order_id],
    )
  ).rows[0]!.id;
  await database.getPool().query(
    `UPDATE settings SET value_json = '"ASSISTED"'::jsonb, version = version + 1
     WHERE key = 'aruba_mode'`,
  );
  const noteId = await refunds.processRefund(refundId);
  expect(noteId).toBeTruthy();
  await page.goto("/");
  const creditNotesItem = page
    .locator(".work-item")
    .filter({ hasText: "Note di credito da approvare" });
  await creditNotesItem.getByRole("link").click();
  await expect(page).toHaveURL(/\/attivita\?tipo=note-credito$/);
  const creditNoteLink = page.getByRole("link", { name: "Nota di credito", exact: true });
  await expect(creditNoteLink).toHaveAttribute("href", `/documenti/${noteId}/nota`);
  await creditNoteLink.click();
  await expect(page.getByRole("heading", { name: "Comparatore fiscale" })).toBeVisible();
  await expect(page.getByRole("table", { name: "Righe" })).toContainText("rimborso m6-e2e-refund");
  await expect(page.getByRole("table", { name: "Righe" })).toContainText("N5");
  await expect(page.getByRole("table", { name: "Fattura originaria" })).toContainText(
    "DatiFattureCollegate",
  );
  await expect(page.getByText("PDF ufficiale Aruba, dopo l’esito SdI")).toBeVisible();
  for (const width of [1280, 900, 320]) {
    await page.setViewportSize({ width, height: width === 320 ? 780 : 800 });
    await expectViewportFits(page);
    await expect(page.locator(".comparison-table").first()).toBeVisible();
  }
  await page.setViewportSize({ width: 1280, height: 720 });
  await page
    .getByLabel(/Confermo rimborsi, riferimenti alla fattura, totale e numerazione irreversibile/)
    .check();
  await page.getByRole("button", { name: "Approva, numera e prepara per Aruba" }).click();
  await expect(page).toHaveURL(/\/documenti$/);

  const note = (
    await database.getPool().query<{ filename: string; batch_id: string }>(
      `SELECT batch_documents.filename, batch_documents.batch_id
       FROM aruba_batch_documents AS batch_documents
       JOIN aruba_batches AS batches ON batches.id = batch_documents.batch_id
       WHERE batch_documents.document_id = $1
       ORDER BY batches.created_at DESC LIMIT 1`,
      [noteId],
    )
  ).rows[0]!;
  const noteToken = await aruba.issueHelperToken(note.batch_id, actor);
  const noteProfile = await mkdtemp(path.join(tmpdir(), "hub-fatture-m6-td04-"));
  try {
    expect(
      await runHelper({
        hubUrl: appBaseUrl,
        token: noteToken.token,
        profileDirectory: noteProfile,
        browser: "chromium",
        headless: true,
        mockScenario: "valid",
        closeAfterStop: true,
      }),
    ).toBe("ASSISTED_STOP");
  } finally {
    await rm(noteProfile, { recursive: true, force: true });
  }
  await aruba.importOfficialArubaFile(
    noteId!,
    "ARUBA_XML",
    (await documentStorage.readDocumentXml(noteId!))!,
    actor,
  );
  await aruba.importOfficialArubaFile(noteId!, "ARUBA_PDF", officialPdf, actor);
  await aruba.importOfficialArubaFile(
    noteId!,
    "SDI_NOTIFICATION",
    Buffer.from(deliveredNotification.replace("SYNTHETIC-DOCUMENT.xml", note.filename)),
    actor,
  );
  for (;;) {
    const job = await jobs.claimJob("m6-e2e-email");
    if (!job) break;
    expect(job.type).toBe("send_customer_email");
    await email.sendCustomerEmail(job);
    expect(await jobs.completeJob(job)).toBe(true);
  }
  assert.equal(
    (
      await database
        .getPool()
        .query(
          "SELECT status FROM email_deliveries WHERE document_id = $1 ORDER BY created_at DESC LIMIT 1",
          [noteId],
        )
    ).rows[0].status,
    "SENT",
  );
  assert.equal(
    (await database.getPool().query("SELECT status FROM documents WHERE id = $1", [noteId])).rows[0]
      .status,
    "APPROVED",
  );
  await page.reload();
  await expect(
    page.locator(".document-row").filter({
      has: page.locator(`a[href='/documenti/${noteId}/nota']`),
    }),
  ).toContainText("Inviata");
});

test("titoli e metadati identificano le pagine senza renderle indicizzabili", async ({ page }) => {
  await page.goto("/login");
  await expect(page).toHaveTitle("Accedi · Hub Fatture");
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute(
    "content",
    "noindex, nofollow, noarchive, nosnippet, noimageindex",
  );
  await expect(page.locator('meta[property="og:title"]')).toHaveAttribute(
    "content",
    "Accedi · Hub Fatture",
  );
  await expect(page.locator('meta[name="theme-color"]')).toHaveCount(2);

  await page.getByLabel("Nome utente").fill("mAsSiMo");
  await page.getByLabel("Password").fill("password-massimo");
  await page.getByRole("button", { name: "Accedi" }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("heading", { name: "Dashboard", exact: true })).toBeVisible();

  const pages = [
    ["/", "Dashboard · Hub Fatture"],
    ["/ordini", "Ordini · Hub Fatture"],
    ["/documenti", "Documenti · Hub Fatture"],
    ["/clienti", "Clienti · Hub Fatture"],
    ["/attivita", "Attività · Hub Fatture"],
    ["/impostazioni", "Impostazioni · Hub Fatture"],
  ] as const;

  for (const [path, title] of pages) {
    await page.goto(path);
    await expect(page).toHaveTitle(title);
    await expect(page.locator('meta[name="description"]')).toHaveCount(1);
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute(
      "content",
      "noindex, nofollow, noarchive, nosnippet, noimageindex",
    );
  }

  await page.goto("/ordini/ordine-inesistente-di-esempio");
  await expect(page).toHaveTitle("La pagina non esiste · Hub Fatture");

  await page.goto("/pagina-inesistente-di-esempio");
  await expect(page).toHaveTitle("La pagina non esiste · Hub Fatture");
});

test("l’archivio Documenti resta leggibile con decine di elementi", async ({ page }) => {
  test.setTimeout(120_000);
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  const existing = Number(
    (await client.query<{ total: number }>("SELECT count(*)::integer AS total FROM documents"))
      .rows[0]!.total,
  );
  const hasUsers = Number(
    (await client.query<{ total: number }>("SELECT count(*)::integer AS total FROM users")).rows[0]!
      .total,
  );

  try {
    await client.query(
      `INSERT INTO customers
         (kind, match_key, display_name, billing_address_json,
          source_confidence, review_required)
       SELECT 'PRIVATE_IT', 'e2e-document-archive-' || series,
              CASE WHEN series = 55
                   THEN 'Laboratorio Artigianale Internazionale con una denominazione volutamente molto lunga'
                   ELSE 'Cliente archivio E2E ' || lpad(series::text, 2, '0') END,
              '{}', 'TAX_ID', false
       FROM generate_series(1, 55) AS series`,
    );
    await client.query(
      `INSERT INTO billing_cases
         (customer_id, local_order_date, currency, status, customer_snapshot_json)
       SELECT id, '2026-06-01'::date + row_number() OVER (ORDER BY id)::integer,
              'EUR', 'READY', jsonb_build_object('displayName', display_name)
       FROM customers
       WHERE match_key LIKE 'e2e-document-archive-%'`,
    );
    await client.query(
      `INSERT INTO documents
         (billing_case_id, kind, status, document_type, series, document_date,
          fiscal_profile_version, currency, total_amount, source_total_amount,
          difference_amount, projection_sha256)
       SELECT billing_cases.id, 'INVOICE', 'DRAFT', 'TD01', 'FPR',
              billing_cases.local_order_date, 1, 'EUR',
              100000 + 860 * row_number() OVER (ORDER BY billing_cases.id),
              100000 + 860 * row_number() OVER (ORDER BY billing_cases.id), 0, repeat('0', 64)
       FROM billing_cases
       JOIN customers ON customers.id = billing_cases.customer_id
       WHERE customers.match_key LIKE 'e2e-document-archive-%'`,
    );

    await page.setViewportSize({ width: 1440, height: 900 });
    if (!hasUsers) {
      await page.goto("/setup");
      await page.getByLabel("Codice di configurazione").fill("synthetic-bootstrap-token-for-tests");
      await page.getByLabel("Password per Massimo").fill("password-massimo");
      await page.getByLabel("Password per Codex").fill("password-codex");
      await page.getByRole("button", { name: "Crea gli account" }).click();
    } else {
      await page.goto("/login");
    }
    await page.getByLabel("Nome utente").fill("MASSIMO");
    await page.getByLabel("Password").fill("password-massimo");
    await page.getByRole("button", { name: "Accedi" }).click();
    await page.getByRole("link", { name: "Documenti", exact: true }).click();

    await expect(page.getByRole("heading", { name: "Archivio documenti" })).toBeVisible();
    await expect(page.locator(".document-row")).toHaveCount(50);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    ).toBe(true);
    const actionMargins = await page.locator(".document-row").evaluateAll((rows) =>
      rows.map((row) => {
        const action = row.querySelector<HTMLElement>(".document-row__action");
        if (!action) return Number.POSITIVE_INFINITY;
        return row.getBoundingClientRect().right - action.getBoundingClientRect().right;
      }),
    );
    expect(Math.min(...actionMargins)).toBeGreaterThanOrEqual(12);
    const priceStateSpacing = await page.locator(".document-row").evaluateAll((rows) =>
      rows.map((row) => {
        const facts = row.querySelector<HTMLElement>(".document-row__facts");
        const amount = row.querySelector<HTMLElement>(
          ".document-row__facts > span:last-child strong",
        );
        const state = row.querySelector<HTMLElement>(".document-row__state");
        if (!facts || !amount || !state) return null;
        return {
          amountOverflow:
            amount.getBoundingClientRect().right - facts.getBoundingClientRect().right,
          visibleGap: state.getBoundingClientRect().left - amount.getBoundingClientRect().right,
        };
      }),
    );
    expect(priceStateSpacing).not.toContain(null);
    expect(
      Math.max(...priceStateSpacing.map((spacing) => spacing?.amountOverflow ?? Infinity)),
    ).toBeLessThanOrEqual(0.5);
    expect(
      Math.min(...priceStateSpacing.map((spacing) => spacing?.visibleGap ?? -Infinity)),
    ).toBeGreaterThanOrEqual(24);
    await page.locator(".document-row__action").first().focus();
    await expect(page.locator(".document-row__action").first()).toBeFocused();

    const filters = page.locator(".document-filters");
    await filters
      .getByLabel("Cerca")
      .fill("Laboratorio Artigianale Internazionale con una denominazione volutamente molto lunga");
    await filters.getByRole("button", { name: "Filtra" }).click();
    await expect(page.locator(".document-row")).toHaveCount(1);
    await expect(page.locator(".document-row__customer")).toContainText(
      "Laboratorio Artigianale Internazionale",
    );
    await page.getByRole("link", { name: "Azzera filtri" }).click();
    await expect(page.locator(".document-row")).toHaveCount(50);

    const expectedSecondPage = existing + 55 - 50;
    await page.getByRole("link", { name: "Pagina successiva" }).click();
    await expect(page.locator(".document-row")).toHaveCount(expectedSecondPage);

    await page.goto("/documenti?vista=da-trasmettere&trasmissione=RECONCILED");
    await expect(page.getByLabel("Stato trasmissione")).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Da trasmettere" })).toHaveAttribute(
      "aria-current",
      "page",
    );

    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/documenti");
    await expect(page.locator(".document-row")).toHaveCount(50);
    const intermediateContainment = await page.evaluate(async () => {
      document.querySelector<HTMLElement>(".document-row")?.scrollIntoView({ block: "center" });
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const row = document.querySelector<HTMLElement>(".document-row");
      if (!row) return null;
      const panel = row.closest<HTMLElement>(".document-archive");
      const action = row.querySelector<HTMLElement>(".document-row__action");
      if (!panel || !action) return null;
      const grid = row.querySelector<HTMLElement>(".document-row__grid");
      return {
        actionRight: action.getBoundingClientRect().right,
        panelRight: panel.getBoundingClientRect().right,
        gridHeight: grid?.getBoundingClientRect().height ?? Number.POSITIVE_INFINITY,
        rowHeight: row.getBoundingClientRect().height,
      };
    });
    expect(intermediateContainment).not.toBeNull();
    expect(
      intermediateContainment!.panelRight - intermediateContainment!.actionRight,
    ).toBeGreaterThanOrEqual(12);
    expect(intermediateContainment!.gridHeight).toBeLessThan(190);
    expect(intermediateContainment!.rowHeight).toBeLessThan(240);

    await page.setViewportSize({ width: 1024, height: 768 });
    await page.goto("/documenti");
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    ).toBe(true);

    await page.setViewportSize({ width: 320, height: 720 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    ).toBe(true);
    const mobileHeaderContainment = await page
      .locator(".document-archive > .document-panel-header")
      .evaluate((header) => {
        const count = header.querySelector<HTMLElement>(":scope > strong");
        if (!count) return null;
        return {
          countLeft: count.getBoundingClientRect().left,
          countRight: count.getBoundingClientRect().right,
          headerLeft: header.getBoundingClientRect().left,
          headerRight: header.getBoundingClientRect().right,
        };
      });
    expect(mobileHeaderContainment).not.toBeNull();
    expect(mobileHeaderContainment!.countLeft).toBeGreaterThanOrEqual(
      mobileHeaderContainment!.headerLeft,
    );
    expect(mobileHeaderContainment!.countRight).toBeLessThanOrEqual(
      mobileHeaderContainment!.headerRight,
    );
    await expect(page.locator(".document-row").first()).toBeVisible();
    expect(
      await page
        .locator(".document-row")
        .first()
        .evaluate((row) => row.getBoundingClientRect().height),
    ).toBeLessThan(380);

    await page.getByLabel("Apri il menu di Massimo").click();
    await page.getByRole("button", { name: "Scuro" }).click({ force: true });
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(page.locator(".document-archive")).toBeVisible();
  } finally {
    await client.query(
      `DELETE FROM documents
       USING billing_cases, customers
       WHERE documents.billing_case_id = billing_cases.id
         AND billing_cases.customer_id = customers.id
         AND customers.match_key LIKE 'e2e-document-archive-%'`,
    );
    await client.query(
      `DELETE FROM billing_cases
       USING customers
       WHERE billing_cases.customer_id = customers.id
         AND customers.match_key LIKE 'e2e-document-archive-%'`,
    );
    await client.query("DELETE FROM customers WHERE match_key LIKE 'e2e-document-archive-%'");
    await client.end();
  }
});

test("la Dashboard non mostra come sano un collegamento revocato", async ({ page }) => {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  const revoked = await client.query(
    `UPDATE connections
     SET status = 'REVOKED', last_synced_at = now(), updated_at = now()
     WHERE provider = 'SHOPIFY' AND environment = 'DEVELOPMENT'`,
  );
  assert.equal(revoked.rowCount, 1);

  try {
    await page.goto("/login");
    await page.getByLabel("Nome utente").fill("MASSIMO");
    await page.getByLabel("Password").fill("password-massimo");
    await page.getByRole("button", { name: "Accedi" }).click();

    const shopifyConnection = page.locator(".connection").filter({ hasText: "Shopify" });
    await expect(shopifyConnection).toContainText("Non collegato");
    await expect(page.getByText("Aggiornamenti da completare", { exact: true })).toBeVisible();
    await expect(page.getByText("Tutto sotto controllo", { exact: true })).toHaveCount(0);
  } finally {
    await client.query(
      `UPDATE connections
       SET status = 'CONNECTED', updated_at = now()
       WHERE provider = 'SHOPIFY' AND environment = 'DEVELOPMENT'`,
    );
    await client.end();
  }
});

test("le mutazioni senza origine valida non raggiungono l’azione", async ({ request }) => {
  const headers = { origin: "http://attaccante.invalid" };

  // Route risorsa: la guardia applicativa deve rispondere con il codice del registro,
  // non con un 500 generico.
  const logout = await request.post("/logout", { form: { csrf: "assente" }, headers });
  expect(logout.status()).toBe(403);
  expect(await logout.json()).toMatchObject({ code: "REQUEST_ORIGIN_INVALID" });

  // Route documento: React Router rifiuta la richiesta cross-origin prima dell'azione.
  const login = await request.post("/login", {
    form: { username: "massimo", password: "password-massimo" },
    headers,
  });
  expect(login.status()).toBeGreaterThanOrEqual(400);
  expect(login.status()).toBeLessThan(500);
});

test("gli errori delle azioni restano codici stabili, non 500", async ({ request }) => {
  const headers = { origin: appBaseUrl };
  expect((await request.post("/logout", { form: { csrf: "x" } })).status()).toBe(403);
  expect((await request.post("/login", { headers, data: { username: "Massimo" } })).status()).toBe(
    415,
  );

  await request.post("/login", {
    headers,
    form: { username: "MASSIMO", password: "password-massimo" },
  });
  expect((await request.post("/logout", { headers, form: { csrf: "sbagliato" } })).status()).toBe(
    403,
  );
  expect((await request.post("/logout", { headers, form: { csrf: "x" } })).status()).toBe(403);
});

test("le risposte dichiarano gli header di sicurezza minimi", async ({ request }) => {
  const headers = (await request.get("/login")).headers();
  expect(headers["content-security-policy"]).toContain("frame-ancestors 'none'");
  expect(headers["x-content-type-options"]).toBe("nosniff");
  expect(headers["referrer-policy"]).toBe("same-origin");
  expect(headers["x-robots-tag"]).toBe("noindex, nofollow, noarchive, nosnippet, noimageindex");
  expect(headers["cache-control"]).toBe("no-store, private");

  const robots = await request.get("/robots.txt");
  expect(robots.headers()["content-type"]).toContain("text/plain");
  expect(await robots.text()).toBe("User-agent: *\nDisallow: /\n");
  expect(robots.headers()["x-robots-tag"]).toBe(
    "noindex, nofollow, noarchive, nosnippet, noimageindex",
  );

  await request.post("/login", {
    headers: { origin: appBaseUrl },
    form: { username: "mAsSiMo", password: "password-massimo" },
  });
  const dataHeaders = (await request.get("/ordini.data")).headers();
  expect(dataHeaders["cache-control"]).toBe("no-store, private");
  expect(dataHeaders.vary).toContain("Cookie");
});
