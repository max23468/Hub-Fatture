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
  assert.equal(copy.settings.arubaExternalDocuments, "Senza ordine Shopify/eBay");
  assert.equal(copy.settings.arubaUnresolved, "Da verificare");
});

test("la prima configurazione Aruba non richiede installazioni tecniche", () => {
  assert.match(copy.settings.arubaBookmarkletHelp, /Non devi installare nulla/);
  assert.doesNotMatch(
    `${copy.settings.arubaBookmarkletHelp} ${copy.settings.arubaBookmarkletSaveHelp}`,
    /Node|npm|mise|Terminale|installer/i,
  );
  assert.equal(copy.settings.arubaBookmarkletLabel, "Sincronizza Aruba");
  assert.match(copy.settings.arubaBookmarkletSaveHelp, /non salva credenziali Aruba/);
});
