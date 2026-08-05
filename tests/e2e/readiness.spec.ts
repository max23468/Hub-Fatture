import { expect, test } from "@playwright/test";

test("mostra lo scaffold senza dati reali", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "Hub Fatture" })).toBeVisible();
  await expect(page.getByText("Nessun dato reale è caricato.")).toBeVisible();
});
