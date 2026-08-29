import assert from "node:assert/strict";
import test from "node:test";

import { latestMigrationFileName, sortedMigrationFileNames } from "./migration-files.ts";

test("il catalogo delle migrazioni ignora i file estranei e mantiene l'ordine canonico", () => {
  assert.deepEqual(
    sortedMigrationFileNames([
      "README.md",
      "040_aruba_api_outbound.sql",
      "002_connectors.sql",
      "2_non_valida.sql",
      "001_baseline.sql",
    ]),
    ["001_baseline.sql", "002_connectors.sql", "040_aruba_api_outbound.sql"],
  );
});

test("l'ultima migrazione deriva dal catalogo e non da un valore duplicato", () => {
  assert.equal(
    latestMigrationFileName([
      "039_aruba_p7m_parity_normalization.sql",
      "040_aruba_api_outbound.sql",
    ]),
    "040_aruba_api_outbound.sql",
  );
  assert.throws(() => latestMigrationFileName(["README.md"]), /Nessuna migrazione SQL valida/);
});
