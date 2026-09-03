import { expect, type Page } from "@playwright/test";

export async function expectUnpreparedPendingOrder(page: Page) {
  await expect(page.getByRole("heading", { name: "Ordini con pagamento in attesa" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Shopify #S-1002", exact: true })).toBeVisible();
  await expect(page.getByRole("cell", { name: "Pagamento in attesa", exact: true })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Preparazioni con pagamento in attesa" }),
  ).toHaveCount(0);
}

export async function expectPreparedPendingOrder(page: Page) {
  await expect(page.getByRole("heading", { name: "Ordini con pagamento in attesa" })).toHaveCount(
    0,
  );
  await expect(
    page.getByRole("heading", { name: "Preparazioni con pagamento in attesa" }),
  ).toBeVisible();
  const pendingPaymentCell = page.getByRole("cell").filter({ hasText: "Pagamento in attesa" });
  await expect(pendingPaymentCell).toBeVisible();
  await expect(pendingPaymentCell).toContainText("Pagamento non ancora acquisito");
}
