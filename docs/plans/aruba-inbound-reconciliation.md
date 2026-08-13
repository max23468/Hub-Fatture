# Piano esecutivo — riconciliazione Aruba in entrata

Stato: approvato per l’implementazione

Collocazione: candidato di collaudo, da completare prima del Canary Production

Dipendenza esterna: la prima scansione del pannello Aruba reale richiede un’autorizzazione separata

## 1. Esito atteso

Hub Fatture mantiene un inventario locale dei documenti presenti in Aruba, anche quando sono stati creati o inviati senza passare da Hub Fatture. L’inventario viene riconciliato con ordini, preparazioni e documenti locali prima che una nuova fattura possa essere approvata e numerata.

Il risultato operativo è osservabile:

- una preparazione già fatturata direttamente in Aruba non può produrre una seconda fattura;
- i progressi Aruba/SdI aggiornano Hub Fatture anche per documenti nati fuori dall’app;
- un collegamento certo chiude automaticamente il caso locale;
- un collegamento ambiguo o discordante compare in `Da verificare`;
- un documento Aruba privo di ordine locale resta consultabile in `Documenti → Da collegare`, senza creare ordini inventati;
- Dashboard, dettagli e Attività non possono dichiarare che è tutto sotto controllo quando Aruba non è mai stato letto o il readback è obsoleto.

Il caso osservato che motiva il lavoro viene conservato soltanto in forma sanitizzata: una preparazione locale pronta risultava già fatturata in Aruba ed è stata chiusa manualmente per evitare una seconda emissione; una discordanza anagrafica richiedeva verifica, mentre l’identificativo fiscale era coerente. Il flusso progettato deve rilevare automaticamente il documento e lasciare all’utente soltanto l’eventuale decisione sulla discordanza.

La fotografia operativa osservata sulla Dashboard costituisce uno scenario di regressione esplicito: 6 preparazioni pronte, 1 pagamento in attesa, Aruba `Mai letto` e contemporaneamente il riepilogo `Tutto sotto controllo`. Con qualunque quantità di lavoro potenzialmente fatturabile, Aruba mai letto o bloccante deve impedire quel riepilogo e rendere evidente che Hub Fatture non può ancora escludere progressi esterni.

## 2. Perimetro e non-obiettivi

### Compreso

- inventario provider-first di fatture e TD04 Aruba indipendente dai batch di Hub Fatture;
- prima acquisizione di tutti i documenti dell’anno fiscale corrente;
- deduplicazione dei documenti già presenti localmente, inclusi i 48 osservati al momento del rilievo e da ricontare prima della migrazione;
- scansione completa dell’anno fiscale corrente a ogni avvio dell’helper e sincronizzazioni incrementali mentre resta aperto;
- matching prudenziale e collegamento automatico soltanto quando univoco;
- aggiornamento monotono degli stati Aruba/SdI;
- blocco server-side di approvazione e numerazione quando il readback non è affidabile;
- override eccezionale del solo titolare, motivato e auditato;
- UI sulle superfici esistenti e fallback manuale.

### Escluso

- creazione di ordini locali per documenti presenti soltanto in Aruba;
- uso di Web Services Premium, API private o endpoint scoperti tramite DevTools;
- browser Aruba sulla VPS o polling remoto non presidiato;
- automazione del pannello Aruba con Safari;
- avvio automatico dell’helper al login nella prima versione;
- modifica retroattiva degli XML fiscali o degli snapshot immutabili;
- upload, clic su `Invia`, trasmissioni Aruba, e-mail reali, deploy e release.

Questo piano non autorizza la prima scansione Aruba reale. Tale scansione è una lettura di dati reali e viene eseguita soltanto dopo consenso specifico, con login e challenge gestiti personalmente dal titolare.

## 3. Principi invarianti

1. Aruba e i file ufficiali sono la fonte autorevole sulla presenza del documento e sullo stato SdI; Hub Fatture ne conserva una cache datata e una cronologia append-only.
2. `aruba_submissions` descrive i tentativi avviati da Hub Fatture. Un documento nato fuori dall’app non genera una submission fittizia.
3. Il solo totale non collega mai un documento a un ordine.
4. Un aggiornamento remoto non può far regredire uno stato conclusivo già osservato.
5. Incertezza, ambiguità, account inatteso, DOM non riconosciuto o file non valido arrestano la sessione in modo fail-closed.
6. Credenziali, cookie, password, OTP e sessione Aruba restano nel profilo Chrome/Edge locale e non transitano in Hub Fatture.
7. L’autorizzazione è verificata sul server; disabilitare un pulsante non sostituisce il blocco della mutazione.

