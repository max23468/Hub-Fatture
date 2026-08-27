# Inbound API Aruba

## Manifesto Production autorizzato

Il titolare ha autorizzato la pubblicazione tecnica del candidato e una prova Production
esclusivamente read-only in modalità shadow. L’autorità automatica resta al percorso browser e il
processo si arresta al dossier di parità: un eventuale passaggio all’API richiederà una nuova
conferma esplicita.

Il manifesto comprende soltanto:

- autenticazione e `userInfo` per verificare ambiente, account attivo e identità fiscale attesa;
- `GET /api/v2/invoices-out` dal `2019-01-01` al momento di avvio, in finestre massime di 48 ore e
  pagine da 10 gruppi;
- dettaglio con XML o P7M e PDF opzionale per i soli gruppi non vuoti;
- notifiche SdI per gli stessi gruppi;
- un solo backfill shadow, con checkpoint dopo ogni pagina e tetto fail-closed di 10.000 richieste
  provider complessive nel giro; la verifica iniziale della credenziale usa una sola sequenza di
  autenticazione, pari a due richieste HTTPS;
- limiti di una autenticazione al minuto e 12 richieste al minuto per ricerca e notifiche;
- persistenza della sola credenziale cifrata, dei checkpoint e di metadati/hash shadow; i byte dei
  file reali non diventano inventario canonico prima di uno switch separatamente autorizzato;
- confronto con l’ultima scansione browser completa disponibile, senza correlazioni basate sul solo
  importo o su finestre non allineate.

Restano esclusi modifica del pannello, callback, download massivo, pacchetto di conservazione,
dry-run, upload, invio, e-mail, cambio dell’autorità e revoca del fallback. Username, password,
token, dati fiscali, XML, PDF, P7M e notifiche reali non entrano nel repository, nei log o
nell’evidenza.

## Evidenze richieste

La prova si chiude soltanto con commit, versione e digest distribuiti; identità e ambiente riletti;
backfill completo o arresto esplicito; conteggi sanitizzati di richieste, finestre, gruppi,
documenti, file e notifiche; esito del dossier e rischi residui. Un esito diverso da `MATCHED` non
autorizza correzioni permissive né il passaggio dell’autorità.

## Stato osservato

Manifesto autorizzato; deploy e prova Production non ancora eseguiti sul candidato.
