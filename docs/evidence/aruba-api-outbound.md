# Dossier tecnico outbound API Aruba senza invio

## Perimetro provato

La fase corrente prepara e qualifica il canale outbound senza effettuare invii reali. L’implementazione locale
copre TD01 e TD04 approvate, approvazione singola e massiva, tre modalità globali, manifest
immutabile, un job dry-run per documento, esiti distinti per documento, arresti indipendenti e
fallback manuale completo. Nessuna evidenza di questo dossier costituisce prova SdI o autorizza
`dryRun=false`.

La documentazione ufficiale Aruba espone `POST /services/invoice/upload`: con `dryRun=true` il file
viene sottoposto ai controlli sincroni senza invio a SdI; con `dryRun=false` viene trasmesso. Non
esiste nel contratto documentato una terza operazione di upload remoto senza invio. Dry-run
Production e qualifica dell'upload senza invio coincidono quindi nella stessa azione provider,
autorizzata da un unico permesso monouso; `dryRun=false`, modifiche al pannello e azioni successive
restano separate e non autorizzate.

## Controlli fail-closed

- `ARUBA_SUBMISSION_ENABLED=false` forza `DOCUMENT_ONLY`; se la modalità configurata è più ampia,
  il titolare deve confermare esplicitamente il downgrade sul singolo documento, sulla selezione
  massiva o sulla preparazione di documenti già approvati.
- una qualifica Production richiede un consenso separato e monouso per un solo documento; lega
  batch, account e manifest, scade dopo quindici minuti, consente una sola chiamata `dryRun=true` e
  lascia `ARUBA_SUBMISSION_ENABLED=false`;
- `connections.api_paused=true` è un secondo arresto indipendente e persistito.
- conferma e worker rileggono ambiente, account, modalità effettiva e connessione;
- il worker ricostruisce il manifest e confronta digest, numero documenti, revisione, hash XML,
  stato approvato e permesso corrente dell’autore;
- ogni operazione ha `max_attempts=1`; uno stato remoto incerto non viene ritentato né può essere
  sovrascritto dal completamento concorrente di un altro documento;
- se il worker riparte dopo aver consumato la qualifica e preparato il tentativo, classifica l’esito
  come `UNKNOWN_REMOTE_STATE` senza una seconda chiamata;
- le risposte persistono soltanto metadati ed errori sanitizzati, mai credenziali o XML nel log.

## Evidenza applicativa

La pagina Documenti mostra il risultato di ogni submission dentro il relativo batch. Dashboard e
Impostazioni leggono il contatore locale delle submission con `submitted_at` nel mese corrente e
avvisano a 400 e 475 su una soglia operativa di 500. I dry-run non valorizzano `submitted_at` e non
consumano il contatore.

Il fallback resta la procedura [manuale Aruba](../runbooks/aruba-manual.md): esportazione del file
approvato, caricamento manuale nel pannello, readback e import dell’evidenza ufficiale. Il fallback
non condivide l’autorità di invio con il worker API.

## Evidenza eseguita e limiti

La suite locale verifica migrazioni complete, dominio documenti e note di credito, permessi,
idempotenza, storage, provider mock, build server/client e flussi browser.

Il 30 agosto 2026 la qualifica Production è stata eseguita su un solo TD01 legittimo già approvato,
con autorizzazione specifica riferita al documento e al manifest esatti. La rilettura applicativa e
diretta del database ha verificato:

- un solo tentativo `DRY_RUN`, concluso `SUCCEEDED`, sullo stesso hash XML del manifest approvato;
- batch e submission conclusi `DRY_RUN_VALIDATED`, senza stato remoto incerto;
- permesso monouso consumato e concluso, nessun permesso o job outbound ancora attivo;
- `submitted_at` non valorizzato, nessuna consegna e-mail e nessuna autorizzazione a `dryRun=false`;
- modalità effettiva `DOCUMENT_ONLY` e `ARUBA_SUBMISSION_ENABLED=false` ancora attivi dopo la prova;
- cicli inbound canonici ancora completati, senza job attivi o fallimenti non recuperati.

La ricevuta conserva soltanto stati, cardinalità e corrispondenza degli hash: identificativi del
batch, hash completi e dati del destinatario restano fuori dal repository. Nessun invio SdI o
upload con `dryRun=false` è stato eseguito; la prova SdI appartiene alle milestone successive.

Il backfill inbound non monopolizza più il worker: dopo ogni pagina consolidata restituisce il job
alla coda senza incrementarne i tentativi. Una richiesta outbound può inserirsi fra due pagine e il
tempo di arresto del container consente di terminare il checkpoint corrente prima del deploy.

Fonte provider: [documentazione ufficiale API v2 Aruba](https://fatturazioneelettronica.aruba.it/apidoc/v2/docs.html).
