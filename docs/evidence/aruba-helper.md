# Evidenza integrazione Aruba e qualifica reale

> Archivio storico: il runtime descritto in questa evidenza è stato ritirato con la transizione
> API-only. Non è una procedura operativa corrente.

## Percorso browser ritirato

Il percorso browser usava il preferito `Sincronizza Aruba` in Safari, Chrome o Edge, un ponte HF
autenticato in una finestra separata e sessioni casuali temporanee di sola lettura. Il titolare
eseguiva login e challenge; dalla Home selezionava personalmente `Fatture inviate` perché il menu
ExtJS richiedeva interazione nativa. Il lettore acquisiva soltanto righe sanitizzate e i byte XML
prodotti dal controllo ufficiale della riga, senza trasferire cookie o sessioni Aruba a HF.

Le scansioni coprivano gli anni fiscali richiesti, ripartivano dall’inizio della finestra dopo
un’interruzione e usavano ingest idempotente. Le letture incrementali includevano almeno sette
giorni e i documenti non terminali; una stream nuova, un cursore assente o una scansione completa
scaduta forzavano il giro integrale. Mapper e soglie sugli stati sconosciuti rendevano fail-closed
i cambiamenti massivi del pannello. XML mancanti, match ambigui, conflitti e stati remoti incerti
restavano bloccanti.

La transizione API ha sostituito questo percorso con le API Aruba v2 come unica autorità automatica. Endpoint,
helper, preferito, token, tabelle shadow e colonne browser sono stati rimossi; resta soltanto la
provenienza `HELPER` sulle sessioni storiche per l’audit.

## Capacità verificabili localmente

- pagina Aruba sintetica con upload ordinario senza challenge, autenticazione e challenge di sicurezza post-upload inattesa in pausa, validazione valida/non valida, DOM inatteso ed esito incerto;
- helper TypeScript unico per Chrome o Edge su macOS e Windows, con allowlist stretta;
- manifest immutabile, codice di avvio breve e verifica server-side del kill switch;
- arresto assistito prima di `Invia` e kill switch che forza i nuovi batch Production all’assistito;
- blocco dopo stato incerto, sessione successiva in solo readback e nuovo tentativo soltanto dopo rimozione riconciliata;
- esito automatico accettato soltanto con identità, stato e identificativo remoto osservati;
- export XML, import helper/manuale, consultazione e download verificato di XML, P7M, PDF e notifiche SdI;
- fixture sanificate in `tests/fixtures/aruba`, migrazione, batch misto, audit atomico, flag disattivato, manifest mismatched, eventi fuori ordine, parser ostile e scenari browser sintetici.

## Qualifica reale prima del canary tecnico Production

Il 13 agosto 2026 una sessione autenticata e presidiata, autorizzata per i due hash esatti, ha caricato sul pannello Aruba Base reale un TD01 e un TD04 dedicati. Cliente, riferimenti e importi erano sintetici; soltanto l’identità obbligatoria di cedente e trasmittente proveniva dai campioni accettati ed è rimasta fuori da repository, prompt e log.

- TD01: SHA-256 `7d3eb43515c89136ead45afc06fdc7589dc3bf51178b44ba8195b7686b20a2d3`;
- TD04: SHA-256 `12bc7eb8cb0aab7afb02f81f2335d5ae0718ad2e6ed3a335eff6073a9838e181`.

Entrambi erano validi rispetto allo schema FatturaPA locale e Aruba li ha mostrati come `Fattura - TD01` e `Nota di credito - TD04`, con numero, data, cliente e importo attesi. Il pannello ha dichiarato **2 documenti correttamente caricati** ed esposto `INVIA TUTTE` e i controlli `INVIA` di riga. La prova si è arrestata prima di tali controlli: nessun invio e nessuna bozza sono stati eseguiti.

Il cleanup è avvenuto tramite `SVUOTA PAGINA`. Il readback conclusivo ha mostrato soltanto `SELEZIONA DOCUMENTI` e i limiti 4,9 MB per file, 300 documenti e 30 MB complessivi: nessuna riga, contatore, azione di cleanup o controllo `Invia` era più presente. Nella stessa sessione non è comparsa alcuna challenge OTP, SMS o CAPTCHA.

La prima variante completamente anonimizzata aveva ricevuto soltanto il codice `00001` perché la P.IVA del cedente non coincideva con il soggetto emittente; questo ha confermato il formato `DETTAGLI ERRORI` senza produrre invii. La variante qualificata ha corretto esclusivamente questa precondizione identitaria.

Le divergenze osservate sono state riportate nel contratto, nell’helper e nella pagina sintetica: formato data italiano, account nella barra superiore, cleanup globale, selezione batch `INVIA TUTTE` e limite complessivo di 30 MB. HF-O06 è chiusa sul candidato che supera i test locali e multipiattaforma collegati dal readiness record.

Questa qualifica non autorizza invii Aruba, creazione di bozze o e-mail reali. Costituisce la prova reale read-only e di upload senza invio riutilizzata dal canary tecnico Production.
