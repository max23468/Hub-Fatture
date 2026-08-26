# Contratto read-only API Aruba v2

## Perimetro corrente

Il contratto copre il solo ciclo attivo dell’utenza Base delegata: autenticazione, identità,
ricerca paginata delle fatture inviate e forma documentata di file e notifiche. Non autorizza né
implementa dry-run, upload, invio, callback, persistenza canonica o cambio dell’autorità operativa.

La fonte provider è la documentazione ufficiale API v2, il cui changelog corrente espone la
revisione 2.5.0. Un cambiamento della forma o dei limiti riapre la qualifica prima di estendere il
canale Production.

## Gruppo API e documento Aruba

`GET /api/v2/invoices-out` restituisce pagine di gruppi API. Ogni gruppo ha un ID provider e un
array `invoices`; zero, uno o più elementi sono cardinalità distinte e ammesse dal contratto locale.
Il conteggio `totalElements` riguarda i gruppi, non i documenti. Hub Fatture mantiene quindi due
conteggi separati e non materializza mai un gruppo come documento Aruba.

Ogni elemento di `invoices` dichiara almeno data, numero, tipo documento e stato. Il probe conserva
in memoria soltanto i campi necessari alla qualifica e restituisce aggregati sanitizzati:

- gruppi letti e gruppi totali dichiarati;
- documenti osservati;
- gruppi vuoti, singoli e multipli;
- conteggi TD01, TD04 e altri tipi;
- conteggi per stato canonico.

Identità delle controparti, importi, numeri, nomi file, ID SdI e payload non vengono stampati o
persistiti.

## Stati

Il parser ammette soltanto gli stati documentati da Aruba e riusa il normalizzatore canonico della
baseline browser. Uno stato nuovo o una forma inattesa falliscono con `PROVIDER_RESPONSE_INVALID`:
non vengono approssimati né classificati silenziosamente.

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

La qualifica Production deve verificare che le etichette reali coincidano con questo contratto e
deve confrontare separatamente TD01 e TD04 con l’inventario del fallback.

## Confronto shadow con il fallback

Il confronto opera su due snapshot temporanei che dichiarano lo stesso ambiente, account e chiave
di popolazione, e restituisce soltanto conteggi sanitizzati. Non presume che l’ID del gruppo API sia
l’ID del documento browser e non considera equivalenti due finestre scelte rispettivamente per data
di creazione e data documento.

La correlazione usa, in ordine:

1. lo stesso ID remoto, soltanto quando i due snapshot dichiarano lo stesso namespace;
2. la stessa identità fiscale completa: tipo, anno, serie e numero.

La lista API documentata espone il numero ma non una serie separata. L’adapter shadow non la deduce:
conserva l’ID del gruppo come candidato e lascia serie e numero fiscale non materializzati. Tale ID
diventa confrontabile soltanto se l’adapter fallback qualifica esplicitamente lo stesso namespace;
più documenti nello stesso gruppo producono candidati duplicati e quindi un esito ambiguo.

Data documento e altre invarianti devono comunque coincidere. Duplicati, identità parziali,
collisioni o un ID remoto associato a invarianti diverse falliscono chiusi come ambiguità o
divergenza. La parità richiede copertura biunivoca completa e stati canonici coincidenti; uguaglianza
dei soli conteggi, vicinanza temporale e totale non costituiscono prova.

## Paginazione e limiti

- finestra provider massima documentata: 48 ore;
- pagina ammessa dal provider: da 1 a 100 elementi;
- probe di qualifica corrente: finestra fissa di 24 ore, 10 gruppi per pagina, massimo due pagine;
- autenticazione: massimo una richiesta al minuto per IP;
- ricerca fatture inviate: massimo 12 richieste al minuto per IP;
- ricerca notifiche inviate: massimo 12 richieste al minuto per IP;
- `429` produce `PROVIDER_RATE_LIMITED`, senza endpoint alternativi o retry immediato.

Il probe verifica numero pagina, cardinalità, prima/ultima pagina, totale stabile, assenza di ID
duplicati e corrispondenza tra elementi restituiti e metadati. Se la finestra supera due pagine,
restituisce copertura incompleta e si arresta.

## File e notifiche

La documentazione v2 espone:

- dettaglio fattura con file XML o P7M e PDF opzionale;
- ZIP della fattura con notifiche;
- pacchetto di conservazione quando `pddAvailable` è vero;
- elenco e dettaglio delle notifiche SdI;
- download massivo asincrono.

Il contratto tipizza la forma delle notifiche e registra queste capacità, ma il probe corrente non invoca
nessuno di tali endpoint. Disponibilità reale, MIME, dimensioni, ownership e parità dei file restano
da qualificare con un manifesto read-only separato. Il download massivo non appartiene al probe
perché crea una preparazione remota e non è una lettura priva di effetti osservabili.

## Capacità rinviate alla sincronizzazione inbound

La qualifica API copre le forme documentate e il comportamento read-only senza acquisire contenuti
fiscali. La successiva sincronizzazione inbound dovrà verificare su snapshot allineati la parità
TD01/TD04 e acquisire XML, P7M, PDF e notifiche nel nuovo inventario canonico. Queste prove
richiedono backfill, persistenza e autorizzazioni proprie della sincronizzazione e non sono residui
della qualifica API.
