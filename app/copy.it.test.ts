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
  assert.equal(
    copy.dashboard.updatesMissingDetail,
    "Uno o più collegamenti richiedono un aggiornamento o una verifica",
  );
});

test("la connessione Aruba distingue le credenziali del pannello da credenziali API dedicate", () => {
  assert.equal(copy.settings.arubaApiUsername, "Nome utente del pannello Aruba");
  assert.equal(copy.settings.arubaApiPassword, "Password del pannello Aruba");
  assert.match(copy.settings.arubaApiCredentialsHelp, /Non servono credenziali API separate/);
  assert.match(copy.settings.arubaApiUsernameHelp, /non l’account Aruba.*@aruba\.it/);
  assert.equal(copy.settings.arubaApiSaveCredentials, "Verifica e collega Aruba");
  assert.equal(copy.settings.arubaApiEditCredentials, "Aggiorna credenziali");
  assert.match(copy.settings.arubaApiCredentialsConnected, /Collegamento verificato/);
});

test("la sincronizzazione Aruba è descritta come automatica e basata sulle API", () => {
  assert.match(copy.settings.arubaHelp, /API Aruba/);
  assert.match(copy.settings.arubaConnectionReadyHelp, /automaticamente tramite API/);
  assert.doesNotMatch(
    `${copy.settings.arubaHelp} ${copy.settings.arubaConnectionReadyHelp}`,
    /preferit|bookmarklet|bridge|browser/i,
  );
  assert.equal(
    copy.settings.arubaDiagnosticValue("READ_SYNC_FAILED"),
    "La lettura si è interrotta prima del completamento",
  );
  assert.equal(
    copy.settings.arubaDiagnosticValue("DOM_UNRECOGNIZED"),
    "Errore di sincronizzazione non disponibile",
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
