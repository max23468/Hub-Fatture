# Piano esecutivo — riconciliazione Aruba in entrata

Stato: approvato per l’implementazione

Collocazione: candidato di collaudo, da completare prima del Canary Production

Dipendenza esterna: la prima scansione del pannello Aruba reale richiede un’autorizzazione separata

## 1. Esito atteso

Hub Fatture mantiene un inventario locale dei documenti presenti in Aruba, anche quando sono stati creati o inviati senza passare da Hub Fatture. L’inventario viene riconciliato con ordini, preparazioni e documenti locali prima che una nuova fattura possa essere approvata e numerata.

Il risultato operativo è osservabile:

- una preparazione già fatturata direttamente in Aruba non può produrre una seconda fattura;
- i progressi Aruba/SdI aggiornano Hub Fatture anche per documenti nati fuori dall’app;
- un collegamento certo con esito che conferma l’emissione chiude automaticamente il caso locale;
- un collegamento ambiguo o discordante compare in `Da verificare`;
- un documento Aruba privo di ordine locale resta consultabile in `Documenti → Da collegare`, senza creare ordini inventati;
- Dashboard, dettagli e Attività non possono dichiarare che è tutto sotto controllo quando Aruba non è mai stato letto o il readback è obsoleto.

Il caso osservato che motiva il lavoro viene conservato soltanto in forma sanitizzata: una preparazione locale pronta risultava già fatturata in Aruba ed è stata chiusa manualmente per evitare una seconda emissione; una discordanza anagrafica richiedeva verifica, mentre l’identificativo fiscale era coerente. Il flusso progettato deve rilevare automaticamente il documento e lasciare all’utente soltanto l’eventuale decisione sulla discordanza.

La fotografia operativa osservata sulla Dashboard costituisce uno scenario di regressione esplicito: 6 preparazioni pronte, 1 pagamento in attesa, Aruba `Mai letto` e contemporaneamente il riepilogo `Tutto sotto controllo`. Con qualunque quantità di lavoro potenzialmente fatturabile, Aruba mai letto o bloccante deve impedire quel riepilogo e rendere evidente che Hub Fatture non può ancora escludere progressi esterni.

## 2. Perimetro e non-obiettivi

### Compreso

- inventario provider-first di fatture e TD04 Aruba indipendente dai batch di Hub Fatture;
- prima acquisizione di tutti i documenti dell’anno fiscale corrente, estesa all’indietro fino al più remoto ordine ancora riconciliabile e a ogni documento non terminale già osservato negli stream precedenti;
- deduplicazione dei documenti già presenti localmente, inclusi i 48 osservati al momento del rilievo e da ricontare prima della migrazione;
- prima scansione completa della finestra Aruba rilevante e sincronizzazioni incrementali con sovrapposizione agli avvii successivi;
- matching prudenziale e collegamento automatico soltanto quando univoco;
- aggiornamento monotono degli stati Aruba/SdI;
- blocco server-side di approvazione e numerazione quando il readback non è affidabile;
- override eccezionale del solo titolare, motivato e auditato;
- UI sulle superfici esistenti e fallback manuale.

### Escluso

- creazione di ordini locali per documenti presenti soltanto in Aruba;
- uso di Web Services Premium, API private o endpoint scoperti tramite DevTools;
- browser Aruba sulla VPS o polling remoto non presidiato;
- helper di caricamento e trasmissione del pannello Aruba con Safari; il preferito di sola lettura supporta anche Safari;
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
6. Credenziali, cookie, password, OTP e sessione Aruba restano nel browser locale supportato e non transitano in Hub Fatture.
7. L’autorizzazione è verificata sul server; disabilitare un pulsante non sostituisce il blocco della mutazione.

## 4. Flusso operativo

### 4.1 Avvio e sessione

La sincronizzazione in entrata usa il preferito JavaScript `Sincronizza Aruba` in Safari, Chrome o Edge su computer. Il preferito resta salvato senza contenere credenziali o token; a ogni uso apre un ponte Hub Fatture autenticato che crea una nuova sessione temporanea di sola lettura. L'helper TypeScript/Playwright con profilo persistente Chrome o Edge resta un componente distinto, riservato al caricamento e alla trasmissione.