## 4. Flusso operativo

### 4.1 Avvio e sessione

L’helper unico TypeScript/Playwright continua a funzionare su macOS e Windows con un profilo persistente dedicato di Chrome o Edge. Safari resta il browser preferito per usare Hub Fatture e per il fallback manuale, ma non viene automatizzato sul pannello Aruba.

All’avvio l’helper:

1. richiede a Hub Fatture una sessione di sola sincronizzazione;
2. verifica hostname, ambiente, dispositivo e riferimento dell’account atteso;
3. apre il profilo browser locale e attende l’eventuale login umano;
4. esegue sempre una scansione completa dell’anno fiscale corrente; cursori, paginazione e upsert evitano di riscaricare file invariati senza trasformarla in una scansione parziale;
5. invia osservazioni e file ufficiali ammessi agli endpoint interni di Hub Fatture;
6. ripete la sincronizzazione ogni 15 minuti finché resta aperto;
7. consente `Sincronizza Aruba ora` senza creare una seconda scansione concorrente.

La sessione di sincronizzazione è distinta dal token di batch:

- scope esclusivo `ARUBA_READ_SYNC`;
- vincolata a un identificativo casuale dell’installazione, non a fingerprint hardware invasivi;
- revocabile e ruotata;
- scadenza assoluta massima di 8 ore;
- nessun accesso ai manifest di upload e nessun potere di creare, autorizzare o consumare permessi di invio;
- token mai in query string, log o documentazione.

CAPTCHA, challenge, login scaduto o account inatteso sospendono il ciclo; la scadenza non viene estesa oltre le 8 ore.

### 4.2 Prima scansione e incrementali

La prima scansione enumera tutte le fatture e TD04 dell’anno fiscale corrente, con paginazione esplicita. Ogni pagina viene acquisita in ordine stabile e porta un cursore opaco composto dai riferimenti osservabili necessari a riprendere il lavoro. Il cursore diventa definitivo soltanto dopo il commit dell’intera pagina.

Ogni successivo giro di 15 minuti è incrementale e riparte dal cursore con una finestra di sovrapposizione temporale. L’overlap intercetta ritardi e cambi di stato; gli upsert idempotenti assorbono le ripetizioni. Un cambio d’anno apre un nuovo stream senza cancellare quello precedente. Al riavvio, la nuova scansione completa ricontrolla l’intero anno corrente anche se esiste già un cursore incrementale.

Per limitare traffico e dati:

- l’elenco acquisisce prima i metadati disponibili;
- XML/P7M/notifiche vengono scaricati per documenti nuovi, cambiati, candidati al collegamento o privi dell’evidenza ufficiale necessaria;
- il PDF viene acquisito secondo il contratto già verificato, senza usarlo per il matching;
- ogni file è validato, limitato per dimensione, hashato e archiviato in modo immutabile prima di essere referenziato.

### 4.3 Concorrenza e ripresa

Può esistere una sola sincronizzazione Aruba attiva per ambiente e account, anche se due dispositivi o due comandi la richiedono insieme. Il server assegna un lease rinnovabile; una seconda richiesta riceve lo stato della sessione attiva e non apre un’altra scansione. Un lease scaduto è riacquisibile dal cursore dell’ultima pagina completata.

Il comando manuale accoda o anticipa il prossimo giro della sessione già attiva. Non interrompe una pagina in corso e non duplica download o osservazioni.

## 5. Modello dati candidato

I nomi definitivi possono essere adattati alle convenzioni correnti durante l’implementazione, conservando questi confini.

### `aruba_remote_documents`

Inventario canonico dei documenti osservati nel pannello, inclusi quelli nati fuori da Hub Fatture:

- account e ambiente;
- ID remoto, tipo, numero, serie, anno e data fiscale;
- destinatario e identificativi normalizzati necessari al matching;
- totale e valuta;
- stato remoto corrente e data della sua osservazione;
- hash dell’XML ufficiale quando disponibile;
- riferimenti agli storage object ufficiali;
- prima e ultima osservazione, ultima scansione completa;
- origine locale classificata come `HUB_SUBMISSION`, `ARUBA_EXTERNAL` o ancora `UNKNOWN`.

Vincoli di deduplicazione, in ordine di forza:

