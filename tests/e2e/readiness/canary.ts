import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";

import { expectViewportFits } from "./support.ts";

test("il gate opzionale disabilitato non espone comandi di invio reale", async ({
  page,
}, testInfo) => {
  const database = await import("../../../src/db/client.server.ts");
  const pool = database.getPool();
  const batch = (
    await pool.query<{
      account_reference: string;
      environment: string;
      id: string;
      manifest_sha256: string;
      status: string;
      submission_environment: string;
      submission_id: string;
      submission_status: string;
    }>(
      `SELECT batches.id, batches.environment, batches.status, batches.account_reference,
              batches.manifest_sha256, submissions.id AS submission_id,
              submissions.environment AS submission_environment,
              submissions.status AS submission_status
       FROM aruba_batches AS batches
       JOIN aruba_submissions AS submissions ON submissions.batch_id = batches.id
       JOIN documents ON documents.id = submissions.document_id
       LEFT JOIN aruba_dry_run_qualifications AS qualifications
         ON qualifications.batch_id = batches.id
       WHERE batches.mode = 'DOCUMENT_ONLY' AND batches.transport = 'API'
         AND batches.document_count = 1 AND documents.document_type = 'TD01'
         AND qualifications.id IS NULL
       ORDER BY batches.created_at DESC LIMIT 1`,
    )
  ).rows[0]!;
  const ownerId = (
    await pool.query<{ id: string }>("SELECT id FROM users WHERE lower(username) = 'massimo'")
  ).rows[0]!.id;
  const qualificationId = randomUUID();

  await pool.query(
    "UPDATE aruba_batches SET environment = 'PRODUCTION', status = 'DRY_RUN_VALIDATED' WHERE id = $1",
    [batch.id],
  );
  await pool.query(
    "UPDATE aruba_submissions SET environment = 'PRODUCTION', status = 'DRY_RUN_VALIDATED' WHERE id = $1",
    [batch.submission_id],
  );
  await pool.query(
    `INSERT INTO aruba_dry_run_qualifications
       (id, batch_id, environment, account_reference, manifest_sha256, status,
        expires_at, consumed_at, completed_at, created_by)
     VALUES ($1, $2, 'PRODUCTION', $3, $4, 'SUCCEEDED',
        now() + interval '1 hour', now(), now(), $5)`,
    [qualificationId, batch.id, batch.account_reference, batch.manifest_sha256, ownerId],
  );

  try {
    await page.goto("/login");
    await page.getByLabel("Nome utente").fill("Massimo");
    await page.getByLabel("Password").fill("password-massimo");
    await page.getByRole("button", { name: "Accedi" }).click();
    await page.waitForURL("/");
    await page.goto("/documenti");

    const authorization = page.getByRole("button", {
      name: "Autorizza un solo invio reale",
    });
    const qualifiedBatch = page
      .locator(".document-batch-list")
      .getByText("Verifica Aruba superata", { exact: true });
    await expect(qualifiedBatch).toBeVisible();
    await expect(authorization).toHaveCount(0);
    await expect(page.getByText(/Confermo l’invio fiscale reale/)).toHaveCount(0);
    await expectViewportFits(page);
    await qualifiedBatch.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: testInfo.outputPath("canary-skipped-desktop.png"),
      fullPage: false,
    });

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(qualifiedBatch).toBeVisible();
    await expect(authorization).toHaveCount(0);
    await expectViewportFits(page);
    await qualifiedBatch.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: testInfo.outputPath("canary-skipped-mobile.png"),
      fullPage: false,
    });
  } finally {
    await pool.query("DELETE FROM aruba_dry_run_qualifications WHERE id = $1", [qualificationId]);
    await pool.query("UPDATE aruba_submissions SET environment = $2, status = $3 WHERE id = $1", [
      batch.submission_id,
      batch.submission_environment,
      batch.submission_status,
    ]);
    await pool.query("UPDATE aruba_batches SET environment = $2, status = $3 WHERE id = $1", [
      batch.id,
      batch.environment,
      batch.status,
    ]);
  }
});