All’avvio esplicito del preferito:

1. apre il ponte autenticato e richiede a Hub Fatture una sessione temporanea di sola sincronizzazione;
2. verifica origine, ambiente e riferimento dell’account atteso;
3. usa la sessione Aruba già aperta nel browser, lasciando login e challenge all’utente; dalla Home chiede di selezionare personalmente `Fatture inviate`, quindi attende richiesta e griglia stabili;
4. esegue una scansione completa della finestra Aruba rilevante al primo avvio, quindi usa cursori e sovrapposizione temporale agli avvii successivi, ampliandola alla data ordine più remota dei preflight pendenti; un nuovo stream, un cursore assente o un'incongruenza forzano di nuovo il giro completo;
5. invia soltanto righe visibili sanitizzate agli endpoint interni in allowlist;
6. completa la sessione e chiude il ponte, senza sincronizzazione in background.
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

La prima scansione enumera tutte le fatture e TD04 dell’anno fiscale corrente, con paginazione esplicita. Estende inoltre il limite temporale all’indietro fino alla data del più remoto ordine che Hub Fatture può ancora riconciliare e rilegge qualunque remote document non terminale già noto, anche se appartiene a un anno precedente. Ogni pagina viene acquisita in ordine stabile e porta un cursore opaco composto dai riferimenti osservabili necessari a riprendere il lavoro. Il cursore diventa definitivo soltanto dopo il commit dell’intera pagina.

Ogni avvio successivo è incrementale e riparte dal cursore con una finestra di sovrapposizione temporale. L’overlap intercetta ritardi e cambi di stato; gli upsert idempotenti assorbono le ripetizioni. Un cambio d’anno apre un nuovo stream senza cancellare quello precedente e forza un giro completo perché il nuovo stream non possiede ancora un cursore qualificato. Lo stream precedente resta nel manifest finché contiene documenti non terminali o copre ordini ancora riconciliabili. Una copertura incoerente o un cursore mancante forza allo stesso modo una nuova scansione completa.

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

Collegamenti fra inventario remoto e documento, ordine, preparazione o rimborso locale:

- stato `MATCHED`, `UNMATCHED`, `AMBIGUOUS`, `PROFILE_CONFLICT`, `ERROR` o `UNKNOWN_REMOTE_STATE`;
- metodo e segnali usati;
- candidati valutati senza dati superflui;
- decisione automatica o manuale, autore, motivazione e timestamp;
- versione del matcher per poter rivalutare i soli casi non definitivi.

Il collegamento univoco a un ordine riusa il matcher storico esistente. Soltanto un documento `DELIVERED` o `NOT_DELIVERED` viene importato come documento storico `ARUBA_HISTORY` quando non esiste ancora localmente; se il documento Hub emesso esiste già, il remote document viene collegato a quello e all’eventuale `aruba_submission`, senza duplicarlo. Negli stati `SUBMITTED`, `SDI_PROCESSING`, `REJECTED` o incerti, XML e notifiche restano in `aruba_files`/`sdi_notifications` di proprietà del remote document e il match punta all’ordine o alla preparazione senza creare una riga `documents`: il vincolo corrente di `ARUBA_HISTORY` approvato e l’unicità fiscale restano riservati ai documenti la cui emissione è confermata.

- `DELIVERED` e `NOT_DELIVERED` confermano l’emissione: il documento partecipa all’unicità delle fatture emesse e l’ordine viene chiuso/escluso da nuove emissioni.
- `SUBMITTED` e `SDI_PROCESSING` sospendono approvazione e numerazione del caso compatibile finché arriva un esito conclusivo, senza chiudere l’ordine come fatturato.
- `REJECTED` conserva inventario remoto, XML/file ufficiali, match e audit senza creare `ARUBA_HISTORY`; non occupa il vincolo delle fatture emesse e lascia l’ordine disponibile per la nuova revisione o riedizione prevista dalla procedura di scarto.
- `UNKNOWN` o conclusioni incompatibili restano fail-closed e richiedono verifica.

Quando l’emissione è confermata e l’ordine collegato appartiene a una preparazione che contiene anche altri ordini, il match non chiude l’intera preparazione e non lascia invariata la bozza materializzata. Nella stessa transazione Hub Fatture:

1. collega l’ordine coperto al documento storico e lo esclude da qualunque futura emissione;
2. invalida la bozza corrente e le sue righe/materializzazioni, conservando l’audit della revisione superata;
3. separa gli ordini residui e rigenera una nuova bozza/preparazione soltanto con quelli ancora fatturabili, applicando nuovamente identità, raggruppamento, importi e controlli correnti;
4. chiude la preparazione originaria soltanto se non resta alcun ordine fatturabile.

Qualunque errore esegue il rollback dell’intera transazione: non è ammesso uno stato in cui l’ordine risulta collegato ad Aruba ma resta anche in una bozza approvabile, né uno in cui gli ordini residui scompaiono dalla coda.

Per una TD04 esterna il matcher parte dalla fattura originaria e individua l’insieme esatto e univoco dei rimborsi completati coperti, rispettando importi provider, residuo accreditabile e limiti per ordine. Nella stessa transazione che collega il documento storico blocca le righe rimborso, verifica che `credit_document_id` sia ancora nullo oppure punti già allo stesso documento e collega tutti e soli i rimborsi coperti. Un rimborso già associato a un’altra TD04, un insieme soltanto parziale o ambiguo oppure uno stato diverso da `DELIVERED`/`NOT_DELIVERED` non viene contabilizzato automaticamente: apre conflitto o verifica e non modifica il residuo. Il processo che genera TD04 rilegge il collegamento sotto lo stesso lock, così il rimborso non può essere riaccreditato durante una corsa concorrente.

### `aruba_sync_sessions`

Lease e ricevuta delle sessioni di sola lettura: dispositivo, versione helper/browser, account/ambiente attesi, stato, avvio, ultimo heartbeat, scadenza assoluta, cursore iniziale/finale, conteggi sanitizzati ed errore. Il token è conservato soltanto come hash.

### `sync_cursors`

Usare lo schema cursori esistente con provider `ARUBA` e stream separati per anno e tipo inventario. Conservare cursore, overlap e ultimo completamento di una scansione completa. Non sovraccaricare il cursore dei batch.

### Rapporto con le tabelle esistenti

- `aruba_submissions`: rimane il registro dei tentativi di upload/invio generati da Hub Fatture.
- `aruba_remote_documents`: rappresenta ciò che Aruba contiene, indipendentemente dall’origine.
- `documents`: conserva la rappresentazione fiscale locale immutabile quando esiste un XML ufficiale valido, un collegamento consentito e lo stato `DELIVERED` o `NOT_DELIVERED`; `ARUBA_HISTORY` resta `APPROVED` e viene esteso in modo esplicito alle fatture e alle TD04 emesse, mantenendo per queste ultime il riferimento alla fattura originaria. Stati intermedi, scarti e stati incerti non creano righe `documents`.
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
8. unicità del documento remoto, del documento locale e dell’ordine;
9. per TD04, insieme esatto dei rimborsi completati ancora non accreditati e importi compatibili con il residuo della fattura originaria.

Il totale da solo non è mai sufficiente. La mancanza del riferimento ordine può essere tollerata soltanto quando provider, data, destinatario, identificativi, indirizzo e totale individuano un solo ordine aperto coerente.

Esiti:

- `MATCHED`: collegamento certo e audit; chiusura, sospensione o riedizione dipendono dallo stato remoto canonico;
- `UNMATCHED`: `Documenti → Da collegare`;
- `AMBIGUOUS`: attività `Da verificare`, senza modificare preparazioni;
- `PROFILE_CONFLICT`: XML valido ma incoerente col profilo o con lo snapshot locale; verifica manuale obbligatoria;
- `ERROR`: file o parsing non validi, con retry solo dopo correzione;
- `UNKNOWN_REMOTE_STATE`: readback incompleto o contraddittorio, con blocco fail-closed.

Una decisione manuale non attenua i vincoli fiscali: può selezionare fra candidati compatibili o confermare una discordanza consentita e motivata, ma non inventare importi, destinatari o documenti. Se la conferma su `DELIVERED`/`NOT_DELIVERED` chiude un ordine, consuma l’unicità di una fattura emessa o collega rimborsi a una TD04, è una transizione fiscale irreversibile riservata al titolare con `can_approve`; il controllo è server-side anche sulle chiamate dirette.

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

