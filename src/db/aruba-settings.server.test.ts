import assert from "node:assert/strict";
import test from "node:test";

import { temporaryDatabase } from "./database-fixture.ts";
import { runMigrations } from "./migrations.server.ts";

test("le Impostazioni mantengono fail-closed le modalità di trasmissione Aruba", async () => {
  const fixture = await temporaryDatabase("aruba_settings");
  try {
    await runMigrations({ connectionString: fixture.connectionString });
    process.env.APP_ENV = "test";
    process.env.APP_BASE_URL = "http://localhost:8080";
    process.env.ADMIN_BOOTSTRAP_TOKEN = "synthetic-bootstrap-token-for-tests";
    process.env.DATABASE_URL = fixture.connectionString;
    process.env.ARUBA_ACCOUNT_REFERENCE = "synthetic-aruba-account";

    const database = await import("./client.server.ts");
    const aruba = await import("./aruba.server.ts");
    const owner = (
      await database
        .getPool()
        .query<{ id: number }>(
          "INSERT INTO users (username, password_hash, can_approve) VALUES ('Massimo', 'synthetic', true) RETURNING id",
        )
    ).rows[0]!;
    const settings = await aruba.getArubaSettings();
    assert.equal(settings.mode.value, "DOCUMENT_ONLY");
    assert.equal(settings.effectiveMode, "DOCUMENT_ONLY");
    await aruba.setArubaSettings(
      { mode: "CONTEXTUAL_CONFIRMATION", modeVersion: settings.mode.version },
      { id: owner.id, canApprove: true, requestId: "settings-contextual" },
    );
    const contextual = await aruba.getArubaSettings();
    assert.equal(contextual.mode.value, "CONTEXTUAL_CONFIRMATION");
    assert.equal(contextual.effectiveMode, "DOCUMENT_ONLY");
    await aruba.setArubaSettings(
      { mode: "AUTOMATIC_AFTER_APPROVAL", modeVersion: contextual.mode.version },
      { id: owner.id, canApprove: true, requestId: "settings-automatic" },
    );
    const automatic = await aruba.getArubaSettings();
    assert.equal(automatic.mode.value, "AUTOMATIC_AFTER_APPROVAL");
    assert.equal(automatic.effectiveMode, "DOCUMENT_ONLY");
    assert.equal(automatic.transmissionForcedDocumentOnly, true);
  } finally {
    await import("./client.server.ts").then(({ closePool }) => closePool());
    await fixture.drop();
  }
});