1. account + ambiente + ID remoto;
2. account + ambiente + anno + serie canonica + numero fiscale + tipo documento;
3. account + ambiente + hash dell’XML ufficiale.

Una collisione fra chiavi che puntano a record diversi non viene fusa automaticamente: diventa conflitto operativo.

### `aruba_remote_observations`

Cronologia append-only di ogni stato e metadato rilevante osservato, con sessione, istante provider se disponibile, istante di lettura, pagina/cursore, digest del payload sanitizzato e codice d’errore. La proiezione corrente viene aggiornata soltanto se la transizione è ammessa dalla macchina a stati monotona.

### `aruba_document_matches`

Collegamenti fra inventario remoto e documento, ordine o preparazione locale:

- stato `MATCHED`, `UNMATCHED`, `AMBIGUOUS`, `PROFILE_CONFLICT`, `ERROR` o `UNKNOWN_REMOTE_STATE`;
- metodo e segnali usati;
- candidati valutati senza dati superflui;
- decisione automatica o manuale, autore, motivazione e timestamp;
- versione del matcher per poter rivalutare i soli casi non definitivi.

Il collegamento univoco a un ordine importa l’XML ufficiale come documento storico `ARUBA_HISTORY` quando il documento non esiste ancora localmente e riusa il matcher storico esistente. Se il documento Hub esiste già, il remote document viene collegato a quello e all’eventuale `aruba_submission`, senza duplicarlo.

### `aruba_sync_sessions`

Lease e ricevuta delle sessioni di sola lettura: dispositivo, versione helper/browser, account/ambiente attesi, stato, avvio, ultimo heartbeat, scadenza assoluta, cursore iniziale/finale, conteggi sanitizzati ed errore. Il token è conservato soltanto come hash.

### `sync_cursors`

Usare lo schema cursori esistente con provider `ARUBA` e stream separati per anno e tipo inventario. Conservare cursore, overlap e ultimo completamento di una scansione completa. Non sovraccaricare il cursore dei batch.

### Rapporto con le tabelle esistenti

- `aruba_submissions`: rimane il registro dei tentativi di upload/invio generati da Hub Fatture.
- `aruba_remote_documents`: rappresenta ciò che Aruba contiene, indipendentemente dall’origine.
- `documents`: conserva la rappresentazione fiscale locale immutabile quando esiste un XML ufficiale valido e un collegamento consentito; il vincolo `ARUBA_HISTORY` viene esteso in modo esplicito alle fatture e alle TD04, mantenendo per queste ultime il riferimento alla fattura originaria.
- `aruba_files`: separa provenienza e collegamento locale. `submission_id` e `remote_document_id` sono owner alternativi con vincolo “esattamente uno valorizzato”; `document_id` diventa il collegamento locale opzionale e viene valorizzato dopo il match, senza cambiare la provenienza del file.
- `sdi_notifications`: ammette `submission_id` oppure `remote_document_id` con lo stesso vincolo “esattamente uno valorizzato”; una notifica di un documento nato fuori da Hub Fatture non richiede una submission artificiale.
- `storage_objects`: resta il contenuto immutabile comune, referenziato dai file e dalle notifiche secondo l’owner di provenienza.
- `connections.last_synced_at`: indica l’ultimo inventario Aruba completato; l’età operativa deriva dalla sessione/readback, non dal contatto generico dell’helper.

La migrazione segue expand/contract: nuove tabelle e colonne nullable, backfill idempotente dei documenti/submission esistenti, doppia lettura temporanea soltanto dentro la stessa release candidata, switch delle query, poi vincoli finali. Non si conserva una via legacy dopo lo switch. Il numero della migrazione è il primo libero al momento dell’integrazione, verificato contro `main` per non collidere col lavoro parallelo.

## 6. Matching prudenziale

Il matcher produce un collegamento automatico soltanto quando un unico candidato supera tutti i controlli applicabili e l’XML ufficiale è coerente. Valuta:

1. riferimento esplicito dell’ordine in descrizione o causale;
2. provider coerente col riferimento, senza accettare marker di un marketplace diverso;
3. data documento compatibile con la data dell’ordine e con le regole storiche esistenti;
4. destinatario normalizzato, Paese e identificativi fiscali disponibili;
5. indirizzo con le tolleranze già ammesse dal matcher storico;
6. totale fatturabile canonico, incluse fee e rimborsi secondo le regole correnti;
7. tipo documento e, per TD04, fattura originaria e residuo accreditabile;
8. unicità del documento remoto, del documento locale e dell’ordine.