Queste soglie descrivono la salute globale ma non autorizzano da sole un’approvazione. Ogni richiesta di approvazione avvia o riusa soltanto un preflight Aruba completato dopo la richiesta per quella specifica revisione: l’helper esegue subito un readback on-demand della finestra necessaria a trovare il documento candidato, importa ogni possibile risultato e restituisce una ricevuta vincolata ad account, ambiente, preparazione, `draft_version`, hash della proiezione, ordini/rimborsi inclusi e watermark dell’inventario. L’approvazione resta bloccata fino al completamento; un match, uno stato incerto, un errore o una modifica di bozza/inventario invalida la ricevuta. Dopo il successo la stessa richiesta deve essere confermata entro cinque minuti e consuma la ricevuta; trascorso il limite o per un nuovo tentativo serve un altro preflight. Le approvazioni massive usano un’unica scansione on-demand ma una ricevuta/manifest che elenca e vincola ogni preparazione.

Se l’helper non è aperto, la UI chiede di avviarlo oppure offre al solo titolare il readback manuale specifico/full previsto sotto: non approva usando semplicemente l’ultimo giro periodico. La finestra di cinque minuti riduce il rischio residuo di una creazione esterna concorrente, che il pannello Aruba privo di API/lock non consente di eliminare; la conferma mostra l’istante del preflight.

La regola si applica anche agli endpoint massivi e a qualunque mutazione diretta, non soltanto alla UI.

Solo il titolare con `can_approve` può usare l’override dopo un readback manuale specifico eseguito per la revisione corrente nel pannello Aruba. L’override può sostituire esclusivamente il preflight automatico/freschezza quando il titolare ha verificato l’assenza del documento remoto corrispondente nella finestra di ricerca indicata da Hub Fatture; è vincolato agli stessi ordini/rimborsi, revisione e hash e scade dopo cinque minuti. Non può superare una scansione manuale incompleta, uno stato remoto incerto, un match possibile o ambiguo, un conflitto di profilo, una collisione di deduplicazione o un errore di parsing/file: questi casi devono essere risolti prima dell’approvazione.

La motivazione deve essere specifica e non generica; l’audit conserva utente, preparazione/documento, età del readback, condizione di freschezza superata, conferma della verifica manuale e timestamp. L’override vale per la sola transizione e non rende fresco Aruba, non chiude conflitti e non autorizza invii.

### 8.1 Readback manuale specifico e completo

Quando l’inventario globale è sano ma l’helper non è disponibile per il preflight, Hub Fatture può aprire al solo titolare un readback manuale specifico. La checklist genera tutte le ricerche compatibili con riferimenti ordine/rimborso, tipo, data, destinatario, identificativi e importo; per ciascuna il titolare acquisisce ogni riga di tutte le pagine e importa l’evidenza ufficiale di ogni possibile candidato. La ricevuta è valida soltanto per revisione/hash correnti, scade dopo cinque minuti e non aggiorna la freschezza globale. Qualunque possibile match o ricerca incompleta mantiene l’approvazione bloccata.

Quando invece una scansione si arresta o l’inventario globale è incompleto, il fallback non usa l’override per ignorare l’errore e il readback specifico non basta. Hub Fatture apre una sessione guidata di readback manuale completo per la stessa finestra che avrebbe coperto la scansione automatica e mostra al titolare gli stream obbligatori per anno/tipo, il limite temporale, i documenti non terminali già noti e gli errori da risolvere.

Se il preferito non è disponibile, il titolare percorre nel pannello Aruba ogni stream fino alla pagina terminale usando il proprio browser. Per ogni pagina acquisisce in Hub Fatture tutte le righe visibili con gli stessi metadati canonici usati dall’inventario automatico — inclusi ID remoto quando presente, tipo, numero/serie/anno, data, stato, destinatario/identificativi normalizzati e totale — oppure importa un export ufficiale completo che contenga l’intero stream. Registra inoltre filtri applicati, ordinale, conteggio mostrato quando disponibile, estremi tecnici primo/ultimo e assenza della pagina successiva; importa XML/P7M/notifiche ufficiali per ogni documento nuovo, cambiato, candidato o privo di evidenza.

