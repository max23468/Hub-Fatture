# Contratto API Aruba v2

## Perimetro corrente

Le API Aruba v2 documentate sono l’unica autorità automatica per inventario, file e stati. Il
runtime non contiene né espone automazioni del pannello, preferiti, bridge o helper locali. Il
fallback permanente è l’importazione manuale presidiata di dati e file ufficiali; non costituisce
una seconda autorità automatica.

Il contratto copre autenticazione, verifica dell’identità, ricerca paginata delle fatture inviate,
dettaglio, file e notifiche. Per l’outbound copre manifest immutabile e qualifica con
`POST /services/invoice/upload` e `dryRun=true`. `dryRun=false`, trasmissione reale, callback e
prova SdI restano subordinati ai rispettivi gate e alle autorizzazioni esplicite.

La fonte provider è la [documentazione ufficiale API v2](https://fatturazioneelettronica.aruba.it/apidoc/v2/docs.html).
Un cambiamento di forma, stati o limiti riapre la qualifica prima di estendere il canale Production.

## Autorità e credenziali

- `connections.automatic_authority` per Aruba ammette soltanto `API`.
- Le credenziali vengono conservate solo cifrate dopo autenticazione e verifica dell’identità
  fiscale attesa.
- Pausa o revoca vengono rilette ai punti sicuri fra le pagine e prima di ogni chiamata outbound.
- I dati acquisiti tramite API alimentano direttamente l’inventario canonico dopo i controlli del
  contratto; non esistono giri shadow o dossier browser nel ciclo attivo.
- L’importazione manuale conserva la provenienza `MANUAL`, richiede il titolare e resta fail-closed.

## Outbound senza invio

Le tre modalità globali sono rigide:

- `DOCUMENT_ONLY`: crea il documento e non pianifica chiamate outbound;
- `CONTEXTUAL_CONFIRMATION`: crea il documento e attende una conferma separata del titolare;
- `AUTOMATIC_AFTER_APPROVAL`: pianifica la qualifica API dopo l’approvazione.

Quando `ARUBA_SUBMISSION_ENABLED=false`, la modalità effettiva è sempre `DOCUMENT_ONLY`. Se la
modalità configurata richiederebbe trasmissione, il server richiede una conferma esplicita del
downgrade. Il secondo arresto indipendente è `connections.api_paused`; entrambi vengono riletti
prima di creare o confermare il batch e nuovamente dal worker prima della rete.

Una qualifica Production monouso resta confinata a un batch `DOCUMENT_ONLY` di un documento, lega
account e manifest, scade dopo quindici minuti e autorizza al massimo una richiesta con
`dryRun=true`. Il worker la consuma atomicamente prima della rete. Non abilita `dryRun=false` e non
modifica l’interruttore globale.

Ogni batch lega ambiente, account, modalità, tentativo e documenti allo SHA-256 del manifest.
Timeout, risposta non interpretabile o esito remoto ambiguo producono `UNKNOWN_REMOTE_STATE`,
bloccano il batch e non consentono retry automatici. I dry-run non incrementano il contatore
mensile delle trasmissioni accettate.

## Gruppi, documenti e stati

`GET /api/v2/invoices-out` restituisce pagine di gruppi API. Ogni gruppo ha un ID provider e un
array `invoices`; zero, uno o più elementi sono cardinalità distinte. `totalElements` conta i gruppi,
non i documenti. Hub Fatture conserva quindi conteggi separati e non materializza mai un gruppo
come documento.

Il parser ammette soltanto gli stati documentati da Aruba. Uno stato nuovo o una forma inattesa
falliscono con `PROVIDER_RESPONSE_INVALID`; non vengono approssimati.

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

## Paginazione, limiti e checkpoint

- finestra provider massima: 48 ore;
- pagina: da 1 a 100 elementi;
- autenticazione: massimo una richiesta al minuto per IP;
- ricerca fatture e notifiche: massimo 12 richieste al minuto per IP per ciascun bucket;
- margine operativo locale: 9 richieste al minuto per ciascun bucket di lettura;
- `429`: `PROVIDER_RATE_LIMITED`, senza endpoint alternativi o retry immediato;
- tetto fail-closed per giro: 10.000 richieste provider.

L’inventario riparte dal 1° luglio 2026, salva il checkpoint dopo il commit di ogni pagina e può continuare da
un giro incompleto con un nuovo budget. Gli incrementali sovrappongono sette giorni e rileggono gli
stati non terminali. Una scansione completa periodica corregge eventuali derive. Ogni job consolida
una pagina e rilascia la coda; un riavvio non trasforma il yield cooperativo in un retry.

## File e notifiche inbound

Il worker legge il dettaglio dei gruppi non vuoti con file fiscale e PDF opzionale, poi recupera le
notifiche correlate. Accetta esclusivamente XML o P7M, PDF opzionale e notifiche con base64 valido;
calcola SHA-256 sui byte decodificati e rifiuta gruppo, identificativi o cardinalità incoerenti.
I byte validati alimentano lo storage immutabile e la riconciliazione canonica.

Nei dettagli storici il Paese del destinatario può essere `null`: il normalizzatore conserva il
valore sconosciuto e non deduce `IT`. Il pacchetto di conservazione e il download massivo asincrono
restano fuori dal ciclo inbound perché non sono necessari alla riconciliazione operativa e possono
avere effetti remoti osservabili.

## Recupero manuale

Il recupero manuale è disponibile soltanto quando le API non possono fornire una lettura necessaria.
Il titolare importa dati e file ufficiali; l’app valida identità, tipo, anno, importi, hash e
copertura prima di consolidare. Un’importazione incompleta o ambigua non rende sano l’inventario e
non sblocca operazioni fiscali.