Il totale da solo non è mai sufficiente. La mancanza del riferimento ordine può essere tollerata soltanto quando provider, data, destinatario, identificativi, indirizzo e totale individuano un solo ordine aperto coerente.

Esiti:

- `MATCHED`: chiusura/aggiornamento automatici e audit;
- `UNMATCHED`: `Documenti → Da collegare`;
- `AMBIGUOUS`: attività `Da verificare`, senza modificare preparazioni;
- `PROFILE_CONFLICT`: XML valido ma incoerente col profilo o con lo snapshot locale; verifica manuale obbligatoria;
- `ERROR`: file o parsing non validi, con retry solo dopo correzione;
- `UNKNOWN_REMOTE_STATE`: readback incompleto o contraddittorio, con blocco fail-closed.

Una decisione manuale non attenua i vincoli fiscali: può selezionare fra candidati compatibili o confermare una discordanza consentita e motivata, ma non inventare importi, destinatari o documenti.

## 7. Stati Aruba/SdI

Il mapping riusa la macchina a stati canonica delle submission per la parte comune e non introduce sinonimi concorrenti:

| Evidenza Aruba/SdI osservata                                        | Stato canonico   | Ordine                   |
| ------------------------------------------------------------------- | ---------------- | ------------------------ |
| documento presente fra gli inviati, senza un esito SdI più avanzato | `SUBMITTED`      | preliminare              |
| acquisito/in elaborazione presso SdI                                | `SDI_PROCESSING` | successivo a `SUBMITTED` |
| consegnato                                                          | `DELIVERED`      | conclusivo               |
| mancata consegna con emissione valida                               | `NOT_DELIVERED`  | conclusivo               |
| scartato                                                            | `REJECTED`       | conclusivo               |
| etichetta assente, contraddittoria o non riconosciuta               | `UNKNOWN`        | bloccante, non ordinato  |

`UNKNOWN` è lo stato corrente del remote document; `UNKNOWN_REMOTE_STATE` è l’esito operativo del match/attività che mantiene il caso bloccato. Gli stati locali di preparazione, upload e validazione (`PENDING`, `UPLOADED`, `VALIDATED`, `VALIDATION_FAILED`, `READY_TO_SEND`, `REMOVED`, `RECONCILED`) restano esclusivi di `aruba_submissions` e non vengono inventati per un documento esterno. `RECONCILED` descrive la chiusura del tentativo locale, non sostituisce lo stato SdI del remote document.

Osservazioni fuori ordine restano nella cronologia ma non fanno regredire la proiezione. Gli stati conclusivi sono fra loro incompatibili, non ordinabili: una diversa conclusione successiva apre un conflitto invece di sovrascrivere la precedente. In particolare:

- uno stato consegnato, non consegnato o scartato non torna a elaborazione;
- `NOT_FOUND` dopo una precedente osservazione non significa cancellazione e apre `UNKNOWN_REMOTE_STATE`;
- metadati incompatibili con lo stesso ID remoto aprono un conflitto;
- una notifica ufficiale valida prevale sull’etichetta sintetica dell’elenco, senza cancellare l’osservazione precedente;
- un nuovo esito conclusivo incompatibile viene segnalato, non scelto arbitrariamente.

## 8. Blocco approvazione e override

Prima di approvare, numerare o preparare una fattura/TD04 il server rilegge lo stato Aruba:

- blocco immediato se Aruba non è mai stato inventariato per l’anno fiscale corrente;
- avviso non bloccante quando l’ultimo completamento ha più di un’ora;
- blocco quando ha più di 24 ore;
- blocco immediato se esiste una sessione fallita/incerta rilevante, un possibile match non risolto o una scansione iniziale incompleta.

La regola si applica anche agli endpoint massivi e a qualunque mutazione diretta, non soltanto alla UI.

Solo il titolare con `can_approve` può usare l’override dopo una verifica manuale sul pannello Aruba. L’override può superare esclusivamente il gate di freschezza — Aruba mai letto dall’app oppure ultimo inventario oltre 24 ore — quando il titolare ha verificato manualmente l’assenza di un documento remoto corrispondente. Non può superare una scansione incompleta, uno stato remoto incerto, un match possibile o ambiguo, un conflitto di profilo, una collisione di deduplicazione o un errore di parsing/file: questi casi devono essere risolti prima dell’approvazione.