Il server verifica che il numero di righe acquisite coincida con quello della pagina/export, che ogni riga sia presente una sola volta, che sequenza, conteggi ed estremi siano coerenti e che tutti gli stream terminino senza errori irrisolti. Se Aruba non espone un conteggio, la ricevuta richiede comunque tutte le righe, la pagina terminale e gli estremi di ogni pagina. Una ricevuta con sole quantità, estremi o attestazioni, priva del contenuto integrale delle righe o di un export ufficiale completo, non può marcare l’inventario come completo e mantiene il gate bloccato.

Soltanto il titolare con `can_approve` può finalizzare la ricevuta manuale. La finalizzazione aggiorna l’ultimo inventario completo con provenienza `MANUAL`, chiude l’errore operativo della scansione sostituita e rende di nuovo applicabili i normali gate; non cancella la sessione fallita né può superare file non validi, stati remoti incerti, collisioni, match possibili/ambigui o conflitti di profilo, che devono essere risolti con evidenza ufficiale. La ricevuta conserva finestra, stream/pagine, conteggi sanitizzati, hash dei file importati, autore e timestamp senza dati cliente.

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
- Offre l’azione di collegamento/verifica soltanto sui candidati compatibili; l’account `Codex` può preparare la proposta, ma solo il titolare può confermare un match manuale con effetti fiscali.

### Ordini e dettaglio

- Mostrano documento Aruba collegato, stato SdI e data dell’ultimo readback.
- Un ordine già fatturato viene rimosso dalle code di emissione in modo atomico.
- Se era parte di una preparazione multi-ordine, la bozza viene invalidata e gli ordini residui vengono separati e rigenerati atomicamente; non vengono né fatturati insieme al match né rimossi dalla coda.
- Ambiguità e conflitti rimandano a `Da verificare` senza chiudere il caso.

### Preparazione e approvazione

- Mostrano freschezza Aruba e possibile documento remoto.
- `Approva` avvia il preflight on-demand, mostra avanzamento/istante del risultato e resta bloccato finché la ricevuta vincolata alla revisione corrente non è pronta.
- Approvazione/numerazione sono bloccate server-side secondo §8.
- L’override del titolare richiede motivo e conferma specifica.

### Attività

- Aggiunge attività per documento da collegare, match ambiguo, conflitto profilo, errore di scansione e stato remoto incerto.
- La cronologia espone sincronizzazioni e decisioni senza includere dati cliente superflui.

### Impostazioni

- Mostra stato dell’helper, dispositivo/sessione, ultima scansione completa, prossimo giro previsto e comando manuale.
- Quando l’helper è bloccato, offre `Completa readback manuale` con checklist degli stream e ricevuta; la finalizzazione è visibile soltanto al titolare e resta protetta server-side da `can_approve`.
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
- richiesta/completamento/consumo del preflight on-demand vincolato alla revisione o al manifest massivo;
- apertura/compilazione della sessione di readback manuale e finalizzazione auditata;
- risoluzione manuale di un match e override auditato.

Ogni endpoint valida ambiente, account, sessione, scope, dimensioni, schema e transizione. La finalizzazione del readback manuale e qualunque risoluzione manuale che chiuda un ordine, consumi l’unicità di una fattura emessa o colleghi rimborsi a una TD04 richiedono `can_approve` sul server; l’account `Codex` può consultare, importare evidenze e preparare la decisione, ma non confermarne gli effetti fiscali. I payload grezzi non necessari non vengono conservati; errori e telemetria sono sanitizzati.

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
- effetti distinti dello stato remoto: solo `DELIVERED`/`NOT_DELIVERED` chiudono l’ordine o contabilizzano rimborsi, `SUBMITTED`/`SDI_PROCESSING` sospendono e `REJECTED` consente la riedizione;
- materializzazione `ARUBA_HISTORY` consentita soltanto per `DELIVERED`/`NOT_DELIVERED`; scarti e stati non emessi restano nel remote inventory senza consumare unicità fiscale;
- ricevuta preflight vincolata a revisione/hash/ordini-rimborsi, scadenza di cinque minuti, consumo singolo e invalidazione su modifica o nuovo possibile match;
- calcolo freschezza, avviso e blocco; override ammesso per la sola freschezza e rifiutato per match, conflitti, errori e stato remoto incerto;
- validazione della ricevuta manuale: tutte le righe di ogni stream/pagina oppure export ufficiale completo, pagina terminale, nessun buco/duplicato e nessun errore irrisolto;
- scope e scadenza della sessione read-only.

