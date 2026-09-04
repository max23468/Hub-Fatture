import { expect, type Locator, type Page } from "@playwright/test";

export async function verifyUnconfiguredArubaApiUi(page: Page, arubaSettings: Locator) {
  const connection = arubaSettings.locator("#aruba-api");
  for (const name of ["Connessione", "Account", "Sincronizzazione", "Trasmissione dei documenti"]) {
    await expect(arubaSettings.getByRole("heading", { name, exact: true })).toBeVisible();
  }
  await expect(connection.getByLabel("Nome utente del pannello Aruba")).toBeVisible();
  await expect(connection.getByLabel("Password del pannello Aruba")).toBeVisible();
  await expect(connection).toContainText("Non servono credenziali API separate");
  await expect(connection.getByRole("button", { name: "Verifica e collega Aruba" })).toBeVisible();

  const credentialForm = arubaSettings.locator(".aruba-api-credentials-form");
  const credentialSpacing = await credentialForm.evaluate((form) => {
    const fields = form.querySelectorAll<HTMLInputElement>("input:not([type='hidden'])");
    const fieldGroups = form.querySelectorAll<HTMLElement>(".field-with-help");
    const actions = form.querySelector<HTMLElement>(".aruba-api-credentials-form__actions");
    const fieldBoxes = Array.from(fields, (field) => field.getBoundingClientRect());
    const groupBoxes = Array.from(fieldGroups, (group) => group.getBoundingClientRect());
    return {
      actionsGap:
        (actions?.getBoundingClientRect().top ?? 0) -
        Math.max(...fieldBoxes.map(({ bottom }) => bottom)),
      columns: getComputedStyle(form).gridTemplateColumns.split(" ").filter(Boolean).length,
      fieldWidthDeltas: fieldBoxes.map(({ width }) => Math.abs(width - form.clientWidth)),
      groupGaps: groupBoxes.slice(1).map(({ top }, index) => top - groupBoxes[index]!.bottom),
    };
  });
  expect(credentialSpacing.actionsGap).toBeGreaterThanOrEqual(24);
  expect(credentialSpacing.columns).toBe(1);
  expect(credentialSpacing.fieldWidthDeltas.every((delta) => delta <= 1)).toBe(true);
  expect(credentialSpacing.groupGaps.every((gap) => gap >= 24)).toBe(true);

  const stackLayout = await arubaSettings.locator(".aruba-settings-stack").evaluate((stack) => {
    const panels = Array.from(stack.children).filter((element) =>
      element.matches(".aruba-section-card"),
    );
    return {
      columnGap: Number.parseFloat(getComputedStyle(stack).columnGap),
      panelPadding: Object.fromEntries(
        panels.map((panel) => [panel.id, Number.parseFloat(getComputedStyle(panel).paddingTop)]),
      ),
      rowGap: Number.parseFloat(getComputedStyle(stack).rowGap),
    };
  });
  expect(stackLayout).toEqual({
    columnGap: 24,
    panelPadding: {
      "aruba-api": 0,
      "aruba-synchronization": 24,
      "aruba-transmission": 24,
    },
    rowGap: 24,
  });

  const mode = page.getByLabel("Modalità Aruba");
  await expect(mode.locator("option")).toHaveText([
    "Crea solo il documento",
    "Chiedi prima di inviare",
    "Invio automatico",
  ]);
  await page.setViewportSize({ width: 320, height: 780 });
  await mode.selectOption("AUTOMATIC_AFTER_APPROVAL");
  const mobileLayout = await page
    .locator(".settings-transmission-section .settings-choice-card__field")
    .evaluate((field) => {
      const select = field.querySelector("select");
      if (!(select instanceof HTMLSelectElement)) return null;
      const style = getComputedStyle(select);
      const context = document.createElement("canvas").getContext("2d");
      if (!context) return null;
      context.font = style.font;
      const padding = Number.parseFloat(style.paddingLeft) + Number.parseFloat(style.paddingRight);
      return {
        columns: getComputedStyle(field).gridTemplateColumns.split(" ").filter(Boolean).length,
        fits:
          context.measureText(select.selectedOptions[0]?.textContent?.trim() ?? "").width +
            padding <=
          select.clientWidth,
        widthDelta: Math.abs(
          field.getBoundingClientRect().width - select.getBoundingClientRect().width,
        ),
      };
    });
  expect(mobileLayout).toEqual({ columns: 1, fits: true, widthDelta: 0 });
  await mode.selectOption("DOCUMENT_ONLY");
  await page.setViewportSize({ width: 1280, height: 720 });
  return credentialForm;
}
