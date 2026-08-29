# Inbound API Aruba

## Manifesto Production autorizzato

Il titolare ha autorizzato la pubblicazione tecnica del candidato e una prova Production
esclusivamente read-only in modalità shadow. L’autorità automatica resta al percorso browser e il
processo si arresta al dossier di parità: un eventuale passaggio all’API richiederà una nuova
conferma esplicita.

Il manifesto comprende soltanto:

- autenticazione e `userInfo` per verificare ambiente, account attivo e identità fiscale attesa;
- `GET /api/v2/invoices-out` dal `2026-07-01` al momento di avvio, in finestre massime di 48 ore e
  pagine da 10 gruppi;
- dettaglio con XML o P7M e PDF opzionale per i soli gruppi non vuoti;
- notifiche SdI per gli stessi gruppi;
- un solo backfill shadow, con checkpoint dopo ogni pagina e tetto fail-closed di 10.000 richieste
  provider complessive nel giro; la verifica iniziale della credenziale usa una sola sequenza di
  autenticazione, pari a due richieste HTTPS;
- limiti applicativi più prudenti del contratto Aruba: una autenticazione ogni 60,1 secondi e una
  lettura inventario o notifiche ogni 6,1 secondi. I due bucket di ricerca restano separati come gli
  SLA da 12 richieste al minuto documentati da Aruba; i Tier di invio non vengono applicati alle
  letture, perché il relativo contatore cresce soltanto per fatture trasmesse con successo;
- prenotazione degli slot in PostgreSQL, condivisa fra processi e istanze: riavvii, worker doppi e
  configurazioni concorrenti della VPS non azzerano o moltiplicano il rate limit;
- cooldown fail-closed di 65 minuti dopo ogni risposta `429`, condiviso fra tutti i worker. I retry
  locali non contattano Aruba durante la pausa e quindi non prolungano involontariamente il bucket;
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

Il dossier sanitizzato distingue inoltre:

- documenti API, documenti browser, corrispondenze, assenti nei due versi, divergenze di stato e di
  file;
- copertura XML, P7M, PDF e notifiche, stream confrontati e conflitti browser irrisolti;
- errori operativi successivi all’ultima sincronizzazione riuscita ed errori storici già superati;
- checkpoint temporale consolidato, finestre residue e stima indicativa basata sull’intera catena
  di continuazioni. Il contatore `richieste/10.000` resta un budget tecnico e non viene usato come
  percentuale del backfill.

## Prove di recovery isolate

Il gate database esegue un vero `pg_dump` in formato custom e un `pg_restore` su due database
temporanei. Verifica che la credenziale resti cifrata, sia decifrabile soltanto con la stessa chiave
sintetica e che checkpoint, pagina e conteggio richieste siano preservati. Verifica inoltre il
reclaim di un job Aruba con lease scaduta e la ripresa dal checkpoint senza duplicare pagine.

Queste prove usano esclusivamente identità e password sintetiche; non leggono né ripristinano il
database Production.

## Anteprima e chiusura read-only

L’anteprima di riconciliazione confronta le verifiche ancora aperte con il solo giro di backfill più
recente. Espone esclusivamente conteggi: firma API assente, firma unica con file ufficiale, oppure più
firme API compatibili. Una firma unica indica che il documento è pronto per una rilettura mirata;
non costituisce un collegamento e non modifica match, documenti o preparazioni.

Il comando `aruba:closure-report` raccoglie versione, schema, autorità, ultimo giro, dossier,
undici gate fail-closed e anteprima di riconciliazione. Non accetta azioni o decisioni e non esegue
scritture. Può quindi essere ripetuto durante il backfill senza creare un monitor o contattare Aruba.

## Stato osservato

La versione Production distribuita esegue il backfill read-only shadow, coordina i limiti fra
istanze e mantiene il browser come autorità. Il candidato successivo distingue gli errori
operativi ancora attuali dai tentativi già superati da un job sano, espone un riepilogo fail-closed
delle verifiche di chiusura, aggiunge l’anteprima sanitizzata e prepara il percorso canonico API.

Il passaggio di autorità preparato non è esposto come azione dell’interfaccia e non viene eseguito
automaticamente: richiede backfill completo, nessun job o errore attuale, dossier `MATCHED`, zero
divergenze normalizzate e conflitti browser, copertura dei file ufficiali, notifiche osservate,
assenza di cooldown e una decisione esplicita del titolare sul fallback. La stessa transazione
registra l’audit, revoca le eventuali sessioni helper automatiche e rende canonici soltanto i giri
API successivi. Il dossier finale e l’eventuale conferma del titolare restano successivi al
completamento del backfill.