### Database

- vincoli di unicità e collisioni non fuse;
- vincolo di ownership esclusiva submission/remote document per file e notifiche, con collegamento locale opzionale;
- ingest idempotente di pagina e ripresa del cursore;
- lease esclusivo fra due dispositivi;
- collegamento atomico che chiude l’ordine e impedisce doppia fattura;
- match parziale di una preparazione multi-ordine: invalidazione della bozza, esclusione del solo ordine coperto, rigenerazione dei residui e rollback totale su errore;
- TD04 esterna collegata atomicamente a tutti e soli i rimborsi coperti, con lock sul residuo e concorrenza contro `process_refund` incapace di creare un secondo accredito;
- fattura esterna scartata archiviata e collegata come tentativo, senza consumare l’unicità delle fatture emesse né chiudere l’ordine;
- vincolo `ARUBA_HISTORY = APPROVED` rispettato: nessuna riga `documents` per `REJECTED`, intermedi o incerti; file e notifiche restano di proprietà del remote document;
- approvazione concorrente con un preflight: una sola ricevuta consumabile, revisione/hash ricontrollati sotto lock e ricevuta stale rifiutata;
- finalizzazione concorrente/idempotente del readback manuale e conservazione della sessione automatica fallita;
- rifiuto server-side dell’account senza `can_approve` sia sulla finalizzazione manuale sia sulla risoluzione di match con effetti fiscali;
- backfill di submission/documenti esistenti e rollback expand/contract;
- audit append-only e immutabilità dei file.

I test DB usano un database dedicato al worktree. Le suite E2E che possono resettare lo schema girano serialmente con `--workers=1`.

### Aruba sintetica e contract

- elenchi multi-pagina, overlap e cambio di stato;
- primo avvio completo, secondo avvio incrementale con overlap e ritorno al completo quando un nuovo stream o un cursore assente lo richiedono;
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
- preparazione con due ordini e match Aruba su uno solo: bozza precedente non approvabile e nuovo residuo contenente esclusivamente l’altro ordine;
- TD04 esterna emessa su rimborsi già importati: rimborsi collegati al documento e nessuna nuova bozza TD04 al giro successivo o in concorrenza;
- fattura esterna `REJECTED`: evidenza e scarto visibili, ordine ancora rieditabile e nessuna falsa chiusura come già fatturato;
- approvazione richiesta subito dopo una fattura creata direttamente in Aruba: il preflight on-demand la acquisisce e impedisce la doppia emissione prima del successivo giro periodico;
- ricevuta preflight scaduta o bozza modificata: nuova approvazione bloccata fino a un nuovo readback;
- helper indisponibile/DOM variato: readback manuale completo rende di nuovo operativi i gate soltanto dopo acquisizione di ogni riga di tutti gli stream, o export ufficiale completo, ed evidenze richieste;
- account `Codex`: può preparare una risoluzione, ma la chiamata diretta agli endpoint di finalizzazione manuale o match fiscale restituisce accesso negato e non modifica ordini/rimborsi;
- ambiguità in `Da verificare`;
- blocchi a 0/24 ore, avviso a un’ora, override di freschezza del solo titolare e impossibilità di ignorare match/conflitti/stati incerti;
- aggiornamento SdI visibile sulle superfici interessate.

