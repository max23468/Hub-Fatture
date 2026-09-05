# Piano esecutivo — invio reale e monitoraggio Aruba

- **Stato:** completato localmente; Fasi A-G completate
- **Ambito:** autenticazione, account, ricerca ciclo attivo, invio reale TD01 e monitoraggio SdI
- **Esclusione esplicita:** callback Aruba
- **Baseline:** [Piano integrazione API Aruba](aruba-api-integration.md) e
  [Contratto API Aruba](../contracts/aruba-api.md)

> **Correzione operativa prevalente:** `dryRun=true` è vietato in Production perché ha mostrato un
> effetto remoto reale. Il preflight è ora una validazione FatturaPA locale; il provider viene
> chiamato soltanto per l’invio `dryRun=false` dopo conferma esplicita. Ogni descrizione storica del
> dry-run in questo piano resta evidenza del disegno precedente, non una procedura eseguibile.

Questo documento pianifica l’estensione del canale Aruba già presente in Hub Fatture. Non sostituisce
la baseline inbound, il modello di approvazione fiscale o il fallback manuale: definisce il lavoro
necessario per completare il client API, trasmettere XML TD01 non firmati, osservare l’esito SdI e
rendere il tutto operabile dall’interfaccia senza introdurre una seconda autorità.

Il piano non autorizza un invio reale, un deploy, una release, una modifica della delega Aruba o
l’abilitazione di `ARUBA_SUBMISSION_ENABLED` in Production. Queste azioni mantengono i consensi
separati già previsti dal prodotto.

## 1. Risultato atteso

Al termine:

1. il client Aruba rinnova la sessione con il refresh token senza reinviare username e password;
2. Impostazioni mostra le informazioni complete e aggiornate dell’account collegato;
3. Documenti offre ricerca locale avanzata e verifica esplicita sul ciclo attivo Aruba;
4. filename e ID SdI permettono una ricerca puntuale e un readback affidabile;
5. un XML TD01 approvato e immutabile può essere trasmesso realmente come XML non firmato;
6. ogni documento trasmesso viene seguito fino a uno stato remoto comprensibile o a un controllo
   operativo;
7. scarto, mancata consegna, tempo oltre soglia e stato remoto incerto sono visibili e azionabili;
8. audit, limiti provider, concorrenza e recovery impediscono duplicazioni e retry fiscali ciechi;
9. il frontend resta coerente con il prodotto e viene verificato e mostrato a geometria desktop e
   mobile.

### 1.1 Copertura delle sette aggiunte approvate

| Aggiunta                                           | Copertura nel piano                                        |
| -------------------------------------------------- | ---------------------------------------------------------- |
| Monitoraggio post-invio e notifiche SdI            | §9, con readback mirato e convergenza nel polling canonico |
| Contratto tier, rate limit e backoff aggiornato    | §10, con priorità e cooldown persistente                   |
| `Aggiorna stato Aruba` per documento               | §6.3, §9 e §13.2                                           |
| Scadenza e spazio prima dell’invio                 | §5 e precondizioni di §7.1                                 |
| Audit sanificato                                   | §11                                                        |
| Controlli per incerto, scarto e tempi oltre soglia | §9.3 e §12                                                 |
| Regressioni di concorrenza e crash recovery        | §15 e §16                                                  |

## 2. Decisioni consolidate

- L’API Aruba v2 documentata resta l’unico canale automatico del ciclo attivo.
- Il polling e il readback mirato sono completi e autorevoli. Non vengono creati callback, receiver,
  segreti, tabelle o feature flag preparatori.
- `Crea solo il documento` resta la modalità predefinita.
- Le tre modalità globali continuano a valere sia per approvazioni singole sia massive; non esiste
  un override per singolo documento.
- Ogni invio richiede sempre un documento TD01 già approvato, numerato e immutabile.
- TD04 rimane nel fallback manuale fino alla propria qualifica separata.
- L’unico invio implementato usa `POST /services/invoice/upload` con XML non firmato,
  `skipExtraSchema=false`, credenziali di firma omesse e `dryRun=false`.
- L’esito sincrono `0000` prova soltanto che Aruba ha accettato la richiesta e ha generato un
  filename. Non prova che SdI abbia ricevuto o consegnato la fattura.
- La ricerca remota è esplicita. Ogni dato che entra nell’inventario usa lo stesso percorso canonico
  di validazione, deduplicazione, persistenza e audit del polling.
- Tier e contatori commerciali del Premium delegato non vengono mostrati. I limiti tecnici
  documentati influenzano esclusivamente scheduler, backoff e salute del canale.
- Nessuna prova automatica o manuale di questa tranche invia una fattura reale senza una nuova
  autorizzazione esplicita riferita al documento dovuto.

## 3. Contratto provider da implementare