La motivazione deve essere specifica e non generica; l’audit conserva utente, preparazione/documento, età del readback, condizione di freschezza superata, conferma della verifica manuale e timestamp. L’override vale per la sola transizione e non rende fresco Aruba, non chiude conflitti e non autorizza invii.

## 9. Impatto sulle pagine esistenti

Non viene aggiunta una destinazione primaria `Aruba`.

### Dashboard

- Aruba `Mai letto` o bloccante impedisce il messaggio `Tutto sotto controllo`.
- Mostra ultimo inventario riuscito, età, sessione in corso/errore e azione `Sincronizza Aruba ora`.
- I conteggi di preparazioni pronte e pagamenti in attesa espongono quanti casi non sono ancora coperti da un readback affidabile.
- Documenti non collegati, ambigui e stati remoti incerti entrano nei conteggi operativi.

### Documenti

- Aggiunge la vista interna `Da collegare`.
- Mostra origine `Hub Fatture`/`Aruba`, stato remoto, ultimo aggiornamento e collegamenti.
- Offre l’azione di collegamento/verifica soltanto sui candidati compatibili.

### Ordini e dettaglio

- Mostrano documento Aruba collegato, stato SdI e data dell’ultimo readback.
- Un ordine già fatturato viene rimosso dalle code di emissione in modo atomico.
- Ambiguità e conflitti rimandano a `Da verificare` senza chiudere il caso.

### Preparazione e approvazione

- Mostrano freschezza Aruba e possibile documento remoto.
- Approvazione/numerazione sono bloccate server-side secondo §8.
- L’override del titolare richiede motivo e conferma specifica.

### Attività

- Aggiunge attività per documento da collegare, match ambiguo, conflitto profilo, errore di scansione e stato remoto incerto.
- La cronologia espone sincronizzazioni e decisioni senza includere dati cliente superflui.

### Impostazioni

- Mostra stato dell’helper, dispositivo/sessione, ultima scansione completa, prossimo giro previsto e comando manuale.
- Consente revoca delle sessioni di sincronizzazione.
- Non mostra né verifica credenziali Aruba.

## 10. API interne e responsabilità

Gli endpoint esatti seguono le convenzioni React Router correnti. Le capacità minime sono:

- emissione/revoca della sessione read-only;
- claim/heartbeat/completamento della scansione con lease;
- ingest idempotente di pagine e osservazioni;
- import limitato verso Hub Fatture dei file ufficiali ammessi;
- stato sintetico per Dashboard e Impostazioni;
- richiesta di sincronizzazione immediata;
- risoluzione manuale di un match e override auditato.

Ogni endpoint valida ambiente, account, sessione, scope, dimensioni, schema e transizione. I payload grezzi non necessari non vengono conservati; errori e telemetria sono sanitizzati.

## 11. Osservabilità

Metriche e ricevute operative, senza dati cliente:

- età dell’ultimo inventario completo;
- durata, pagine e documenti osservati per sessione;
- nuovi, aggiornati, già noti, collegati, non collegati, ambigui e in conflitto;
- download ufficiali tentati/falliti;
- lock contesi, lease scaduti e riprese da cursore;
- transizioni remote ignorate perché regressive;
- approvazioni bloccate e override eseguiti;
- versione helper/browser e codice errore stabile.

La Dashboard avvisa dopo un’ora. Il blocco a 24 ore è un controllo applicativo, non un allarme esterno. Nessun log contiene nomi, indirizzi, identificativi fiscali, XML o token.

## 12. Piano di test

### Unitari

- parsing e normalizzazione dell’inventario sintetico;
- macchina a stati monotona, eventi fuori ordine e conflitti;
- deduplicazione per ID remoto, numero fiscale e hash XML;
- confinamento di ogni chiave di deduplicazione per account e ambiente;
- matching positivo e negativo per ogni segnale, incluso il divieto del solo totale;
- mapping esplicito degli stati comuni con `aruba_submissions`, terminali incompatibili e stati esclusivi dei tentativi locali;
- calcolo freschezza, avviso e blocco; override ammesso per la sola freschezza e rifiutato per match, conflitti, errori e stato remoto incerto;
- scope e scadenza della sessione read-only.

### Database

- vincoli di unicità e collisioni non fuse;
- vincolo di ownership esclusiva submission/remote document per file e notifiche, con collegamento locale opzionale;
- ingest idempotente di pagina e ripresa del cursore;
- lease esclusivo fra due dispositivi;
- collegamento atomico che chiude l’ordine e impedisce doppia fattura;
- backfill di submission/documenti esistenti e rollback expand/contract;
- audit append-only e immutabilità dei file.