Gli E2E di Hub Fatture e del preferito girano su Chromium e WebKit. L’helper distinto di trasmissione gira contro la pagina Aruba sintetica su macOS e Windows con Chrome o Edge. WebKit è il motore open source usato da Playwright: verifica il motore usato da Safari, ma non sostituisce la qualifica manuale di Safari reale sul pannello Aruba e non usa il suo normale profilo autenticato.

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
- prima scansione completa della finestra rilevante, compresi il più remoto ordine riconciliabile e tutti i documenti precedenti non terminali, seguita da avvii incrementali con overlap e ritorno automatico al completo quando necessario;
- documenti locali preesistenti deduplicati senza perdita o duplicazione;
- deduplicazione confinata per account e ambiente e ownership esclusiva di file/notifiche verificati;
- nessuna preparazione approvabile con Aruba mai letto, oltre 24 ore o stato incerto;
- nessuna preparazione approvabile sulla sola freschezza periodica: preflight Aruba on-demand completato dopo la richiesta, vincolato alla revisione/hash e consumato entro cinque minuti;
- Dashboard priva della contraddizione fra `Mai letto` e `Tutto sotto controllo`;
- collegamenti automatici limitati a casi univoci con XML ufficiale coerente;
- match parziale di preparazioni multi-ordine verificato atomico, senza duplicare l’ordine coperto né perdere i residui;
- TD04 esterne emesse collegate atomicamente ai rimborsi coperti senza consentire un secondo accredito;
- ordini con documento esterno scartato disponibili per revisione/riedizione e mai chiusi come fatturati;
- stati esterni `REJECTED`, intermedi o incerti verificati assenti da `documents`/`ARUBA_HISTORY` e presenti soltanto nell’inventario/file remoti finché non esiste un esito emesso;
- documenti non collegati, ambigui e in conflitto visibili nelle code previste;
- stato SdI monotono e cronologia append-only verificati;
- mapping degli stati remoto/locali verificato senza attribuire stati di upload a documenti esterni;
- una sola scansione concorrente e ripresa dopo crash provate;
- token read-only, device-bound, revocabile e con limite assoluto di 8 ore verificato incapace di upload/invio;
- fallback manuale completo verificato capace di sostituire una scansione fallita soltanto acquisendo ogni riga o un export ufficiale completo, senza superare errori documentali o casi incerti;
- finalizzazione del readback manuale e match manuali con effetti fiscali verificati riservati a `can_approve`, inclusa chiamata diretta dell’account `Codex`;
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

Non servono altre decisioni di prodotto prima di iniziare il codice. Naming puntuale, forma degli endpoint, durata del lease interno entro la sessione di 8 ore e ampiezza tecnica dell’overlap sono scelte di routine da calibrare con fixture e pannello osservato. Qualunque scoperta che richieda API Premium, un browser ulteriore, una nuova voce primaria di navigazione o una scansione reale non autorizzata riapre invece il perimetro e richiede il titolare.

## 18. Tracciabilità delle decisioni approvate

Questa matrice è la checklist di completezza rispetto alle decisioni che hanno originato il piano.