La fonte è la [documentazione ufficiale API Aruba v2](https://fatturazioneelettronica.aruba.it/apidoc/v2/docs.html).
Ogni DTO resta a lista chiusa e fallisce con `PROVIDER_RESPONSE_INVALID` se il provider cambia forma
o semantica.

| Capacità         | Contratto Aruba                                 | Uso in Hub Fatture                                               |
| ---------------- | ----------------------------------------------- | ---------------------------------------------------------------- |
| Accesso iniziale | `POST /auth/signin`, `grant_type=password`      | Solo primo accesso del processo o recupero controllato           |
| Rinnovo          | `POST /auth/signin`, `grant_type=refresh_token` | Rinnovo anticipato, senza password                               |
| Account          | `GET /auth/userInfo`                            | Identità, PEC, descrizione, Paese, P. IVA, CF, scadenza e spazio |
| Ricerca avanzata | `GET /api/v2/invoices-out`                      | Filtri provider entro finestre massime di 48 ore                 |
| Ricerca puntuale | `GET /api/v2/invoices-out/detail`               | Esattamente uno fra ID, filename o ID SdI                        |
| Notifiche        | API notifiche fatture inviate                   | Esiti SdI, file e stato canonico                                 |
| Validazione      | `POST /services/invoice/upload`, `dryRun=true`  | Stesso XML e stesso hash della trasmissione                      |
| Trasmissione     | `POST /services/invoice/upload`, `dryRun=false` | XML TD01 non firmato, massimo 5 MB                               |

Non si usa `/api/v2/comfin/{requestId}`: riguarda le comunicazioni finanziarie, non lo stato delle
fatture inviate.

### Verifica inventario alla conferma

Le preparazioni pronte rimangono visibili e modificabili durante le letture Aruba.
L’inventario periodico viene aggiornato ogni dieci minuti; il monitoraggio post-invio conserva
la propria cadenza. La conferma dell’approvazione richiede una lettura canonica entro cinque
minuti: riusa il giro in corso o accoda una sincronizzazione. Il frontend attende al massimo due
minuti nella pagina corrente, mantenendo revisione, hash e scelte originali. Un cambiamento
rilevante o un errore interrompe l’approvazione della preparazione interessata senza numerarla. La transazione rilegge comunque tutti
i prerequisiti sotto lock. Un invio in coda con inventario da aggiornare cede il worker al giro
canonico prima di creare un tentativo di rete; il controllo immediatamente prima dell’invio resta.

## 4. Sessione e refresh token

### 4.1 Ciclo di vita

- Il contratto corrente assegna 30 minuti all’access token e 60 minuti al refresh token dalla sua
  emissione.
- Access token, refresh token e scadenze restano esclusivamente nella memoria del processo.
- Username e password continuano a essere letti dalla credenziale cifrata soltanto quando serve un
  nuovo signin; non vengono copiati in job, audit o log.
- Il client rinnova la sessione quando restano al massimo cinque minuti, così la mutazione non parte
  con un token vicino alla scadenza, e adotta una single-flight nel processo per coppia
  account/ambiente: richieste concorrenti attendono lo stesso refresh.
- Ogni refresh sostituisce atomicamente entrambi i token e le relative scadenze in memoria.
- Un refresh rifiutato con `invalid_grant` consente un solo signin di recupero. Un secondo errore
  invalida la sessione e apre un controllo; non nasce un ciclo di autenticazione.
- Le operazioni Aruba ordinarie passano dal worker; le route applicative accodano lavoro e leggono
  proiezioni persistite. Le sole verifiche immediate autorizzate usano lo stesso traffic guard.
- Un lease PostgreSQL coordina i signin fra processi e impedisce di superare una richiesta di
  autenticazione al minuto per IP senza rendere persistenti i token.
- Dopo il riavvio il proprietario del lavoro acquisisce il lease, esegue un solo signin e usa il
  refresh finché resta valido.

### 4.2 Replay delle richieste

- Una lettura che riceve un `401` definitivo può essere ripetuta una sola volta dopo il refresh.
- Prima di ogni mutazione il token deve avere margine sufficiente; il rinnovo avviene prima della
  chiamata.
- Un `401` HTTP esplicito permette al massimo un nuovo tentativo della mutazione, perché attesta il
  rifiuto di autenticazione. Timeout, reset di connessione o risposta non interpretabile dopo
  l’inizio della mutazione non vengono mai ripetuti: producono `UNKNOWN_REMOTE_STATE`.
- Le richieste registrano soltanto endpoint logico, classe dell’esito, durata e identificativi
  sanificati; header e body sensibili non vengono mai serializzati.

## 5. Informazioni complete dell’account

Il parser `userInfo` acquisisce:

- username;
- PEC;
- nome, cognome o ragione sociale;
- Paese;
- Partita IVA;
- Codice Fiscale;
- stato di scadenza;
- data di scadenza;
- spazio usato e spazio massimo in KB.

Per “informazioni complete dell’account” si intendono tutti i campi documentati da `userInfo` per
l’utenza Base collegata. Gli endpoint `multicedenti` e i report del Premium non vengono interrogati:
appartengono a un perimetro multi-tenant estraneo al prodotto e potrebbero includere altri clienti
dell’agenzia.

La vista Impostazioni mostra i valori completi soltanto agli amministratori già autorizzati a
vedere la connessione Aruba. Il database conserva unicamente l’ultimo snapshot strutturato, la data
della verifica, l’ambiente e la coerenza con l’identità fiscale attesa; non mantiene una cronologia
duplicata dei dati anagrafici. Log, errori e audit usano identificatori redatti o digest.

Prima di dry-run e invio il worker richiede uno snapshot `userInfo` non più vecchio di cinque
minuti. La rilettura è single-flight e condivisa dal batch: non viene eseguita una chiamata per ogni
documento. Il preflight blocca fail-closed se identità o ambiente divergono, l’account è scaduto, i
campi obbligatori non sono validi, lo spazio massimo non è positivo oppure lo
spazio usato è maggiore o uguale al massimo. La UI segnala l’avvicinamento alla scadenza e l’uso
dello spazio all’80% e al 95%. La scadenza produce un avviso a 30 giorni e un avviso urgente a 7
giorni, ma blocca l’invio soltanto quando l’account risulta scaduto. Queste soglie sono
avvisi, non una stima arbitraria del contratto commerciale. L’errore Aruba `0097` arresta il
tentativo senza retry automatico.

## 6. Ricerca avanzata e ricerca puntuale

### 6.1 Ricerca locale ordinaria

La ricerca principale di Documenti continua a interrogare il database locale e supporta senza
vincolo di 48 ore:

- intervallo data documento;
- intervallo ultima modifica remota;
- cliente;
- Paese, Partita IVA o Codice Fiscale destinatario;
- tipo documento;
- stato Aruba/SdI;
- origine del documento;
- numero fiscale;
- filename e ID SdI quando già noti.

Filtri, ordinamento e paginazione sono server-side e condividono un unico modello di query.

### 6.2 Verifica esplicita su Aruba

L’azione `Verifica su Aruba` usa gli stessi filtri ammessi dal provider: intervallo di creazione
obbligatorio e non superiore a 48 ore, intervallo di modifica, destinatario, tipo e stato. I dati del
mittente sono derivati dall’identità verificata e non sono editabili.

Le pagine remote passano dal normale ingest canonico. Un risultato può aggiornare un documento
esistente o creare una voce Aruba da collegare, ma non forza mai un match ambiguo. La ricevuta
dell’operazione registra filtri sanificati, pagine, gruppi, documenti, aggiornamenti e conflitti.

### 6.3 Lookup puntuale

La ricerca puntuale accetta esattamente un identificatore:

- filename Aruba;
- ID SdI;
- ID remoto Aruba, usato internamente per azioni provenienti da un documento già noto.

Il client rifiuta richieste senza identificatore, con più identificatori o con valori non conformi.
Il dettaglio recuperato viene validato e riconciliato con identità fiscale, tipo, anno, numero,
importo e hash disponibili. Un conflitto apre un controllo e non sovrascrive il documento locale.

## 7. Trasmissione reale dell’XML non firmato

### 7.1 Precondizioni atomiche

Subito prima della rete il worker rilegge sotto lock:

- modalità globale e `ARUBA_SUBMISSION_ENABLED`;
- stato della connessione e pausa API;
- ambiente e identità fiscale;
- snapshot account non più vecchio di cinque minuti, account non scaduto e spazio disponibile;
- approvazione e revisione del documento;
- tipo TD01;
- dimensione massima di 5 MB;
- manifest, filename sorgente e `xml_sha256`;
- dry-run riuscito sul medesimo hash;
- assenza di invii accettati, job attivi o stati remoti incerti;
- inventario anti-duplicato aggiornato e privo di conflitti bloccanti.

Una divergenza non viene corretta implicitamente: il job termina prima della chiamata e apre la
causa operativa appropriata.

### 7.2 Chiamata e prova minima

Il body contiene soltanto:

- `dataFile`: Base64 dei byte già verificati nello storage immutabile;
- `skipExtraSchema: false`;
- `dryRun: false`.

`credential`, `domain` e `senderPIVA` sono omessi. L’esito sincrono è accettato solo con schema
valido, `errorCode=0000` e `uploadFileName` valido. Filename sorgente e filename assegnato da Aruba
restano due campi distinti; l’identificativo richiesta sanificato viene registrato e il body XML non
entra nell’audit.

Prima della rete il record in `aruba_submission_attempts` viene consolidato come `RUNNING` con
documento, revisione, hash e filename sorgente. Solo dopo la risposta `0000` una nuova transazione
registra il filename Aruba, chiude il tentativo e porta la submission in `ARUBA_ACCEPTED`. Un crash
fra risposta e commit lascia il tentativo `RUNNING`: il recovery lo converte in
`UNKNOWN_REMOTE_STATE`, esegue il readback e non presume né successo né fallimento.

Una risposta sincrona non `0000` è un fallimento definitivo di quel tentativo e non viene
rappresentata come scarto SdI. Il codice `0034` avvia una riconciliazione per duplicato: diventa
successo soltanto se il readback identifica univocamente lo stesso documento; altrimenti resta
`UNKNOWN_REMOTE_STATE`.

Un nuovo tentativo automatico è ammesso una sola volta e soltanto per un codice allowlisted che
provi la mancata presa in carico, come `0095`, dopo backoff e ripetizione completa del preflight.
Errori di validazione, delega, identità o spazio richiedono una correzione e una nuova azione
esplicita. HTTP `5xx`, timeout e trasporto interrotto dopo l’avvio della richiesta restano ambigui e
non vengono ritentati.

### 7.3 Singolo e massivo

Un batch massivo crea un job indipendente per documento. Il limite di concorrenza è condiviso con
il traffic guard Aruba e non supera il budget più prudente applicabile. Successo, rifiuto, stato
incerto e readback restano individuali: un documento non può trasformare gli altri in successi o
fallimenti impliciti.

L’interfaccia mostra prima della conferma numero di documenti, importo complessivo, modalità, stato
del canale e conseguenza concreta. Dopo l’avvio mostra risultati per documento e non propone un
retry massivo quando esiste anche un solo esito incerto.

## 8. Modello di stato e significato per l’utente

La macchina a stati separa l’effetto locale, la presa in carico Aruba, l’invio a SdI e la consegna:

| Stato tecnico          | Significato operativo                                                | Terminale         |
| ---------------------- | -------------------------------------------------------------------- | ----------------- |
| `DRY_RUN_PENDING`      | La validazione Aruba deve ancora partire                             | No                |
| `DRY_RUN_FAILED`       | Il dry-run è fallito in modo determinato                             | Sì, per tentativo |
| `DRY_RUN_VALIDATED`    | Lo stesso XML ha superato il dry-run                                 | No                |
| `SEND_PENDING`         | L’invio reale è autorizzato e accodato                               | No                |
| `SEND_FAILED`          | Aruba ha rifiutato il tentativo sincrono prima della presa in carico | Sì, per tentativo |
| `ARUBA_ACCEPTED`       | Aruba ha accettato il file, ma non è provato l’invio a SdI           | No                |
| `SDI_PROCESSING`       | Aruba sta elaborando il file; l’invio a SdI non è ancora provato     | No                |
| `SUBMITTED`            | Aruba dichiara la fattura inviata a SdI                              | No                |
| `DELIVERED`            | SdI ha consegnato o ha prodotto un esito equivalente previsto        | Sì                |
| `NOT_DELIVERED`        | SdI non ha consegnato o il recapito è impossibile                    | Sì                |
| `REJECTED`             | SdI ha scartato o rifiutato il documento                             | Sì                |
| `UNKNOWN`              | Aruba dichiara un errore di elaborazione, distinto dallo scarto SdI  | No, bloccante     |
| `UNKNOWN_REMOTE_STATE` | Non è possibile escludere un effetto remoto                          | No, bloccante     |

Gli stati storici ambigui non vengono riutilizzati nel nuovo flusso. La migrazione inventaria gli
eventuali record esistenti, introduce i nuovi stati espliciti e conserva l’audit storico senza
aggiungere rami runtime di compatibilità.

Il readback può saltare stati intermedi: da `ARUBA_ACCEPTED` può osservare direttamente
`SDI_PROCESSING`, `SUBMITTED`, `DELIVERED`, `NOT_DELIVERED`, `REJECTED` o `UNKNOWN`. Gli stati
terminali non regrediscono; un’osservazione successiva incompatibile apre un conflitto invece di
riscrivere la storia.

Lo stato del batch è soltanto una proiezione aggregata degli esiti per documento: in coda, in corso,
completato oppure con intervento richiesto. Non costituisce prova fiscale, non nasconde i successi
parziali e non può autorizzare un retry collettivo.

`DELIVERED` e `NOT_DELIVERED` continuano ad abilitare il flusso e-mail già approvato. La mancata
consegna resta fiscalmente distinta dallo scarto: il documento esiste, ma Hub Fatture apre un
controllo affinché il destinatario venga gestito consapevolmente.

Una transizione API autorevole a `REJECTED` conserva immutabili documento, numero e tentativi e
riporta gli ordini ancora fatturabili in una nuova preparazione. Non approva, non numera e non
trasmette la sostituzione: questi passaggi richiedono il normale consenso esplicito. Qualunque stato
incerto o non scartato mantiene invece il blocco fail-closed.

## 9. Monitoraggio dopo l’invio

### 9.1 Readback mirato

Se un giro canonico dell’inventario è attivo sullo stesso account e ambiente, i job di
monitoraggio, ricerca puntuale e ricerca avanzata restano in coda senza chiamare Aruba.
Se il giro inizia durante una lettura, il readback viene riprogrammato; l’eventuale tentativo di
monitoraggio viene chiuso come annullato, senza errore della connessione né modifica dello stato
fiscale. La ripresa rilegge il provider e usa la normale riconciliazione canonica.

Dopo `ARUBA_ACCEPTED` il worker accoda un readback per filename. Se il dettaglio è disponibile,
acquisisce ID remoto, ID SdI, stato, descrizione, file e notifiche applicabili. Se non è ancora
visibile, il documento entra nella coda prioritaria dei non terminali senza essere reinviato.

Il readback mirato converge poi nel polling canonico ogni 15 minuti e nella scansione completa
mensile. Non nasce una seconda macchina a stati e nessun risultato temporaneo regredisce uno stato
autorevole già osservato.

### 9.2 Esiti SdI

Stato e notifiche servono precisamente a distinguere:

- file ancora in carico ad Aruba;
- fattura inoltrata a SdI;
- consegna riuscita;
- mancata consegna o recapito impossibile;
- scarto con codice e descrizione;
- rifiuto o decorrenza termini quando applicabili.

Le notifiche vengono validate, hashate e conservate secondo il contratto esistente. Il dettaglio
documento mostra una cronologia ordinata con fonte e ultimo aggiornamento, senza presentare una
semplice risposta HTTP come esito SdI.

### 9.3 Soglie operative

Le soglie si riferiscono alla fase osservabile e non promettono tempi che il provider non garantisce:

- `ARUBA_ACCEPTED` senza presa in carico oltre 24 ore: controllo importante;
- `SDI_PROCESSING` senza passaggio a `SUBMITTED` oltre 24 ore: controllo importante;
- `SUBMITTED` senza esito terminale oltre 24 ore: richiesta di verifica, descritta come attesa
  prolungata e non automaticamente come violazione Aruba;
- `REJECTED`, `NOT_DELIVERED`, `UNKNOWN` e `UNKNOWN_REMOTE_STATE`: controllo immediato con causa,
  conseguenza e azione diretta.

Le soglie usano timestamp persistiti e clock server-side; riavvii e ritardi del worker non azzerano
l’età del caso.

## 10. Limiti, priorità e backoff

Il traffic guard viene aggiornato per distinguere autenticazione, letture, notifiche e invio. Il
budget locale resta più prudente dei limiti ufficiali e assegna priorità nell’ordine:

1. chiarimento di `UNKNOWN_REMOTE_STATE`;
2. readback di invii appena accettati;
3. stati non terminali prossimi o oltre soglia;
4. verifiche manuali puntuali;
5. polling incrementale;
6. ricerche esplorative e scansione completa.

Per l’invio si applicano sia il limite SLA di 30 richieste al minuto sia il tiering orario/annuale
pubblicato da Aruba. Il tier effettivo non viene indovinato. Il client limita picchi e concorrenza e
misura soltanto le proprie richieste.

Un `429` apre un cooldown globale persistente per il relativo bucket. Autenticazione, ricerca
fatture e ricerca notifiche rispettano le rispettive finestre pubblicate; in assenza di
`Retry-After` attendono almeno la finestra del bucket più jitter. Per il solo bucket d’invio, il
tiering Aruba rinnova il TTL anche sulle richieste rifiutate: se non è possibile distinguere il
limite minuto dal limite tier, la ripresa richiede un’ora completa di inattività dall’ultimo
tentativo. Il backoff è condiviso fra processi e non aggira il blocco cambiando endpoint.

## 11. Audit, sicurezza e privacy

L’audit registra:

- attore, documento, batch e tentativo;
- ambiente e account reference sanificato;
- modalità globale e precondizioni decisive;
- hash del manifest e dell’XML;
- operazione `DRY_RUN`, `SEND` o `READBACK`;
- classe dell’esito, codice provider e filename quando disponibili;
- transizione di stato e controllo aperto/chiuso;
- tempi, lease e recovery dopo crash.

Non registra password, access token, refresh token, header Authorization, XML, Base64, PEC, dati
anagrafici completi o descrizioni provider non filtrate. I messaggi destinati alla UI passano dal
registro errori e dalla copia italiana; i dettagli tecnici restano nei dati strutturati sanificati.

## 12. Controlli operativi

Le nuove cause entrano in `Controlli`, non in una pagina parallela:

| Causa                                | Priorità   | Azione principale                         |
| ------------------------------------ | ---------- | ----------------------------------------- |
| Stato remoto incerto                 | Bloccante  | Rileggi da Aruba                          |
| Errore di elaborazione Aruba         | Bloccante  | Apri documento e leggi l’esito            |
| Scarto SdI                           | Bloccante  | Apri documento e leggi l’esito            |
| Mancata consegna                     | Importante | Apri documento e gestisci il destinatario |
| Presa in carico oltre soglia         | Importante | Aggiorna stato Aruba                      |
| Invio a SdI senza esito oltre soglia | Importante | Aggiorna stato Aruba                      |
| Account scaduto/sospeso              | Bloccante  | Apri Impostazioni Aruba                   |
| Spazio esaurito                      | Bloccante  | Apri Impostazioni Aruba                   |
| Spazio o scadenza vicini             | Importante | Apri Impostazioni Aruba                   |
| Cooldown rate limit                  | Importante | Attendi la ripresa automatica             |

Ogni causa ha conteggio canonico, spiegazione, conseguenza e destinazione. La chiusura automatica
avviene soltanto quando un nuovo readback autorevole elimina la causa.

## 13. Frontend e qualità visiva

### 13.1 Impostazioni Aruba

La sezione viene divisa in blocchi leggibili:

1. **Connessione** — stato, ambiente, ultima verifica e azioni di connessione;
2. **Account** — ragione sociale, username, PEC, Paese, P. IVA e Codice Fiscale;
3. **Servizio** — scadenza e indicatore spazio usato/massimo;
4. **Sincronizzazione** — ultimo aggiornamento, prossimo giro e `Sincronizza ora`;
5. **Trasmissione** — modalità globale, stato invii e spiegazione della conseguenza;
6. **Recupero** — rotazione credenziale e fallback manuale, separati dalle azioni ordinarie.

Le azioni critiche non condividono la stessa riga con testi lunghi. Desktop usa una griglia di card
con allineamento coerente; mobile torna a una sola colonna mantenendo ordine semantico.

### 13.2 Documenti

- I filtri locali principali restano immediatamente visibili.
- `Ricerca avanzata` apre un pannello dedicato con campi raggruppati e pulsanti in una action bar
  separata.
- `Verifica su Aruba` è visivamente distinta dalla ricerca locale e spiega la finestra massima.
- Il lookup puntuale offre un selettore `Filename` / `ID SdI` e un solo campo, senza tre input
  concorrenti.
- La tabella non accumula bottoni in ogni riga: l’azione `Aggiorna stato Aruba` vive nel dettaglio e
  nel menu contestuale accessibile.
- Il dettaglio mostra stato corrente, cronologia, ultimo aggiornamento, identificativi e azioni in
  sezioni separate.

### 13.3 Regole di spaziatura e accessibilità

- Card: padding coerente, almeno 24 px desktop e 16 px mobile.
- Gruppi di campi e azioni: gap non inferiore a 12 px; sezioni principali separate da almeno 24 px.
- Pulsanti e controlli interattivi: area minima 44 × 44 px.
- Testi descrittivi: misura leggibile e mai compressi nello stesso flex row dei pulsanti.
- Action bar: va a capo come gruppo e diventa verticale sui viewport stretti.
- Nessuna ellissi nasconde stato, ID SdI o causa operativa senza un’alternativa accessibile.
- Focus, tastiera, ordine dei titoli, label, errori inline e annunci asincroni vengono verificati.
- Stati loading, vuoto, errore, successo e dati parziali hanno copy specifica e non spostano
  bruscamente il layout.

La verifica finale include screenshot del frontend locale almeno a 1440 px, 1024 px, 768 px e
390 px. Nel resoconto conclusivo vengono mostrate all’utente le viste desktop e mobile effettive,
non mockup.

## 14. Dati e migrazioni

La prima fase di implementazione produce una migrazione con il prossimo numero disponibile dopo
aver riletto gli altri worktree. Il disegno previsto comprende:

- nuovi stati espliciti `SEND_PENDING`, `SEND_FAILED` e `ARUBA_ACCEPTED`;
- job separati per invio reale e readback mirato;
- timestamp di accettazione Aruba, primo invio SdI, ultimo readback e prossimo controllo;
- filename sorgente, filename restituito, ID remoto, ID SdI e codice esito sanificato;
- ultimo snapshot strutturato delle informazioni account necessarie alla UI, con freschezza;
- lease e chiavi uniche per impedire due invii dello stesso documento/revisione/hash;
- lease di autenticazione fra processi senza persistenza dei token;
- cooldown persistente per bucket provider;
- indici per non terminali, controlli oltre soglia, filename e ID SdI.

Prima della migrazione vengono inventariati gli stati storici. I dati probatori restano conservati,
ma il nuovo runtime non mantiene adapter o rami legacy. Un record che non può essere classificato
con certezza blocca la migrazione o viene portato in stato incerto con evidenza esplicita.

## 15. Recovery, concorrenza e idempotenza

I casi minimi da coprire sono:

- due worker reclamano lo stesso invio;
- invio singolo e batch massivo includono lo stesso documento;
- crash prima della rete;
- crash dopo l’inizio della rete ma prima della risposta;
- crash dopo risposta `0000` ma prima del commit;
- timeout durante il readback;
- documento visibile per filename ma non ancora per ID SdI;
- risposta duplicato `0034`;
- fallimento sincrono determinato distinto dallo scarto SdI;
- stato remoto `Errore elaborazione` distinto da `REJECTED`;
- stato terminale seguito da osservazione più vecchia;
- due refresh token concorrenti;
- `429` ricevuto da un processo mentre altri job sono in coda.

La regola comune è: nessun replay fiscale finché una lettura autorevole non prova l’assenza
dell’effetto remoto. Dopo un crash ambiguo il recovery usa prima il filename Aruba, se già
consolidato; altrimenti cerca in modo limitato tramite filename sorgente, identità fiscale, numero,
importo, finestra temporale e hash disponibili. Un candidato non univoco lascia lo stato incerto e
non crea una nuova trasmissione.

## 16. Strategia di test

### Unit e contract

- schema completo token e `userInfo`;
- refresh, rotazione token, single-flight nel processo, lease fra processi, fallback singolo e
  redazione;
- filtri ricerca e vincolo finestra 48 ore;
- lookup mutuamente esclusivo per ID, filename e ID SdI;
- request `dryRun=false` priva di firma e `skipExtraSchema=false`;
- mapping errori sincroni, `0034`, errore di elaborazione e stati SdI;
- nuovi limiti, tiering, `429` e TTL;
- transizioni monotone e soglie temporali.

### Integrazione PostgreSQL

- migrazione da ogni stato esistente rilevante;
- unicità documento/revisione/hash;
- manifest e preflight sotto lock;
- esiti individuali nei batch;
- job, lease, crash recovery e cooldown condiviso;
- ingest identico per polling, ricerca e lookup;
- apertura e chiusura dei controlli;
- audit privo di segreti e payload fiscali.

### E2E

- Impostazioni con account sano, in scadenza, scaduto e spazio critico;
- ricerca locale avanzata, verifica remota e lookup puntuale;
- invio singolo nelle tre modalità;
- invio massivo con successo parziale e stato incerto;
- dettaglio con timeline da accettazione Aruba a esito SdI;
- `Aggiorna stato Aruba` e prevenzione dei doppi click;
- scarto, mancata consegna, oltre soglia e controlli correlati;
- permessi Massimo/Codex e copy italiano;
- tastiera, responsive e assenza di overflow.

Tutte le prove provider usano fixture o adapter mock. La suite deve fallire se una configurazione di
test può raggiungere l’endpoint Production con `dryRun=false`.

## 17. Versioning della tranche

Questa estensione è una nuova capacità di prodotto coerente, ma non una nuova generazione: amplia
il connettore fiscale già previsto senza cambiare la proposta principale, sostituire i flussi
essenziali o introdurre un nuovo perimetro di prodotto. La release che la rende disponibile usa
quindi la prossima `MINOR` libera della serie 1.x, non una `PATCH` e non `2.0.0`.

Il numero non viene prenotato nel piano. La baseline riletta all’avvio dell’implementazione è
`1.2.1`, quindi la versione attesa della tranche è `1.3.0`. Prima della PR e di nuovo prima del
merge, il candidato rilegge `origin/main`, `package.json` e i tag remoti: se un’altra `MINOR` venisse
pubblicata per prima, usa la successiva libera senza creare bump artificiali.

L'obiettivo è una singola release coerente. Se motivi operativi autorizzati imponessero più release
Production, la prima che espone la tranche prende la nuova `MINOR`; completamenti e correzioni
compatibili avanzano `PATCH`. Ogni bump e relativa voce di changelog resta nella stessa PR runtime,
secondo il [contratto di versioning](../contracts/versioning.md).

Una futura `2.0.0` richiede una dichiarazione esplicita di nuova generazione e un impatto
sostanziale su almeno due assi fra proposta di valore, flussi/ruoli essenziali, modello
dati/operativo e perimetro fiscale/provider. Ampiezza del diff, numero di schermate o migrazioni non
bastano da soli.

## 18. Sequenza di implementazione

### Fase A — contratto e dominio

**Stato:** completata.

- aggiornare contratto Aruba, ADR polling, glossario e modello di dominio;
- rimuovere dai documenti ogni apertura ai callback;
- definire DTO, errori, stati, soglie e invarianti;
- aggiungere test di contratto fallenti prima del runtime.

**Gate:** terminologia unica e nessuna contraddizione fra Master Plan, contratto, ADR e piano.

### Fase B — autenticazione e account

**Stato:** completata.

- implementare token completi, refresh single-flight, lease di signin fra processi e recupero
  controllato;
- estendere `userInfo`, ultimo snapshot persistito, freschezza massima di cinque minuti e preflight
  condiviso dal batch;
- fare in modo che `account_info_checked_at` rappresenti l’ultima chiamata `userInfo` realmente
  completata e non l’ultimo riuso della cache di sessione;
- aggiungere metriche sanificate e test di concorrenza.

**Gate:** nessun secondo signin durante una sessione sana; nessun segreto in log, DB o job.

### Fase C — ricerca e readback

**Stato:** completata.

- generalizzare il client di ricerca;
- aggiungere dettaglio per filename e ID SdI;
- riusare l’ingest canonico per ricerca esplicita e aggiornamento puntuale;
- introdurre job e scheduler di readback mirato;
- validare i payload tramite un’unica unione discriminata e mantenere la ricerca avanzata
  riprendibile con checkpoint di pagina e gruppo;
- impedire che un readback puntuale riusi o completi un run canonico già in corso e aggiornare la
  sessione condivisa dopo l’unico replay autorizzato su `401`.

**Gate:** stessa osservazione remota produce lo stesso record canonico da ogni punto di ingresso.

L’audit di refactor sulle Fasi A-C ha confermato che la Fase A resta correttamente confinata alle
fonti canoniche. Nella Fase B il client condiviso copre account e operazioni outbound, mentre il
gestore inbound resta deliberatamente legato al singolo run perché ne contabilizza il budget; la
duplicazione della trasformazione dettaglio/notifiche è stata invece estratta in un mapper comune.
La Fase C esegue al massimo un gruppo remoto per quantum del job, conserva il checkpoint nel payload
e converge sempre attraverso lo stesso ingest canonico usato dall’inbound.

L’integrazione finale assume, come concordato, che il worktree concorrente sui pagamenti eBay venga
pubblicato per primo. Le sue due migrazioni previste seguono le 066-067 già presenti su `main`;
questa iniziativa riserva quindi la 070 e richiede comunque un ultimo controllo di merge e catalogo
migrazioni sul `main` effettivo prima della pubblicazione.

### Fase D — invio reale

**Stato:** completata.

- migrare stati e vincoli;
- implementare il preflight atomico e il job `dryRun=false`;
- consolidare il tentativo `RUNNING` prima della rete, registrare `ARUBA_ACCEPTED` soltanto dopo il commit della
  risposta e avviare il readback senza retry cieco;
- coprire singolo, massivo, `SEND_FAILED`, risposta duplicato e crash recovery.

**Gate:** nessun percorso può chiamare `dryRun=false` senza tutte le precondizioni e l’interruttore
esplicito; nessuna suite esegue un invio reale.

Il refactor della Fase D ha separato il motore di invio dal coordinatore di batch e dry-run e ha
reso condivisi manifest, accodamento readback e proiezione dello stato batch. Il preflight viene
ripetuto prima e dopo il traffic guard, immediatamente prima della chiamata: oltre a modalità,
switch, connessione, account, documento e manifest, prova il dry-run `0000` sul medesimo hash,
l’inventario anti-duplicato e l’assenza di invii, match o job concorrenti. Il recovery di un tentativo
`RUNNING` interrotto ora commette `UNKNOWN_REMOTE_STATE`, relativo audit e readback prima di
terminare il job; non perde più la riconciliazione per rollback della transazione. I test DB coprono
batch singolo e massivo, rifiuto deterministico, duplicato `0034`, unico retry `0095`, trasporto
ambiguo, kill switch, prova dry-run invalida, inventario scaduto e recovery, sostituendo sempre la
rete con risposte sintetiche. Il worker rinnova inoltre la lease prima della rete, non persiste la
descrizione testuale del provider e riconosce come accettazione dell’upload non firmato soltanto
`0000` con filename.

### Fase E — monitoraggio e controlli

**Stato:** completata.

- integrare priorità, soglie e cooldown nel worker esistente;
- acquisire dettaglio e notifiche fino allo stato terminale;
- aggiungere controlli e navigazione risolutiva;
- allineare e-mail e attività alle transizioni canoniche.

**Gate:** ogni invio è terminale, in lavorazione visibile o bloccato da un controllo azionabile.

Il refactor della Fase E ha reso persistenti sia la priorità dei job sia l’istante dell’ultima
transizione remota, così polling e riavvii non azzerano le soglie. Il readback applica una sola
macchina a stati monotona e usa lo stato consolidato dall’ingest di dettaglio e notifiche: una
ricevuta SdI può quindi confermare l’emissione anche prima dell’aggiornamento dell’etichetta nel
dettaglio Aruba. Solo le transizioni effettive entrano in `Attività`; `DELIVERED` e
`NOT_DELIVERED` attivano lo stesso coordinatore condiviso per rimborsi ed e-mail, mentre scarti e
stati incerti restano esclusi. `Controlli` distingue le cause per documento, account e bucket di
rate limit, chiude automaticamente quelle superate ed evita il doppione aggregato del batch API.
I cooldown sono condivisi anche per l’autenticazione e rimandano il lavoro fino alla finestra
persistita con jitter prudenziale. Ricerca puntuale e avanzata conservano job e checkpoint anche su
`429`, come il readback della singola submission; dettaglio e notifiche usano slot sequenziali e non
creano raffiche concorrenti.

### Fase F — frontend

**Stato:** completata.

- rifattorizzare Impostazioni Aruba nei blocchi definiti;
- aggiungere ricerca avanzata e lookup puntuale a Documenti;
- aggiungere stato, timeline e aggiornamento manuale nel dettaglio;
- rifinire spaziatura, responsive, stati asincroni e accessibilità.

**Gate:** nessun testo o bottone risulta appiccicato, tagliato o ambiguo nelle quattro geometrie di
verifica; le azioni critiche restano immediatamente comprensibili.

### Fase G — verifica e consegna

**Stato:** completata.

- eseguire format, lint, typecheck, test standard e `npm run test:db` tramite il runner previsto;
- eseguire build, E2E e controlli di sicurezza applicabili;
- ispezionare il diff cumulativo e rileggere le fonti canoniche;
- avviare l’app locale con dati sintetici e acquisire screenshot desktop/mobile;
- mostrare il nuovo frontend e consegnare elenco di capacità, prove e rischi residui.

**Gate:** piano completato localmente su branch isolato. Push, PR, deploy, release, abilitazione
Production e primo invio restano non eseguiti finché non vengono richiesti esplicitamente.

L’audit finale ha corretto l’isolamento dello storage nel processo Playwright: server e helper E2E
usano ora la stessa radice sintetica prima che la configurazione venga inizializzata. Questo evita
collisioni con XML residui del runtime locale senza indebolire i controlli di percorso, dimensione o
SHA-256.

## 19. Criteri di accettazione

Il lavoro è completo soltanto se:

- il refresh evita la password durante una sessione sana ed è sicuro sotto concorrenza;
- i processi rispettano il limite di signin senza rendere persistenti access token o refresh token;
- tutte le informazioni `userInfo` previste sono validate e visibili in Impostazioni;
- un batch usa uno snapshot account fresco condiviso e non esegue una chiamata `userInfo` per
  documento;
- ricerca avanzata e lookup puntuale funzionano senza percorsi di ingest divergenti;
- lo stesso XML/hash validato è quello passato a `dryRun=false`;
- TD04, XML firmati, ciclo passivo, PDD, download massivo e comunicazioni finanziarie non entrano
  accidentalmente nello scope;
- un esito sincrono non viene rappresentato come consegna SdI;
- fallimento sincrono, errore di elaborazione Aruba e scarto SdI restano tre esiti distinti;
- ogni invio avvia automaticamente il monitoraggio polling/readback;
- scarto, mancata consegna, stato incerto e attesa oltre soglia producono controlli coerenti;
- nessun errore o crash può causare un retry fiscale cieco;
- limiti e cooldown sono condivisi e impediscono tempeste di richieste;
- audit e telemetria non contengono credenziali, token o payload fiscali;
- singolo e massivo conservano esiti per documento;
- frontend, copy, responsive e accessibilità superano i gate visivi definiti;
- le viste desktop e mobile reali vengono mostrate al termine;
- la release candidata usa la prossima `MINOR` 1.x calcolata sull'allora `main`, senza collisioni
  con versioni o tag pubblicati prima;
- nessun invio, deploy o release è stato effettuato senza autorizzazione separata.

## 20. Rischi residui e mitigazioni

| Rischio                                    | Mitigazione                                                                           |
| ------------------------------------------ | ------------------------------------------------------------------------------------- |
| Risposta `0000` seguita da crash           | tentativo `RUNNING`, stato remoto incerto, readback e nessun replay cieco             |
| Filename non ancora ricercabile            | coda non terminali e polling con budget condiviso                                     |
| ID SdI assegnato in ritardo                | correlazione progressiva senza creare un secondo documento                            |
| Nuovo stato o payload Aruba                | parser chiuso, errore stabile e riqualifica del contratto                             |
| Saturazione del tier                       | concorrenza prudente, cooldown globale e ora di inattività dopo `429` ambiguo         |
| Account o spazio non utilizzabili          | `userInfo` fresco e condiviso dal batch, avvisi e blocco fail-closed                  |
| Batch parzialmente riuscito                | stato e recovery per documento                                                        |
| UI sovraccarica                            | gerarchia a card, pannelli progressivi, action bar separate e verifica multi-viewport |
| Interpretazione errata di mancata consegna | stato distinto dallo scarto, controllo dedicato ed e-mail secondo contratto esistente |
| Deriva documentale                         | gate iniziale e finale su Master Plan, contratto, ADR, glossario ed evidenze          |

## 21. Fuori perimetro

- callback Aruba di qualsiasi tipo;
- upload di XML firmati o gestione di credenziali di firma;
- `skipExtraSchema=true`;
- trasmissione automatica TD04;
- ciclo passivo e fatture ricevute;
- comunicazioni finanziarie e relativi endpoint di stato;
- pacchetto di conservazione PDD e download massivo;
- nuovi servizi, code esterne o dipendenze infrastrutturali;
- modifica dei permessi/deleghe nel pannello Aruba;
- invio reale di una fattura durante sviluppo o test;
- deploy, release o abilitazione dell’interruttore Production.

## 22. Coordinamento con branch e worktree aperti

La base di partenza assume che `codex/fiscal-profile-api` e `codex/preparation-traceability` vengano
pubblicati e assorbiti in `main` prima dell’inizio del lavoro Aruba. La loro presenza nell’attuale
inventario non autorizza a copiare, committare o integrare le modifiche ancora aperte.

Il gate di avvio richiede una rilettura Git che provi:

- `origin/main` contiene entrambi i lavori pubblicati e i relativi gate sono conclusi;
- il checkout principale è allineato e non contiene modifiche non committate;
- la base Aruba incorpora il nuovo profilo fiscale, la tracciabilità delle preparazioni e la
  numerazione di migrazione risultante;
- non restano branch o worktree necessari come fonte di modifiche non ancora assorbite.

Solo dopo questo gate il branch Aruba viene riallineato al nuovo `main` e inizia il codice. Il numero
della migrazione viene scelto in quel momento dal prossimo valore disponibile, senza prenotare
`066` o un altro numero in anticipo. La versione applicativa segue lo stesso principio: viene scelta
dal prossimo valore SemVer libero e non è riservata da questo branch documentale.

Le integrazioni da preservare sono:

| Lavoro già pubblicato            | Integrazione obbligatoria nel lavoro Aruba                                                                                                                  |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Profilo fiscale via API          | mantenere endpoint, idempotenza, controllo versione, nuovi errori, route e versione applicativa; il preflight Aruba usa sempre il profilo attivo risultante |
| Tracciabilità delle preparazioni | mantenere `source_billing_case_id`, ricerca per preparazione originaria, collegamenti UI e documenti riconciliati durante ingest e materializzazione Aruba  |

Le sovrapposizioni osservate non sono blocchi se l'ordine di pubblicazione viene rispettato, ma
diventano punti di integrazione obbligatori:

- il profilo fiscale modifica Master Plan, indice, registro errori, runbook, route, attivazione e
  metadati di versione/changelog;
- la tracciabilità modifica ricerca, viste Documenti, materializzazione Aruba, test DB/E2E,
  metadati di versione/changelog e introduce la migrazione `065`;
- il lavoro Aruba non applica risoluzioni preventive su questi file: riparte dal loro risultato in
  `main`, assegna il successivo numero di migrazione e ricalcola la versione candidata.

Ricerca avanzata e readback Aruba estendono quindi le query già pubblicate, senza sostituirle. La
materializzazione remota conserva il collegamento alla preparazione originaria e i test congiunti
coprono ricerca, archivio, migrazioni, profilo fiscale, materializzazione ed E2E.

Prima della consegna si riesegue il confronto con `main` e si dimostra che nessuna capacità dei due
lavori precedenti è stata rimossa, aggirata o duplicata. Il worktree di questo piano modifica per ora
soltanto documentazione e non scrive negli altri worktree.