I test DB usano un database dedicato al worktree. Le suite E2E che possono resettare lo schema girano serialmente con `--workers=1`.

### Aruba sintetica e contract

- elenchi multi-pagina, overlap e cambio di stato;
- scansione completa a ogni nuovo avvio anche in presenza di un cursore incrementale già avanzato;
- fattura e TD04 nate in Aruba;
- documento Hub già noto e documento esterno;
- file ufficiale assente, malformato o troppo grande;
- login/challenge/account/DOM inattesi;
- interruzione a metà pagina e riavvio;
- due helper concorrenti e `Sincronizza Aruba ora` durante una scansione;
- nessuna route di sync capace di caricare o inviare.

### E2E applicativi

- Dashboard non mostra `Tutto sotto controllo` con Aruba mai letto/obsoleto;
- lo scenario osservato con 6 preparazioni pronte, 1 pagamento in attesa e Aruba `Mai letto` mostra un avviso bloccante e non `Tutto sotto controllo`;
- `Documenti → Da collegare` e risoluzione prudenziale;
- ordine/preparazione già fatturati non più approvabili;
- ambiguità in `Da verificare`;
- blocchi a 0/24 ore, avviso a un’ora, override di freschezza del solo titolare e impossibilità di ignorare match/conflitti/stati incerti;
- aggiornamento SdI visibile sulle superfici interessate.

Gli E2E di Hub Fatture girano su Chromium e WebKit. L’helper gira contro la pagina Aruba sintetica su macOS e Windows con Chrome o Edge. WebKit è il motore open source usato da Playwright: verifica la compatibilità dell’app, ma non è Safari reale, non controlla l’app Safari installata e non può usare il suo normale profilo autenticato.

## 13. Tranche di implementazione e ownership

Le tranche possono avanzare in parallelo con gli altri lavori del candidato di collaudo se ogni agente possiede file distinti e integra sul `main` aggiornato. Ogni tranche parte da un worktree isolato.

### A. Schema e dominio inventario

Owner: DB/dominio.

File principali: nuova migrazione col primo numero libero, nuovi moduli `src/db/aruba-inventory*.server.ts`, test DB/unitari, aggiornamento del runner migrazioni.

Deliverable: tabelle, vincoli, cursori, lease, macchina a stati, ingest idempotente e backfill. Nessun cambio UI o helper.

### B. Lettura helper e pagina sintetica

Owner: helper/provider.

File principali: `scripts/aruba-helper.ts`, `src/aruba.ts`, route helper nuove, `app/routes/aruba-synthetic.tsx`, fixture e contract test Aruba.

Deliverable: sessione read-only, scansione completa/incrementale, paginazione, overlap, download selettivo e comando immediato. Nessun potere di upload/invio aggiunto al token di sync.

### C. Matcher e transizioni locali

Owner: ordini/documenti.

File principali: nuovo servizio matcher, integrazione mirata con `src/db/order-commands.server.ts`, query ordini/documenti e relativi test.

Deliverable: deduplicazione, riuso del matcher storico, collegamento atomico, stati di verifica e protezione dalla doppia emissione.

### D. Gate e interfaccia

Owner: UI/applicazione.

File principali: `app/routes/home.tsx`, `app/components/documents-view.tsx`, `app/routes/documents.tsx`, dettaglio ordine/preparazione, `app/components/activity-view.tsx`, `app/routes/settings.tsx`, `app/copy.it.ts` e query dedicate.

Deliverable: superfici §9, blocco server-side, override e test E2E. Questa tranche inizia dopo che A ha fissato le interfacce di lettura e C il contratto del gate.

### E. Integrazione e qualifica del candidato

Owner: integratore del candidato.

File principali: documentazione/evidenze correnti, runbook applicabili e test trasversali.

Deliverable: merge ordinato A → B/C → D, migrazioni rieseguite da zero, suite completa, verifica macOS/Windows sintetica, rollback provato e record di readiness aggiornato. La scansione reale resta un gate successivo e separatamente autorizzato.

Per ridurre conflitti, il contratto TypeScript condiviso fra A/B/C viene concordato in una prima patch piccola; `app/copy.it.ts`, il runner delle migrazioni e i documenti canonici hanno un solo owner d’integrazione. Gli agenti non rinumerano migrazioni al buio: verificano `main` immediatamente prima del merge.

