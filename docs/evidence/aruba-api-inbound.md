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
- limiti applicativi più prudenti del contratto Aruba: una autenticazione ogni 60,1 secondi, una
  lettura inventario o notifiche ogni 6,1 secondi e non più di 54 richieste provider complessive
  all’ora, autenticazione inclusa. Il tetto globale conserva margine anche rispetto al tier minimo
  Aruba da 60 richieste/ora;
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

## Stato osservato

La versione Production precedente ha avviato il backfill read-only shadow e mantiene il browser
come autorità. Il presente candidato aggiunge localmente protezioni di traffico, progresso e dossier
operativo; non è ancora pubblicato. Il dossier finale e qualunque decisione sull’autorità restano
successivi al completamento del backfill e richiedono la conferma prevista dal Master Plan.
