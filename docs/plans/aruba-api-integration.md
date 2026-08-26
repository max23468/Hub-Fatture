# Piano esecutivo — integrazione API Aruba

**Stato:** approvato come specifica di destinazione; solo spike read-only locale disponibile
**Ambito:** API Aruba v2, solo ciclo attivo dell’utenza Base delegata
**Fonte canonica:** Master Plan, ADR Aruba e glossario
**Documentazione provider:** [API Aruba v2](https://fatturazioneelettronica.aruba.it/apidoc/v2/docs.html) e [manuale account Premium](https://guide.pec.it/fatturazione-elettronica/manuale-account-premium.pdf)

Questo piano sostituisce integralmente il precedente piano browser-centrico di riconciliazione in
entrata. Descrive la destinazione completa, la transizione dai componenti browser, i gate e la
sequenza di delivery. Non autorizza deploy, modifiche nel pannello Aruba, callback, upload, dry-run
Production, invii fiscali reali o rimozione degli helper.

## 0. Baseline osservata

- delega dall'utenza Base all'account abilitato attiva;
- lettura e Web Service Ciclo Attivo concessi; ciclo passivo e comunicazioni finanziarie negati;
- spike locale non collegato a UI, database, worker o deploy;
- autenticazione Production, identità fiscale attesa, account attivo e lettura ciclo attivo
  verificate fail-closed;
- primo probe Production limitato: 13 gruppi dichiarati nella finestra di 24 ore e una sola voce
  materializzata; il probe ora supporta al massimo due pagine da dieci gruppi, ma questa lettura
  paginata non è ancora stata eseguita né qualificata in Production;
- nessun dettaglio, XML, PDF, P7M o notifica scaricato;
- nessun dry-run, upload, invio o modifica del pannello eseguito.

Questa baseline prova la fattibilità minima di autenticazione e paginazione, non chiude la
qualifica API e non dimostra ancora la cardinalità completa gruppo/documento, i file, tutti gli
stati, il Tier o l'idempotenza delle mutazioni.

## 1. Esito atteso

Hub Fatture usa le API documentate Aruba come canale primario per:

1. autenticare e verificare l’identità fiscale attesa;
2. mantenere un inventario provider-first di tutto il ciclo attivo disponibile;
3. acquisire stati, XML, PDF ufficiale, P7M quando applicabile e notifiche/esiti;
4. riconciliare documenti Aruba con ordini, preparazioni e documenti locali;
5. validare, caricare e trasmettere documenti approvati secondo la modalità globale scelta;
6. operare in modo fail-closed quando il provider non permette di distinguere successo, fallimento
   o duplicazione;
7. conservare un fallback manuale completo e verificabile.

L’API non rende Aruba un sottosistema interno. Aruba e SdI restano le fonti autorevoli per presenza,
stato e file ufficiali; Hub Fatture conserva una proiezione locale datata e una storia append-only.

## 2. Perimetro

### 2.1 Compreso

- utenza Aruba Base collegata mediante delega a un account abilitato ai Web Services;
- sole fatture inviate del ciclo attivo, inclusi TD01 e TD04;
- ambiente mock con fixture sanificate e Production con qualifiche limitate e autorizzate;
- backfill di tutto lo storico disponibile;
- polling incrementale ogni 15 minuti, rilettura mirata degli stati non terminali e scansione
  completa mensile;
- comando read-only `Sincronizza ora` per Massimo e Codex;
- credenziale cifrata nel database e recuperabile tramite il recovery kit protetto;
- upload e trasmissione API soltanto nelle milestone e con le autorizzazioni previste;
- fallback manuale per export, pannello, import e readback completo;
- transizione e decisione separata sul ritiro del preferito/bridge inbound e dell’helper Playwright
  outbound.

### 2.2 Escluso

- ciclo passivo e fatture ricevute;
- comunicazioni finanziarie;
- endpoint non documentati o ricavati dal DOM del pannello;
- automazione di login, OTP, CAPTCHA o sessione browser;
- callback nella roadmap corrente;
- invio automatico senza approvazione fiscale di Massimo;
- stima monetaria dei consumi nell’interfaccia;
- creazione automatica di documenti locali a partire da fatture remote non collegate;
- mantenimento permanente di due integrazioni automatiche equivalenti.

## 3. Decisioni consolidate

| Tema                     | Decisione                                                                                              |
| ------------------------ | ------------------------------------------------------------------------------------------------------ |
| Canale finale            | API Aruba v2 primaria; pannello/helper soltanto transitori                                             |
| Dipendenza commerciale   | Accordo forfettario approvato per circa 500 fatture per mese solare, comprensivo dell’uso API previsto |
| Ambiente DEMO            | Non viene richiesto all’agenzia; si usano fixture e qualifiche Production limitate                     |
| Callback                 | Rinviato; nessun codice prima di una garanzia scritta di isolamento della sola utenza Base             |
| Modalità predefinita     | `Solo documento`                                                                                       |
| Modalità di trasmissione | Globali e rigide; nessun override per batch o documento                                                |
| Freshness                | avviso dopo 30 minuti; blocco dopo 4 ore; conflitto o incertezza bloccano subito                       |
| Backfill                 | tutto lo storico disponibile, progressivo e riprendibile                                               |
| Retry invio              | automatico soltanto quando è provata l’idempotenza o la mancata accettazione                           |
| Helper                   | ritiro separato per inbound e outbound, deciso esplicitamente da Massimo dopo un dossier di parità     |
| Canary                   | un TD01 reale legittimo, scelto da Massimo e protetto da permesso monouso                              |
| TD04                     | manuale finché non esiste un caso legittimo per un canary separato                                     |

## 4. Architettura di destinazione

```text
Aruba API v2
  -> adapter tipizzato e limitato
  -> job di sincronizzazione / trasmissione
  -> osservazioni append-only + file immutabili
  -> inventario Aruba canonico
  -> matching prudenziale
  -> Dashboard / Documenti / Attività / Impostazioni

Documento approvato
  -> batch e manifest immutabili
  -> dry-run dello stesso hash XML
  -> upload/invio autorizzato
  -> readback obbligatorio
  -> stato terminale o stato incerto fail-closed
```

Il modulo `aruba-api` possiede autenticazione, rate limiting, parsing, codici errore stabili e
traduzione dei payload provider. Il dominio non usa direttamente DTO Aruba e non tratta un gruppo
API come documento. Web e worker usano lo stesso contratto applicativo; le operazioni lente o
ritentabili vivono nel worker.

## 5. Modello di dominio e dati

### 5.1 Entità canoniche

| Entità                      | Responsabilità                                                               |
| --------------------------- | ---------------------------------------------------------------------------- |
| `connections`               | configurazione Aruba, ciphertext, identità attesa, stato pausa e ultimo test |
| `aruba_remote_documents`    | documento osservato nel provider, indipendente dall’origine                  |
| `aruba_remote_observations` | storia append-only di stati, metadati e provenienza                          |
| `aruba_remote_files`        | XML, PDF, P7M e notifiche con hash, MIME, dimensione e ownership             |
| `aruba_document_matches`    | collegamenti deterministici o decisioni manuali auditate                     |
| `aruba_sync_runs`           | lease, cursori, finestre, pagine, conteggi, watermark ed esito del giro API  |
| `aruba_submissions`         | tentativi originati da Hub Fatture, mai documenti remoti generici            |
| `aruba_submission_attempts` | dry-run, upload, invio, readback e incertezza per tentativo                  |
| `aruba_canary_permits`      | autorizzazione monouso del solo canary TD01                                  |
| `jobs`                      | esecuzioni asincrone idempotenti e riprendibili                              |

La migrazione estende la connessione Aruba per consentire credenziali cifrate. Il ciphertext entra
nei backup; il materiale necessario a decifrarlo resta nel recovery kit protetto e viene verificato
nel restore drill.

### 5.2 Identità e deduplicazione

Ogni autenticazione deve rileggere l’identità remota e confrontarla con la partita IVA attesa. Un
mismatch blocca l’intera connessione. I documenti usano, in ordine, ID remoto stabile, ID SdI,
filename ufficiale e impronta del file. Numero, anno, tipo, cedente e destinatario sostengono la
riconciliazione; il totale non è mai sufficiente per un match.

Il backfill non crea documenti Hub Fatture. Un documento remoto non collegato resta consultabile
nell’Inventario Aruba e in `Documenti → Da collegare`. Soltanto un match deterministico o una
decisione esplicita di Massimo può collegarlo al dominio locale. `ARUBA_HISTORY` viene materializzato
solo da un XML ufficiale con stato `DELIVERED` o `NOT_DELIVERED`.

### 5.3 Stati

Gli stati canonici sono `SUBMITTED`, `SDI_PROCESSING`, `DELIVERED`, `NOT_DELIVERED`, `REJECTED` e
`UNKNOWN`. Le osservazioni restano append-only; gli stati terminali non regrediscono. Payload fuori
ordine, mapping sconosciuto, file incoerente o divergenza tra fonti producono un conflitto esplicito,
non un’approssimazione.

## 6. Sincronizzazione in entrata

### 6.1 Attivazione

1. Massimo inserisce la credenziale in Impostazioni.
2. Il server autentica, esegue `userInfo`, verifica ambiente, utenza attiva e partita IVA attesa.
3. La credenziale viene salvata cifrata e non è più rileggibile dall’interfaccia.
4. La connessione resta `In pausa`.
5. Massimo abilita separatamente la sincronizzazione in entrata.
6. Gli invii fiscali restano disabilitati.

### 6.2 Backfill completo

Il primo giro divide lo storico disponibile in finestre compatibili con il contratto Aruba, pagina
ogni finestra fino al terminale e salva un checkpoint soltanto dopo il commit idempotente della
pagina. Si arresta sui rate limit e riprende dal checkpoint. Metadati e file vengono acquisiti in
modo progressivo, validati prima della persistenza e deduplicati per hash.

Finché il backfill non è completo:

- la UI mostra periodo coperto, finestre restanti e ultimo checkpoint;
- l’inventario non è dichiarato completo;
- il dossier di parità inbound non può essere chiuso;
- il browser resta la fonte operativa autorevole durante la fase shadow.

### 6.3 Regime ordinario

- ogni 15 minuti: finestre incrementali con sovrapposizione di sicurezza;
- a ogni giro: rilettura mirata dei documenti non terminali e delle notifiche correlate;
- una volta al mese: scansione completa di controllo;
- su richiesta: `Sincronizza ora`, senza avviare un secondo giro concorrente;
- nuovo stream, cursore assente, conteggio incoerente o cambio di contratto: scansione completa.

Un lease garantisce una sola sincronizzazione per ambiente e account. La scadenza del token durante
un giro usa il refresh documentato; il fallimento di refresh chiude il giro senza avanzare cursori.

### 6.4 Salute e gate

| Condizione                                 | Stato     | Effetto                                 |
| ------------------------------------------ | --------- | --------------------------------------- |
| mai completata                             | `NEVER`   | blocco                                  |
| ultimo giro entro 30 minuti                | `HEALTHY` | operatività normale                     |
| oltre 30 minuti e fino a 4 ore             | `WARNING` | avviso non bloccante                    |
| oltre 4 ore                                | `BLOCKED` | blocco delle nuove approvazioni fiscali |
| conflitto, identità errata o stato incerto | `BLOCKED` | blocco immediato                        |

Per TD01 il gate usa esclusivamente l’inventario globale. Per TD04 resta un preflight API on-demand,
vincolato a preparazione, revisione, rimborsi, hash e watermark; la ricevuta è monouso.

## 7. Trasmissione in uscita

### 7.1 Modalità globali

Le modalità sono configurate soltanto da Massimo e valgono rigidamente per tutte le approvazioni,
singole o massive:

1. **Solo documento** — approva, numera e crea il documento; `Trasmetti` è un’azione successiva.
2. **Conferma contestuale** — dopo la creazione propone una seconda conferma `Trasmetti ora`; si può
   rimandare.
3. **Automatico dopo approvazione** — l’approvazione esplicita autorizza la creazione del job di
   trasmissione senza una seconda conferma.

L’approvazione non è mai automatica. Se la modalità richiede trasmissione ma il canale è disabilitato
o non sano, la UI offre soltanto la conferma esplicita `Approva e crea solo documento`; non accoda
silenziosamente un invio futuro.

### 7.2 Manifest e dry-run

Ogni batch congela documenti, revisioni, numeri, XML, hash e importi. Prima di ogni upload/invio il
server esegue sempre il dry-run Aruba sul medesimo XML immutabile. Un dry-run fallito non consuma
l’autorizzazione di invio e lascia il documento numerato ma non trasmesso, con errori correggibili
secondo le regole fiscali esistenti.

Il dry-run Production è una chiamata provider mutativa e richiede l’autorizzazione della milestone;
non va confuso con una validazione locale o con un invio SdI.

### 7.3 Esecuzione e readback

Il worker ricontrolla server-side:

- identità e ambiente;
- stato della connessione e interruttore invii;
- approvazione e permessi di Massimo;
- revisione e hash del manifest;
- esito del dry-run sullo stesso hash;
- assenza di una trasmissione già accettata o incerta.

Il batch conserva esiti per documento. Un documento non valido non trasforma gli altri in successi
impliciti; ogni accettazione remota viene riconciliata individualmente. Dopo upload o invio il
readback è obbligatorio.

### 7.4 Retry e stato incerto

Un retry automatico è ammesso soltanto se una chiave idempotente documentata, un ID richiesta
riutilizzabile o una rilettura autorevole prova che non esiste un invio precedente. Timeout dopo una
possibile accettazione, risposta non parsabile o readback contraddittorio producono `UNKNOWN_REMOTE_STATE`:
nessun nuovo upload o invio finché la riconciliazione non chiarisce l’esito.

## 8. File e parità

Per ogni flusso applicabile devono essere acquisibili e verificabili:

- XML ufficiale;
- PDF restituito o generato ufficialmente da Aruba;
- P7M quando previsto;
- notifiche e ricevute SdI;
- esiti e stato corrente;
- hash, dimensione, MIME, ownership e origine.

L’assenza di uno di questi elementi non viene nascosta come parità ridotta. Può non bloccare una
milestone tecnica precedente, ma blocca il dossier di parità e il ritiro del relativo helper.

## 9. Credenziali, autorizzazioni e arresti

### 9.1 Credenziale

- cifratura autenticata con la chiave dei connettori;
- mai in query string, log, audit, errori, frontend, CLI o repository;
- test d’identità prima del salvataggio;
- valore mai rileggibile dopo il salvataggio;
- rotazione e revoca auditate;
- cancellazione del plaintext dalla memoria appena possibile;
- rate limit specifico su autenticazione e test connessione.

### 9.2 Ruoli

Massimo può configurare/testare/ruotare/revocare la connessione, cambiare modalità, attivare o
fermare la sincronizzazione, abilitare gli invii e compiere azioni fiscali manuali. Codex può vedere
salute, errori e quota ufficiale e può richiedere soltanto `Sincronizza ora` in lettura. Ogni endpoint
applica il controllo server-side.

### 9.3 Due arresti indipendenti

- **Pausa API:** ferma nuovi polling, elaborazioni e mutazioni Aruba; i job in corso raggiungono un
  punto sicuro e si arrestano.
- **Invii fiscali abilitati:** ferma dry-run, upload e invio, ma lascia attive letture e
  riconciliazione.

Entrambi partono fail-closed, sono auditati e vengono riletti dal worker prima di ogni mutazione.

## 10. Interfaccia e flussi operativi

Non nasce una destinazione primaria `Aruba`.

### Impostazioni

- stato `In pausa`, `Connessa`, `Attenzione` o `Bloccata`;
- identità verificata e data del test, senza username o segreti completi;
- attivazione sincronizzazione, modalità globale e interruttore invii;
- ultimo giro, backfill, quota/Tier ufficiali quando disponibili;
- fallback manuale e, finché esiste, `Fallback transitorio` owner-only e disabilitato di default;
- rotazione/revoca credenziale.

### Dashboard

- freschezza dell’inventario, backfill incompleto, conflitti e job bloccati;
- avviso a 400 e 475 trasmissioni nel mese solare, mai blocco automatico;
- niente `Tutto sotto controllo` se Aruba è `NEVER`, `BLOCKED` o incompleto in modo rilevante.

### Documenti

- origine `Hub Fatture` o `Aruba`, stato remoto, file ufficiali e ultimo aggiornamento;
- coda `Da collegare` per i documenti remoti senza match;
- azioni di trasmissione coerenti con la modalità globale e i permessi;
- esiti per documento nei batch massivi.

### Attività

- errori stabili, retry, stati incerti, mismatch identità, conflitti e azioni di recovery;
- audit di configurazione, pause, abilitazioni, trasmissioni e decisioni manuali;
- nessun payload fiscale o segreto nei messaggi.

## 11. Quota e costi

L’accordo corrente copre un volume previsto di circa 500 fatture per mese solare e l’uso delle API
necessario al piano. Hub Fatture mostra soltanto valori ufficiali Aruba quando disponibili e un
contatore locale dei documenti accettati per trasmissione; non stima euro. Gli avvisi in-app scattano
a 400 e 475 e si azzerano il primo giorno del mese. Letture, download, dry-run e retry non vengono
presentati come fatture inviate.

La qualifica API registra rate limit, Tier, regole di conteggio e risposta `429` correnti. Il client
applica budget conservativi, backoff con jitter e priorità agli stati non terminali. Un cambiamento
contrattuale o un consumo anomalo riapre il gate economico prima di abilitare nuovi invii, ma non
cancella automaticamente un documento già autorizzato.

## 12. Callback

Il polling è completo e autorevole. La callback non è un gate della roadmap e non vengono creati
endpoint, tabelle o segreti preparatori.

Una tranche futura richiede una conferma scritta che l’endpoint configurato dall’account Premium:

- riceva soltanto eventi della specifica utenza Base e del solo ciclo attivo;
- possa essere configurato, ruotato e revocato senza coinvolgere altri deleganti;
- abbia un’autenticazione e una procedura di test compatibili con il confine single-tenant;
- non esponga dati di altri clienti dell’agenzia.

Anche se introdotta, la callback accelera soltanto la rilettura API e non diventa fonte autorevole.

## 13. Fallback manuale

Il fallback permanente è un flusso guidato, non una spunta dichiarativa:

1. esportazione dell’XML immutabile e del riepilogo/hash;
2. operazione compiuta personalmente nel pannello Aruba;
3. import di XML/file/notifiche/esiti ufficiali;
4. lettura manuale integrale degli stream necessari o import di un export ufficiale completo;
5. ricevuta vincolata a identità, ambiente, documento, revisione, hash, periodo e conteggi;
6. finalizzazione di Massimo.

Il fallback non supera match ambigui, errori documentali, stato incerto o inventario incompleto.

## 14. Transizione e fine degli helper

### 14.1 Inbound

Durante la transizione inbound il preferito/bridge resta autorevole e l’API esegue giri shadow
separati e sanitizzati.
Non si fondono due fonti automatiche nella stessa vista canonica. Il dossier richiede:

- stesso insieme normalizzato di documenti, senza divergenze inspiegate;
- paginazione e copertura completa;
- stessi stati terminali e non terminali;
- file e notifiche ufficiali equivalenti;
- recovery, rate limit e backfill provati.

Dopo il dossier e un ingest completo controllato, il passaggio di autorità è atomico: l’API diventa
l’unica fonte automatica. Il preferito può restare soltanto nel `Fallback transitorio` finché Massimo
decide esplicitamente se ritirarlo.

### 14.2 Outbound

Il dossier confronta dry-run, upload, validazione, invio, readback, file, stati, manifest, arresti e
recovery. TD01 può raggiungere la parità dopo il canary reale; TD04 non è dichiarato in parità finché
non supera un canary legittimo separato.

### 14.3 Decisione e rimozione

Non esiste una scadenza automatica di 30 o 90 giorni. Prima della 1.0 Massimo deve decidere
separatamente per inbound e outbound:

- **ritira:** rimuovere codice eseguibile, rotte, token, stato dispositivo, UI, dipendenze e runbook
  operativi specifici; conservare audit, file canonici, provenienza `HELPER` e storia Git;
- **mantieni transitorio:** confinare il componente in Impostazioni, owner-only, disabilitato di
  default, con rischi e condizione di rimozione documentati.

L’assenza della rimozione fisica non blocca da sola la 1.0; l’assenza della decisione esplicita sì.

## 15. Qualifica e autorizzazioni Production

Ogni fase presenta prima dell’esecuzione reale un manifesto con endpoint/capacità, numero
massimo di richieste, finestre temporali, classi di dati, persistenza prevista e prova di assenza di
invio. Il consenso vale per la fase e decade se il perimetro cambia.

- Qualifica API: sole letture limitate; file minimi temporanei, validati e cancellati subito.
- Inbound API: ingest canonico read-only e backfill autorizzato.
- Outbound API: dry-run e qualifiche di upload senza invio, con autorizzazione specifica.
- Canary Production: un solo invio TD01 reale mediante permesso monouso.

Deploy, modifica dei permessi/delega nel pannello, callback, abilitazione ordinaria e ogni altro invio
reale richiedono autorizzazioni distinte.

## 16. Canary TD01 e TD04

Il canary Production usa un permesso monouso legato a ambiente, account, documento, revisione,
batch, XML
hash e scadenza breve. Viene consumato atomicamente al primo tentativo autorizzato. L’interruttore
ordinario degli invii resta disabilitato; un esito incerto non riapre il permesso.

Massimo sceglie al momento dell’esecuzione un TD01 reale, legittimo e già necessario. Nessun documento
viene creato appositamente per il test. TD04 usa fixture e dry-run nella roadmap iniziale e resta nel
fallback manuale finché un rimborso reale legittimo consente un canary separatamente autorizzato.

## 17. Strategia di test

### Unit e contract

- autenticazione, refresh, identità e mismatch;
- paginazione, finestre, cursori, sovrapposizione e rate limit;
- DTO inattesi, campi mancanti, payload e file oltre limite;
- mapping stati e non-regressione;
- gruppo API con zero, uno o più documenti;
- validazione base64, XML, PDF, P7M, notifiche e hash;
- redazione dei segreti e codici errore stabili;
- mock di dry-run, upload, invio, duplicato e stato incerto.

### Integrazione PostgreSQL

- lease singolo e ripresa del backfill;
- commit pagina/cursore atomico;
- deduplicazione e osservazioni append-only;
- matching concorrente e materializzazione `ARUBA_HISTORY` controllata;
- manifest immutabile e risultati per documento;
- consumo atomico del permesso canary;
- due arresti riletti dal worker;
- retry sicuro e blocco dell’incertezza.

### E2E

- configurazione credenziale senza possibilità di rileggerla;
- connessione inizialmente in pausa;
- backfill incompleto e salute;
- `Sincronizza ora` per entrambi gli account;
- permessi Massimo/Codex su configurazione e mutazioni;
- tre modalità globali, singolo e massivo;
- downgrade esplicito quando gli invii sono indisponibili;
- inventario, `Da collegare`, file, attività e recovery;
- avvisi mensili a 400 e 475;
- fallback manuale completo;
- `Fallback transitorio` assente dalle superfici operative ordinarie.

### Parità

La tolleranza è zero divergenze inspiegate sull’insieme normalizzato. Differenze spiegate richiedono
evidenza ufficiale, classificazione e correzione del contratto o del normalizzatore; una soglia
statistica non sostituisce la completezza.

## 18. Sequenza di delivery

### Qualifica API e accordo

- contratto v2, identità, gruppi/documenti, paginazione, finestre, stati, file e notifiche;
- limiti, Tier, regole di conteggio e accordo economico registrati senza importi sensibili;
- probe Production read-only limitato e sanitizzato;
- nessuna persistenza canonica di file reali e nessuna mutazione.

**Gate:** semantica completa e limiti qualificati; identità esatta; nessun segreto nei log; accordo
economico confermato; manifesto e prova read-only chiusi.

### Inbound API primario

- credenziale cifrata, due arresti, worker e job;
- backfill completo, polling, file, matching, salute e UI;
- giri shadow separati dal browser e dossier inbound;
- passaggio atomico dell’autorità automatica all’API.

**Gate:** storico completo; zero divergenze inspiegate; recovery e restore provati; decisione di
Massimo sul preferito/bridge registrata.

### Outbound API senza invio reale

- tre modalità globali, manifest, job e risultati per documento;
- dry-run, qualifiche di upload senza invio, readback e stato incerto;
- interruttore invii ancora disabilitato;
- fallback manuale invariato.

**Gate:** nessun invio SdI; hash e autorizzazioni verificati; retry sicuro; dossier outbound tecnico
pronto, esclusa la prova reale.

### Parità e transizione browser

- dossier separati inbound/outbound;
- API unica fonte automatica per le capacità qualificate;
- decisione esplicita di Massimo su ciascun helper;
- eventuale rimozione o confinamento transitorio.

**Gate:** nessuna doppia autorità; fallback manuale completo; rischi residui accettati.

### Ricertificazione release candidate

- regressione completa dell’app, sicurezza, recovery, migrazioni, backup e rollback;
- readiness riferita a commit, digest, schema e configurazione esatti;
- nessun P0/P1 e nessuna incertezza Aruba aperta.

### Canary Production TD01

- un TD01 reale legittimo scelto da Massimo;
- permesso monouso e interruttore ordinario ancora disabilitato;
- dry-run, invio, readback, file e stato osservati end-to-end;
- ricevuta sanitizzata.

**Gate:** nessun duplicato, nessun retry cieco, stato remoto determinato e permesso consumato.

### Go-live e `1.0.0`

- autorizzazione ordinaria separata;
- monitoraggio rafforzato della prima giornata;
- avvisi quota e salute operativi;
- decisioni helper registrate;
- TD04 ancora manuale finché non supera il proprio canary.

## 19. Conseguenze e rischi residui

- Hub Fatture custodisce una nuova credenziale ad alto impatto: backup, rotazione e incident response
  diventano parte del prodotto.
- Il polling automatico riduce il lavoro manuale ma rende rate limit, cursori e salute del worker
  requisiti operativi.
- Il backfill completo aumenta storage e durata iniziale, compensati da deduplicazione, checkpoint e
  rate budget.
- L’assenza di DEMO evita coordinamento con l’agenzia ma alza il rigore delle fixture e dei manifesti
  Production.
- Il forfait mensile elimina una decisione economica aperta, ma i contatori provider restano da
  qualificare e monitorare.
- La transizione conserva reversibilità senza trasformare gli helper in legacy permanente.
- Callback e TD04 automatico restano capacità esplicitamente rinviate, non scaffolding incompleto.

## 20. Questioni provider da qualificare, non decisioni di prodotto

- forma esatta dei gruppi API e cardinalità dei documenti in ogni risposta;
- disponibilità e semantica di XML, PDF, P7M, notifiche e download per tutto lo storico;
- Tier effettivo, contatori ufficiali e comportamento al superamento;
- chiavi o garanzie d’idempotenza per dry-run, upload e invio;
- capacità di distinguere con certezza upload, invio e accettazione dopo un timeout;
- eventuale isolamento per delegante della callback Premium.

Una risposta diversa dalle ipotesi non viene adattata silenziosamente: aggiorna contratto, test,
evidenza e, se cambia il rischio o lo scope, torna a Massimo.