## 14. Rollout e rollback

1. Integrare schema expand e codice incapace di approvare se l’inventario richiesto non esiste.
2. Backfill idempotente delle submission e dei documenti già presenti in Hub Fatture, verificando che il conteggio locale non cambi per duplicazione.
3. Attivare la funzione in Development contro la pagina sintetica e completare l’intera matrice di test.
4. Distribuire il candidato di collaudo con invii automatici ancora disabilitati.
5. Verificare che tutte le pagine gestiscano lo stato `mai letto` senza false rassicurazioni.
6. Solo con autorizzazione separata, eseguire la prima scansione reale dell’anno corrente in sola lettura; prima produrre una preview dei conteggi, poi applicare collegamenti automatici univoci e lasciare gli altri casi nelle code previste.
7. Confrontare inventario, documenti locali e code; nessun caso ambiguo viene chiuso in massa.
8. Completare il collaudo soltanto dopo ricevuta sanitizzata, test e assenza di stati incerti; il Canary Production non parte prima.

Rollback applicativo: disabilitare l’emissione delle sessioni di sync e tornare al fallback manuale, mantenendo inventario e osservazioni come dati append-only. Le nuove tabelle non vengono eliminate durante un rollback operativo. Un rollback di schema è provato su dati sintetici e riguarda soltanto la fase expand non ancora popolata; dopo la prima scansione reale si usa una migrazione correttiva, non una cancellazione distruttiva.

## 15. Gate di completamento prima del Canary Production

- prima scansione dell’anno corrente completa, ripetibile e con cursore verificato;
- nuova scansione completa dell’anno corrente a ogni riavvio, seguita soltanto da giri incrementali durante la sessione;
- documenti locali preesistenti deduplicati senza perdita o duplicazione;
- deduplicazione confinata per account e ambiente e ownership esclusiva di file/notifiche verificati;
- nessuna preparazione approvabile con Aruba mai letto, oltre 24 ore o stato incerto;
- Dashboard priva della contraddizione fra `Mai letto` e `Tutto sotto controllo`;
- collegamenti automatici limitati a casi univoci con XML ufficiale coerente;
- documenti non collegati, ambigui e in conflitto visibili nelle code previste;
- stato SdI monotono e cronologia append-only verificati;
- mapping degli stati remoto/locali verificato senza attribuire stati di upload a documenti esterni;
- una sola scansione concorrente e ripresa dopo crash provate;
- token read-only, device-bound, revocabile e con limite assoluto di 8 ore verificato incapace di upload/invio;
- suite unit, DB, provider sintetico, E2E Chromium/WebKit e helper macOS/Windows verde sull’HEAD candidato;
- rollback operativo e fallback manuale provati;
- nessun upload o invio Aruba reale eseguito da questo flusso;
- evidenza sanitizzata e record di readiness aggiornati.

## 16. Rischi residui e contromisure

- **DOM Aruba variabile:** locatori semantici, pagina sintetica, stop fail-closed e aggiornamento congiunto di contratto/test.
- **Paginazione non stabile:** ordine osservabile, overlap, upsert e cursore committato per pagina.
- **Falso positivo di matching:** segnali multipli, unicità, XML ufficiale e code manuali; mai il solo totale.
- **Due dispositivi:** lease server-side per account/ambiente e ingest idempotente.
- **Readback apparentemente fresco ma incompleto:** freschezza riferita all’ultimo inventario completato, non all’heartbeat.
- **Conflitti con il lavoro parallelo:** worktree isolati, migrazione col primo numero libero e singolo owner per file condivisi.
- **Dati personali in telemetria:** payload sanitizzati, conteggi aggregati e file ufficiali soltanto nello storage protetto.

## 17. Decisioni già chiuse

Non servono altre decisioni di prodotto prima di iniziare il codice. Naming puntuale, forma degli endpoint, durata del lease interno entro la sessione di 8 ore e ampiezza tecnica dell’overlap sono scelte di routine da calibrare con fixture e pannello osservato. Qualunque scoperta che richieda API Premium, automazione Safari, una nuova voce primaria di navigazione o una scansione reale non autorizzata riapre invece il perimetro e richiede il titolare.

## 18. Tracciabilità delle decisioni approvate

Questa matrice è la checklist di completezza rispetto alle decisioni che hanno originato il piano.

