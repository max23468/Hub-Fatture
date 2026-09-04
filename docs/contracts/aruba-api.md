# Contratto API Aruba v2

## Perimetro corrente

Le API Aruba v2 documentate sono l’unica autorità automatica per account, inventario, file e stati
del ciclo attivo. Il runtime non contiene né espone automazioni del pannello, preferiti, bridge,
helper locali o receiver. Il fallback permanente è l’importazione manuale presidiata di dati e file
ufficiali; non costituisce una seconda autorità automatica.

Il contratto copre:

- autenticazione iniziale e rinnovo della sessione tramite refresh token;
- lettura e verifica delle informazioni complete dell’account;
- ricerca paginata e filtrata delle fatture inviate;
- ricerca puntuale per filename o ID SdI;
- dettaglio, file ufficiali e notifiche;
- validazione e trasmissione di XML TD01 non firmati tramite
  `POST /services/invoice/upload`;
- readback mirato fino a un esito SdI terminale o a un controllo operativo.

I callback Aruba sono esclusi dal prodotto: il polling e il readback mirato coprono interamente il
monitoraggio e non vengono predisposti endpoint, segreti, tabelle o feature flag per riceverli.

La fonte provider è la
[documentazione ufficiale API v2](https://fatturazioneelettronica.aruba.it/apidoc/v2/docs.html).
Un cambiamento di forma, stati o limiti riapre la qualifica prima di estendere il canale Production.

## Autorità, credenziali e sessione

- `connections.automatic_authority` per Aruba ammette soltanto `API`.
- Le credenziali vengono conservate solo cifrate dopo autenticazione e verifica dell’identità
  fiscale attesa.
- Access token e refresh token vivono soltanto nella memoria del processo: non vengono salvati nel
  database, nei job, nei log, nell’audit o nel frontend.
- Il primo accesso del processo usa `grant_type=password`. Finché il refresh token resta valido, i
  rinnovi usano esclusivamente `grant_type=refresh_token` e non reinviano username o password.
- Access token e refresh token vengono sostituiti atomicamente con la coppia restituita dal rinnovo.
- Il rinnovo parte con cinque minuti di margine. Richieste concorrenti condividono una sola operazione
  di autenticazione o rinnovo per connessione.
- Un refresh esplicitamente rifiutato come non valido può degradare a un solo accesso controllato con
  password. Timeout, `429` e risposte ambigue non autorizzano il fallback né una raffica di login.
- Un `401` su una richiesta autenticata invalida la sessione in memoria e consente un solo rinnovo e
  replay della stessa richiesta. Un secondo `401` viene restituito come errore.
- Pausa o revoca vengono rilette ai punti sicuri fra le pagine e prima di ogni chiamata outbound.
- I dati acquisiti tramite API alimentano direttamente l’inventario canonico dopo i controlli del
  contratto; non esistono giri shadow o dossier browser nel ciclo attivo.
- L’importazione manuale conserva la provenienza `MANUAL`, richiede il titolare e resta fail-closed.

## Account e preflight

`GET /auth/userInfo` deve restituire e validare username, PEC, descrizione, Paese, P. IVA, codice
fiscale, stato e data di scadenza, spazio usato e spazio massimo. Lo snapshot sanificato viene
persistito sulla connessione con l’istante della verifica e ha freschezza massima di cinque minuti
per un’operazione outbound.

L’identità fiscale deve coincidere con quella configurata. Account scaduto o spazio esaurito
bloccano validazione e trasmissione prima della rete mutativa. Lo snapshot non contiene token,
password o payload fiscali. Un account prossimo alla scadenza o allo spazio massimo produce un
avviso operativo senza inventare tier, costi o contatori commerciali non restituiti dall’API.

## Modalità e arresti dell’outbound

Le tre modalità globali sono rigide:

- `DOCUMENT_ONLY`: crea il documento e non pianifica chiamate outbound;
- `CONTEXTUAL_CONFIRMATION`: crea il documento e attende una conferma separata del titolare;
- `AUTOMATIC_AFTER_APPROVAL`: pianifica la trasmissione dopo l’approvazione.

Quando `ARUBA_SUBMISSION_ENABLED=false`, la modalità effettiva è sempre `DOCUMENT_ONLY`. Se la
modalità configurata richiederebbe trasmissione, il server richiede una conferma esplicita del
downgrade. Il secondo arresto indipendente è `connections.api_paused`; entrambi vengono riletti
prima di creare o confermare il batch e nuovamente dal worker prima della rete.

Una qualifica Production monouso resta confinata a un batch `DOCUMENT_ONLY` di un documento, lega
account e manifest, scade dopo quindici minuti e autorizza al massimo una richiesta con
`dryRun=true`. Il worker la consuma atomicamente prima della rete. Non abilita `dryRun=false` e non
modifica l’interruttore globale.

`DRY_RUN_VALIDATED` costituisce una prova terminale di qualifica, e non un invio da riconciliare,
soltanto se l’intera catena resta integra: documento approvato, batch Production `DOCUMENT_ONLY` via
API con un solo documento e primo tentativo, submission e manifest allineati, qualifica monouso e
tentativo `DRY_RUN` entrambi `SUCCEEDED`, hash XML coincidenti, job concluso, `submitted_at` e
identificativo remoto assenti, nessun file Aruba e nessuna notifica SdI. La mancanza di un solo
vincolo riapre sia il documento sia il batch.

Ogni batch lega ambiente, account, modalità, tentativo e documenti allo SHA-256 del manifest. I
dry-run non incrementano il contatore mensile delle trasmissioni accettate.

## Trasmissione Production ordinaria

Il runtime supporta `dryRun=false`, ma la sua disponibilità tecnica non costituisce autorizzazione
operativa. L’abilitazione di `ARUBA_SUBMISSION_ENABLED=true` è separata da commit, pubblicazione,
deploy e release; anche il primo documento dovuto richiede l’approvazione prevista dal flusso.

Prima di ogni invio il worker rilegge atomicamente configurazione, pausa API, modalità, account,
approvazione, manifest, revisione, hash XML, dry-run riuscito sul medesimo hash e inventario
anti-duplicato. Il payload contiene esclusivamente l’XML TD01 non firmato, massimo 5 MB,
`skipExtraSchema=false`, nessuna credenziale di firma e `dryRun=false`.

Il tentativo `SEND` viene consolidato come `RUNNING` prima della rete. La risposta sincrona `0000`
porta a `ARUBA_ACCEPTED` e conserva il filename restituito: prova soltanto che Aruba ha accettato la
richiesta, non che SdI abbia ricevuto, accettato o consegnato la fattura. Il readback viene quindi
pianificato immediatamente.

La descrizione testuale restituita dal provider viene validata ma non persistita né mostrata: stato,
codice e filename alimentano dati strutturati, mentre errori e UI usano messaggi applicativi stabili.
Un codice vuoto non viene equiparato a `0000` per l’upload non firmato.

Un rifiuto certo prima di qualsiasi effetto remoto produce `SEND_FAILED`. Timeout, risposta non
interpretabile o altro esito che potrebbe avere prodotto un effetto remoto portano a
`UNKNOWN_REMOTE_STATE`: nessun nuovo invio è ammesso finché il readback canonico non stabilisce
l’esito. Il solo errore provider di duplicato autorizza una ricerca puntuale; non viene trasformato
in successo senza una corrispondenza univoca e coerente.

## Ricerca, gruppi e lookup puntuale

`GET /api/v2/invoices-out` restituisce pagine di gruppi API. Ogni gruppo ha un ID provider e un
array `invoices`; zero, uno o più elementi sono cardinalità distinte. `totalElements` conta i gruppi,
non i documenti. Hub Fatture conserva conteggi separati e non materializza mai un gruppo come
documento.

La ricerca avanzata remota accetta soltanto i filtri ufficiali: intervallo di creazione obbligatorio
entro 48 ore, intervallo di modifica opzionale coerente, Paese, P. IVA o codice fiscale del
destinatario, tipo documento e stato Aruba documentato. Ogni pagina passa dallo stesso ingest
canonico del polling.

Il dettaglio puntuale richiede esattamente uno fra filename e ID SdI. Un risultato assente resta
assente; più risultati o identificativi incompatibili sono un conflitto e non vengono collegati per
somiglianza. Dettaglio, file e notifiche validati confluiscono nello stesso inventario canonico e
nella stessa macchina a stati del readback automatico.

## Stati e significato operativo

Il parser ammette soltanto gli stati documentati da Aruba. Uno stato nuovo o una forma inattesa
falliscono con `PROVIDER_RESPONSE_INVALID`; non vengono approssimati.

| Stato locale/provider              | Significato operativo                                      |
| ---------------------------------- | ---------------------------------------------------------- |
| `SEND_PENDING`                     | invio pianificato ma non ancora iniziato                   |
| `SEND_FAILED`                      | mancata trasmissione certa; correzione o retry controllato |
| `ARUBA_ACCEPTED`                   | Aruba ha accettato la richiesta; esito SdI ancora ignoto   |
| `SDI_PROCESSING` / `SUBMITTED`     | SdI sta elaborando o ha ricevuto il documento              |
| `DELIVERED`                        | esito conclusivo positivo o fiscalmente equivalente        |
| `NOT_DELIVERED`                    | esito conclusivo senza recapito                            |
| `REJECTED`                         | documento scartato o rifiutato                             |
| `UNKNOWN` / `UNKNOWN_REMOTE_STATE` | lettura non conclusiva o possibile effetto remoto incerto  |

| Stato API Aruba      | Stato canonico   |
| -------------------- | ---------------- |
| Presa in carico      | `SDI_PROCESSING` |
| Errore elaborazione  | `UNKNOWN`        |
| Inviata              | `SUBMITTED`      |
| Scartata             | `REJECTED`       |
| Non consegnata       | `NOT_DELIVERED`  |
| Recapito impossibile | `NOT_DELIVERED`  |
| Consegnata           | `DELIVERED`      |
| Accettata            | `DELIVERED`      |
| Rifiutata            | `REJECTED`       |
| Decorrenza termini   | `DELIVERED`      |

Gli stati terminali non regrediscono. `ARUBA_ACCEPTED`, `SDI_PROCESSING`, `SUBMITTED`, `UNKNOWN` e
`UNKNOWN_REMOTE_STATE` vengono riletti ogni quindici minuti finché diventano terminali o aprono un
controllo azionabile. L’azione manuale `Aggiorna stato Aruba` accoda lo stesso readback e non bypassa
rate limit, cooldown o ingest canonico.

L’istante della transizione remota è distinto dall’ultima lettura: una rilettura invariata non
azzera la soglia di 24 ore. Il worker reclama prima stato remoto incerto, invii appena accettati e
non terminali; seguono lookup puntuali, incrementale, ricerche esplorative e scansione completa.
Solo una transizione canonica produce un’attività. `DELIVERED` e `NOT_DELIVERED` abilitano la copia
cliente; `REJECTED`, regressioni e stati incerti non la abilitano.

## Paginazione, limiti e checkpoint

- finestra provider massima: 48 ore;
- pagina: da 1 a 100 elementi;
- autenticazione: massimo una richiesta al minuto per IP;
- ricerca fatture e notifiche: massimo 12 richieste al minuto per IP per ciascun bucket;
- invio: massimo 30 richieste al minuto per IP;
- margine operativo locale: 9 richieste al minuto per ciascun bucket di lettura; finché il tier
  assegnato all’account non è verificato, validazione e invio condividono una cadenza massima di una
  richiesta al minuto, compatibile con il Tier 0 documentato;
- `429`: `PROVIDER_RATE_LIMITED`, con cooldown persistente per i bucket autenticazione, fatture,
  notifiche e invio, senza endpoint alternativi o retry immediato;
- tetto fail-closed per giro: 10.000 richieste provider.

L’inventario riparte dal 1° luglio 2026, salva il checkpoint dopo il commit di ogni pagina e può
continuare da un giro incompleto con un nuovo budget. Gli incrementali sovrappongono sette giorni e
rileggono gli stati non terminali. Una scansione completa periodica corregge eventuali derive. Ogni
job consolida una pagina e rilascia la coda; un riavvio non trasforma il yield cooperativo in un
retry.

## File e notifiche inbound

Il worker legge il dettaglio dei gruppi non vuoti con file fiscale e PDF opzionale, poi recupera le
notifiche correlate. Accetta esclusivamente XML o P7M, PDF opzionale e notifiche con base64 valido;
calcola SHA-256 sui byte decodificati e rifiuta gruppo, identificativi o cardinalità incoerenti. I
byte validati alimentano lo storage immutabile e la riconciliazione canonica.

Nei dettagli storici il Paese del destinatario può essere `null`: il normalizzatore conserva il
valore sconosciuto e non deduce `IT`. Il pacchetto di conservazione e il download massivo asincrono
restano fuori dal ciclo inbound perché non sono necessari alla riconciliazione operativa e possono
avere effetti remoti osservabili.

## Recupero manuale

Il recupero manuale è disponibile soltanto quando le API non possono fornire una lettura necessaria.
Il titolare importa dati e file ufficiali; l’app valida identità, tipo, anno, importi, hash e
copertura prima di consolidare. Un’importazione incompleta o ambigua non rende sano l’inventario e
non sblocca operazioni fiscali.
