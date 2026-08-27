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

test("la connessione Aruba distingue le credenziali del pannello da credenziali API dedicate", () => {
  assert.equal(copy.settings.arubaApiUsername, "Nome utente del pannello Aruba");
  assert.equal(copy.settings.arubaApiPassword, "Password del pannello Aruba");
  assert.match(copy.settings.arubaApiCredentialsHelp, /Non servono credenziali API separate/);
  assert.match(copy.settings.arubaApiUsernameHelp, /non l’account Aruba.*@aruba\.it/);
  assert.equal(copy.settings.arubaApiSaveCredentials, "Verifica e collega Aruba");
});

test("la prima configurazione Aruba non richiede installazioni tecniche", () => {
  assert.match(copy.settings.arubaBookmarkletHelp, /Non devi installare nulla/);
  assert.doesNotMatch(
    `${copy.settings.arubaBookmarkletHelp} ${copy.settings.arubaBookmarkletSaveHelp}`,
    /Node|npm|mise|Terminale|installer/i,
  );
  assert.equal(copy.settings.arubaBookmarkletLabel, "Sincronizza Aruba");
  assert.doesNotMatch(copy.settings.arubaBookmarkletLabel, /↻/);
  assert.equal(copy.settings.arubaBookmarkletAccessibleLabel, "Sincronizza Aruba");
  assert.match(copy.settings.arubaBookmarkletSaveHelp, /si aggiorna automaticamente/);
  assert.match(copy.settings.arubaBookmarkletSaveHelp, /non salva credenziali Aruba/);
  assert.match(copy.settings.arubaBookmarkletRunHelp, /Home.*seleziona Fatture inviate/);
  assert.equal(
    copy.settings.arubaDiagnosticValue("READ_SYNC_FAILED"),
    "La lettura si è interrotta prima del completamento",
  );
  assert.equal(
    copy.settings.arubaDiagnosticValue("DOM_UNRECOGNIZED"),
    "La pagina Aruba non ha completato il caricamento previsto",
  );
  assert.equal(
    copy.settings.arubaDiagnosticValue("ARUBA_ACCOUNT_MISMATCH"),
    "L’account Aruba aperto non coincide con quello già collegato",
  );
  assert.equal(
    copy.settings.arubaDiagnosticValue("ARUBA_REMOTE_STATUS_UNRECOGNIZED"),
    "Aruba mostra troppi stati non riconosciuti; la lettura è stata fermata",
  );
  assert.match(copy.settings.arubaConnectionConflict, /Sincronizzazione completata/);
  assert.match(copy.settings.arubaConnectionConflictHelp, /inventario è aggiornato/);
});
