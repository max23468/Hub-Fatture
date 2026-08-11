import assert from "node:assert/strict";
import test from "node:test";

import { copy, errorCodeLabel } from "./copy.it.ts";

test("le attività dei canali non espongono codici interni", () => {
  assert.equal(copy.activity.failedJobTitle("shopify_sync_orders"), "Aggiornamento ordini Shopify");
  assert.equal(
    errorCodeLabel("PROVIDER_UNAVAILABLE"),
    "Il canale di vendita non è raggiungibile in questo momento.",
  );
  assert.equal(errorCodeLabel("CODICE_SCONOSCIUTO"), "Errore non disponibile");
});