| Decisione                                                               | Traduzione esecutiva                                                                                                                           |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Inventariare anche i documenti creati direttamente in Aruba             | Inventario provider-first separato da `aruba_submissions` (§§1, 3, 5)                                                                          |
| Acquisire fatture e TD04 dell’anno fiscale corrente                     | Prima scansione completa estesa agli ordini ancora riconciliabili e ai precedenti non terminali, poi avvii incrementali con overlap (§§2, 4.2) |
| Deduplicare i documenti già presenti in Hub Fatture                     | Backfill e chiavi per ID remoto, numero fiscale e hash XML, sempre confinate per account/ambiente (§§2, 5, 14)                                 |
| Collegare automaticamente soltanto casi univoci con XML coerente        | Matcher prudenziale e stati di esito (§6)                                                                                                      |
| Mandare discordanti e ambigui in `Da verificare`                        | `AMBIGUOUS`, `PROFILE_CONFLICT` e attività dedicate (§§6, 9)                                                                                   |
| Conservare i documenti senza ordine in `Documenti → Da collegare`       | `UNMATCHED`, senza creare ordini (§§1, 6, 9)                                                                                                   |
| Prima scansione completa, poi avvii incrementali espliciti              | Ciclo del preferito, overlap e test di nuovo avvio (§§4, 12, 15)                                                                               |
| Nessun avvio automatico dell’helper al login nella prima versione       | Non-obiettivo esplicito (§2)                                                                                                                   |
| Bloccare approvazione e numerazione con readback inaffidabile           | Gate server-side su ogni mutazione (§8)                                                                                                        |
| Avvisare dopo un’ora e bloccare dopo 24 ore o se mai letto              | Soglie di freschezza e Dashboard (§§8, 9, 11)                                                                                                  |
| Evitare la finestra di doppia emissione fra due giri periodici          | Preflight on-demand per ogni approvazione, vincolato alla revisione/hash, monouso e valido cinque minuti (§8)                                  |
| Consentire un override solo al titolare dopo verifica manuale           | Override limitato alla sola freschezza, motivato e auditato; conflitti e possibili duplicati non sono superabili (§8)                          |
| Mantenere il fallback utilizzabile dopo una scansione fallita           | Readback manuale di ogni riga o export ufficiale completo, import dei file necessari, ricevuta e finalizzazione `can_approve` (§8.1)           |
| Separare la sessione di sync dai batch                                  | Scope `ARUBA_READ_SYNC`, device-bound, revocabile, ruotato, massimo 8 ore e incapace di upload/invio (§4.1)                                    |
| Evitare due sync concorrenti anche da dispositivi diversi               | Lease unico per account/ambiente e ripresa dal cursore (§4.3)                                                                                  |
| Usare paginazione, cursore e overlap                                    | Commit per pagina, incrementali idempotenti e ripresa (§4.2)                                                                                   |
| Scaricare file soltanto quando necessari                                | Download selettivo per nuovi, cambiati, candidati o incompleti (§4.2)                                                                          |
| Riutilizzare il matcher storico esistente                               | Integrazione col servizio storico, senza duplicare le regole (§§5, 6, 13)                                                                      |
| Evitare doppie TD04 su rimborsi già coperti da Aruba                    | Link atomico dei rimborsi, lock sul residuo e regressione concorrente (§§5, 6, 12, 15)                                                         |
| Aggiornare gli stati SdI senza regressioni                              | Vocabolario condiviso, osservazioni append-only e terminali incompatibili (§7)                                                                 |
| Non chiudere come fatturato un documento scartato                       | Effetti distinti per stato: conferma solo su `DELIVERED`/`NOT_DELIVERED`, sospensione sugli intermedi e riedizione su `REJECTED` (§5)          |
| Non materializzare gli scarti come documenti storici approvati          | XML/notifiche su remote inventory; `ARUBA_HISTORY` soltanto per documenti emessi (§5)                                                          |
| Modificare le pagine esistenti senza aggiungere una voce Aruba primaria | Dashboard, Documenti, Ordini, Preparazione, Attività e Impostazioni (§9)                                                                       |
| Correggere il caso Dashboard osservato                                  | Regressione con 6 preparazioni, 1 pagamento, `Mai letto` e divieto di `Tutto sotto controllo` (§§1, 12)                                        |
| Usare un solo helper su macOS e Windows                                 | TypeScript/Playwright con Chrome o Edge e profilo dedicato (§4.1)                                                                              |
| Usare Safari anche per l'inventario senza installazioni aggiuntive      | Preferito senza token persistente, E2E WebKit e qualifica manuale separata su Safari reale (§§2, 4.1, 12)                                      |
| Non ospitare un browser Aruba sulla VPS                                 | Helper esclusivamente locale e polling remoto escluso (§2)                                                                                     |
| Conservare credenziali e sessione Aruba sul dispositivo                 | Nessun cookie, password, OTP o sessione transita in Hub Fatture (§3)                                                                           |
| Fermarsi davanti a CAPTCHA, challenge o account inatteso                | Arresto/sospensione fail-closed (§§3, 4.1)                                                                                                     |
| Riservare al titolare i match manuali fiscalmente irreversibili         | Controllo server-side `can_approve`, audit e test di chiamata diretta dell’account `Codex` (§§6, 10, 12)                                       |
| Consentire lavoro parallelo senza interferire col collaudo corrente     | Tranche, ownership esclusiva dei file condivisi e worktree isolati (§13)                                                                       |
| Completare questa capacità prima del Canary Production                  | Collocazione, rollout e gate finali (§§14, 15)                                                                                                 |
| Autorizzare separatamente la prima scansione reale                      | Confine esplicito in apertura, perimetro e rollout (§§2, 14)                                                                                   |
| Non autorizzare upload, invii Aruba, e-mail reali, deploy o release     | Non-obiettivi e gate finale (§§2, 15)                                                                                                          |
