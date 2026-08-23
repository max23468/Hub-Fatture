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

test("le Impostazioni distinguono i documenti esterni dalle verifiche Aruba", () => {
  assert.equal(copy.settings.arubaUnmatched, "Senza ordine Shopify/eBay");
  assert.equal(copy.settings.arubaUnresolved, "Da verificare");
});

test("i comandi Aruba spiegano lettura, sincronizzazione e revoca", () => {
  assert.match(copy.settings.arubaCommandsHelp, /non caricano né inviano documenti/);
  assert.match(copy.settings.arubaIssueReadCodeHelp, /codice temporaneo/);
  assert.match(copy.settings.arubaSyncNowHelp, /quando è attivo/);
  assert.match(copy.settings.arubaRevokeSessionsHelp, /servirà un nuovo codice/);
});
