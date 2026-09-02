# Conservazione e cancellazione

**Stato: approvato dal titolare e dal commercialista.** Le durate, le eccezioni e la procedura seguenti sono il contratto corrente. La retention tecnica applicativa è fail-closed; la cancellazione fiscale resta esclusa dal job automatico.

## Principi e fonti

La politica applica insieme obbligo di conservazione, minimizzazione e limitazione della conservazione:

- [articolo 2220 del Codice civile](https://www.normattiva.it/uri-res/N2Ls?urn:nir:stato:regio.decreto:1942%2D03%2D16;262!vig=~art2220): scritture e documenti contabili conservati per dieci anni dalla data dell’ultima registrazione;
- [articolo 22 del D.P.R. 600/1973](https://www.normattiva.it/uri-res/N2Ls?urn:nir:presidente.repubblica:decreto:1973%2D09%2D29;600!vig=~art22): estensione oltre il termine ordinario finché non siano definiti gli accertamenti relativi al periodo d’imposta;
- [articolo 5, paragrafo 1, lettera e), e articolo 17, paragrafo 3, lettera b), del GDPR](https://eur-lex.europa.eu/eli/reg/2016/679/oj/ita): conservazione dei dati personali non oltre il necessario, fatta salva la conservazione richiesta da un obbligo legale;
- [articolo 44 del Codice dell’amministrazione digitale](https://www.normattiva.it/uri-res/N2Ls?urn:nir:stato:decreto.legislativo:2005%2D03%2D07;82!vig=~art44) e decreto ministeriale sulla conservazione fiscale digitale: integrità, autenticità, leggibilità e reperibilità dei documenti informatici fiscalmente rilevanti.

Hub Fatture conserva copie operative e probatorie, ma non dichiara che il proprio storage sostituisca il servizio di conservazione a norma. Il ruolo del servizio Aruba e il recupero dei relativi pacchetti devono essere confermati dal commercialista insieme alla durata fiscale.

## Matrice approvata

| Classe                          | Contenuto                                                                                                            | Durata proposta e decorrenza                                                                   | Esito a scadenza                                                                                     |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Documenti fiscali               | XML, P7M, PDF, notifiche SdI, profilo e snapshot immutabili, collegamenti fra fattura e nota di credito              | 10 anni dalla data dell’ultima registrazione contabile pertinente                              | cancellazione coordinata di file e metadati soltanto dopo controllo delle eccezioni                  |
| Evidenza contabile normalizzata | ordini, righe, pagamenti, rimborsi, clienti e identificativi necessari a ricostruire il documento o la registrazione | stessa durata del documento o della registrazione collegata                                    | cancellazione o anonimizzazione irreversibile dell’intero grafo non più dovuto                       |
| Audit critico fiscale           | approvazione, numerazione, correzioni, upload, invio, readback e riconciliazione                                     | stessa durata del documento collegato                                                          | cancellazione con il documento dopo readback di completezza                                          |
| Dati sorgente eccedenti         | payload e snapshot grezzi Shopify/eBay, revisioni grezze e payload webhook già normalizzati                          | 30 giorni dall’elaborazione conclusa; i casi irrisolti decorrono dalla chiusura della verifica | rimozione del payload; restano ID tecnico, hash, stato, timestamp e dati normalizzati necessari      |
| Job e audit operativi           | payload e risultati dei job conclusi, errori sanificati, audit non fiscale                                           | 180 giorni dalla conclusione                                                                   | cancellazione del payload e dei record non più necessari alla diagnosi                               |
| E-mail cliente                  | destinatario, oggetto e corpo della consegna                                                                         | 90 giorni dall’esito definitivo                                                                | redazione irreversibile; Message-ID, trasporto, stato, timestamp e codice errore restano per 24 mesi |
| Sessioni e login                | sessioni, token CSRF e tentativi di accesso                                                                          | sessione fino alla scadenza configurata; tentativi per 15 minuti                               | cancellazione automatica già attiva                                                                  |
| Log applicativi e access log    | log JSON e Caddy già sanitizzati                                                                                     | 30 giorni                                                                                      | rotazione e cancellazione automatica                                                                 |
| File temporanei                 | export, import, tentativi falliti e file di restore privi di valore probatorio                                       | al termine dell’operazione; sweep di sicurezza entro 24 ore                                    | unlink e readback dell’assenza                                                                       |
| Backup OCI                      | giornali database cifrati immutabili e copia completa protetta `current`                                             | giornali per 35 giorni; l’oggetto completo `current` è escluso dal lifecycle                   | lifecycle OCI sui giornali, senza possibilità di eliminare l’ultimo backup completo valido           |
| Copia cifrata sul Mac           | copia corrente scaricata dal bucket                                                                                  | una sola copia corrente                                                                        | sostituzione soltanto dopo verifica di dimensione e checksum della nuova copia                       |
| Credenziali provider            | credenziali cifrate e riferimenti account                                                                            | finché la connessione è attiva                                                                 | revoca presso il provider e cancellazione locale alla disconnessione definitiva                      |

## Eccezioni e blocco della cancellazione

Una classe non viene cancellata finché esiste almeno una delle condizioni seguenti:

- accertamento fiscale non definito, contenzioso, richiesta del commercialista o obbligo dell’autorità;
- disputa cliente, chargeback, rimborso, scarto o stato provider ancora incerto;
- incidente di sicurezza, indagine o recovery in corso;
- documento successivo, nota di credito o audit ancora dipendente dai dati;
- backup nuovo non verificato oppure impossibilità di dimostrare che `current` resta escluso dal lifecycle.

Ogni blocco registra classe, motivazione, approvatore, inizio, riesame previsto e chiusura. Non sono ammessi blocchi senza riesame o estensioni generiche dell’intero database.

## Procedura applicativa

1. Un job giornaliero nella coda PostgreSQL calcola i candidati usando l’orologio del database e produce conteggi sanitizzati per classe senza contenuti personali. Lease, retry e risultato persistito rendono l’esecuzione osservabile nelle Impostazioni e in `Controlli`.
2. Prima della mutazione rilegge dipendenze, eccezioni e stato provider. Un riferimento non riconosciuto blocca la classe interessata.
3. La cancellazione o redazione avviene in transazione, dal dato eccedente verso il record radice. File e righe database sono rimossi come un’unica operazione compensabile; un fallimento lascia il caso da riconciliare senza retry cieco.
4. L’audit della cancellazione conserva soltanto classe, regola, conteggio, intervallo temporale, esito e identificatore del job. Non conserva valori eliminati o hash deterministici dei clienti.
5. Il readback verifica assenza dei record scaduti, assenza di file orfani e permanenza dei casi bloccati. Gli esiti anomali compaiono nel pannello e nel monitor locale.
6. Il backup successivo deve completarsi prima di sostituire la copia Mac. Gli archivi precedenti cessano di contenere il dato entro la finestra di 35 giorni; non vengono riscritti selettivamente.

Una richiesta di cancellazione dell’interessato non rimuove i dati soggetti a obbligo fiscale. Il titolare registra la richiesta, identifica la base giuridica per ciascuna classe, cancella o redige i dati eccedenti e comunica separatamente ciò che resta conservato per obbligo legale. Nessuna cancellazione fiscale è esposta come azione ordinaria nel frontend.

## Attivazione e verifiche

Il titolare ha approvato durate tecniche, procedura, backup e gestione delle richieste. Il commercialista ha approvato durata e decorrenza della classe fiscale, estensioni per accertamenti e contenziosi, dati contabili collegati da conservare e ruolo della conservazione Aruba.

L’implementazione applicativa usa un job giornaliero transazionale con hold espliciti, audit sanitizzato e ricevuta persistita nella coda. Prima della transazione, il job Production rilegge fail-closed la ricevuta montata del backup verificato e rifiuta ricevute assenti, non valide, future o più vecchie di 36 ore; dopo l’esaurimento dei retry apre un controllo bloccante e consente un nuovo tentativo manuale. La prova usa soltanto dati sintetici e verifica almeno permanenza dell’audit fiscale, hold attivo, redazione e-mail a 90 giorni, rimozione dei metadati della consegna a 24 mesi, payload provider e job conclusi. Dopo la redazione un reinvio non può riusare il contenuto eliminato e richiede un nuovo destinatario esplicito. Le vecchie credenziali del runtime browser Aruba non fanno più parte della retention perché la migrazione forward-only ne elimina definitivamente la tabella. Lifecycle OCI, integrità remota del backup e copia Mac restano verifiche provider separate: non sono simulati dal job applicativo e devono essere riletti sul candidato distribuito.