| Decisione                                                               | Traduzione esecutiva                                                                                                  |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Inventariare anche i documenti creati direttamente in Aruba             | Inventario provider-first separato da `aruba_submissions` (§§1, 3, 5)                                                 |
| Acquisire fatture e TD04 dell’anno fiscale corrente                     | Prima scansione e scansione completa a ogni avvio (§§2, 4.2)                                                          |
| Deduplicare i documenti già presenti in Hub Fatture                     | Backfill e chiavi per ID remoto, numero fiscale e hash XML, sempre confinate per account/ambiente (§§2, 5, 14)        |
| Collegare automaticamente soltanto casi univoci con XML coerente        | Matcher prudenziale e stati di esito (§6)                                                                             |
| Mandare discordanti e ambigui in `Da verificare`                        | `AMBIGUOUS`, `PROFILE_CONFLICT` e attività dedicate (§§6, 9)                                                          |
| Conservare i documenti senza ordine in `Documenti → Da collegare`       | `UNMATCHED`, senza creare ordini (§§1, 6, 9)                                                                          |
| Scansione completa all’avvio, poi ogni 15 minuti e su comando           | Ciclo helper e test di riavvio (§§4, 12, 15)                                                                          |
| Nessun avvio automatico dell’helper al login nella prima versione       | Non-obiettivo esplicito (§2)                                                                                          |
| Bloccare approvazione e numerazione con readback inaffidabile           | Gate server-side su ogni mutazione (§8)                                                                               |
| Avvisare dopo un’ora e bloccare dopo 24 ore o se mai letto              | Soglie di freschezza e Dashboard (§§8, 9, 11)                                                                         |
| Consentire un override solo al titolare dopo verifica manuale           | Override limitato alla sola freschezza, motivato e auditato; conflitti e possibili duplicati non sono superabili (§8) |
| Separare la sessione di sync dai batch                                  | Scope `ARUBA_READ_SYNC`, device-bound, revocabile, ruotato, massimo 8 ore e incapace di upload/invio (§4.1)           |
| Evitare due sync concorrenti anche da dispositivi diversi               | Lease unico per account/ambiente e ripresa dal cursore (§4.3)                                                         |
| Usare paginazione, cursore e overlap                                    | Commit per pagina, incrementali idempotenti e ripresa (§4.2)                                                          |
| Scaricare file soltanto quando necessari                                | Download selettivo per nuovi, cambiati, candidati o incompleti (§4.2)                                                 |
| Riutilizzare il matcher storico esistente                               | Integrazione col servizio storico, senza duplicare le regole (§§5, 6, 13)                                             |
| Aggiornare gli stati SdI senza regressioni                              | Vocabolario condiviso, osservazioni append-only e terminali incompatibili (§7)                                        |
| Modificare le pagine esistenti senza aggiungere una voce Aruba primaria | Dashboard, Documenti, Ordini, Preparazione, Attività e Impostazioni (§9)                                              |
| Correggere il caso Dashboard osservato                                  | Regressione con 6 preparazioni, 1 pagamento, `Mai letto` e divieto di `Tutto sotto controllo` (§§1, 12)               |
| Usare un solo helper su macOS e Windows                                 | TypeScript/Playwright con Chrome o Edge e profilo dedicato (§4.1)                                                     |
| Continuare a usare Safari per Hub Fatture e fallback manuale            | Safari non viene automatizzato; WebKit Playwright non è Safari reale e non usa il suo profilo (§§2, 4.1, 12)          |
| Non ospitare un browser Aruba sulla VPS                                 | Helper esclusivamente locale e polling remoto escluso (§2)                                                            |
| Conservare credenziali e sessione Aruba sul dispositivo                 | Nessun cookie, password, OTP o sessione transita in Hub Fatture (§3)                                                  |
| Fermarsi davanti a CAPTCHA, challenge o account inatteso                | Arresto/sospensione fail-closed (§§3, 4.1)                                                                            |
| Consentire lavoro parallelo senza interferire col collaudo corrente     | Tranche, ownership esclusiva dei file condivisi e worktree isolati (§13)                                              |
| Completare questa capacità prima del Canary Production                  | Collocazione, rollout e gate finali (§§14, 15)                                                                        |
| Autorizzare separatamente la prima scansione reale                      | Confine esplicito in apertura, perimetro e rollout (§§2, 14)                                                          |
| Non autorizzare upload, invii Aruba, e-mail reali, deploy o release     | Non-obiettivi e gate finale (§§2, 15)                                                                                 |
