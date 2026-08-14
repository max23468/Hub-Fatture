# Contratto verificato dell’helper Aruba

Questo contratto governa la pagina sintetica e l’helper locale unico per macOS e Windows. La prova controllata precedente al Canary Production lo ha qualificato sul pannello Aruba Base reale con un TD01 e un TD04 dedicati, correttamente caricati e rimossi senza invio.

## Confini di sicurezza

- Il pannello operativo ammesso è `https://fatturazioneelettronica.aruba.it`; durante l’autenticazione umana è ammessa esclusivamente l’origine `https://loginfatturazione.aruba.it`, mentre file e letture restano vincolati al pannello. In prova sono ammessi esclusivamente i loopback e `/aruba-sintetica`.
- L’helper usa Chrome o Edge installato localmente e un profilo browser dedicato. Non legge, esporta o trasmette cookie e local storage.
- L’account corrente non usa la 2FA e non richiede un SMS per ogni upload. Login, password e qualunque challenge OTP/SMS/CAPTCHA inattesa sono sempre umani: se richiesti, l’helper si mette in pausa.
- Il codice di avvio scade, vale per un batch, viene revocato quando termina la propria fase e non autorizza `Invia`. Durante una pausa umana l’helper ne rinnova la scadenza breve con heartbeat, entro un limite assoluto di 45 minuti dalla creazione; prima del limite il server revoca il token e forza il readback se l’operazione non è conclusa.
- Il permesso di invio automatico è distinto, scade ed è consumato atomicamente sul manifest esatto. In ambiente operativo il kill switch disabilita gli invii automatici ordinari e forza i nuovi batch alla modalità assistita.
- L’unica eccezione è l’invio pilota esplicitamente autorizzato dal titolare: parte da un batch assistito ancora intatto contenente l’unica TD01 HUB approvata, in assenza di altri batch Production aperti; crea un nuovo batch `AUTOMATIC` con un manifest distinto e una registrazione interna `CANARY` inattiva, quindi annulla il batch sorgente senza modificarne il manifest. Il permesso viene attivato soltanto dalla successiva autorizzazione finale specifica; il flag globale deve restare `false`.
- Può esistere una sola finestra pilota: dalla creazione resta occupata finché il batch non è terminale e riconciliato, anche se il permesso scade, viene revocato o viene consumato. Il server serializza preparazione, approvazioni fiscali e creazione di altri batch, rifiuta nuove approvazioni o batch mentre la finestra è occupata, revoca e fa scadere i permessi inutilizzati, assegna al nuovo manifest un tentativo successivo e univocamente ordinabile e ricontrolla l’isolamento prima del consumo. Ambiente, modalità, batch, manifest, documento, revisione, hash, validazione, scadenza e stato del kill switch devono coincidere.
- Dopo un esito incerto il manifest espone soltanto l’operazione `READBACK`: nessun nuovo upload o invio è ammesso fino alla riconciliazione.

## Manifest

Il manifest immutabile di upload comprende ambiente, modalità, riferimento non segreto dell’account atteso, tentativo e, per ogni documento, ID, revisione, hash XML, nome file, dimensione, numero fiscale, data e totale. L’hash del manifest vincola il permesso monouso. Il manifest separato della scansione in sola lettura comprende inoltre l’identità visibile attesa, distinta dal riferimento usato per partizionare i dati, e deve coincidere con l’unica descrizione mostrata dal controllo account nella barra superiore Aruba. Gli XML scaricati dall’helper vengono accettati soltanto se dimensione e SHA-256 coincidono.

La preparazione dell’invio pilota avviene in **Documenti** con una conferma esplicita riferita al singolo documento e al singolo tentativo. Non abilita l’uso automatico ordinario, non invia il documento e non sostituisce l’autorizzazione separata richiesta immediatamente prima del Canary Production.

Il consumo pilota resta inoltre bloccato finché l’inventario Aruba provider-first non produce un preflight fresco, completo e vincolato al documento, alla revisione e all’hash candidati, privo di match possibili, ambigui o stati remoti incerti.

Gli endpoint interni espongono manifest, singolo XML, import dei file ufficiali, eventi sanitizzati e consumo del permesso. Accettano soltanto il bearer breve; non ricevono mai dati di autenticazione Aruba.

## Sessione di sincronizzazione in entrata

La sincronizzazione provider-first usa `npm run aruba:sync -- --hub <origine> --browser chrome|msedge` e un codice distinto da quello di batch. Il codice incorpora l’identificativo casuale del dispositivo registrato nella sessione, ha scope esclusivo `ARUBA_READ_SYNC`, è revocabile e non supera otto ore: gli endpoint consentiti espongono soltanto manifest di lettura, heartbeat, pagine inventario, completamento/fallimento e preflight. Il codice non può leggere XML da caricare, manifest di upload o permessi di invio.

A ogni avvio l’helper percorre integralmente gli stream fatture e TD04 richiesti dal manifest strutturato del server, con pagina terminale esplicita. I giri successivi, ogni quindici minuti o su comando immediato, hanno un ordinale separato e il server committa il cursore pagina per pagina. Finché il filtro temporale del pannello reale non è qualificato senza ambiguità, il ciclo incrementale ripercorre prudentemente l’intero anno selezionato e lascia all’ingestione idempotente la deduplicazione, invece di applicare un filtro candidato o interrompersi. Dopo un’interruzione il manifest indica la prima pagina da riprendere soltanto se il tentativo fallito è successivo all’ultimo completamento. Heartbeat durante scansione, attesa e login mantengono la lease breve senza estendere la scadenza assoluta. Account inatteso, stream assente, paginazione incompleta, riga non riconosciuta o stato incompatibile interrompono il giro e lasciano l’inventario bloccante; una griglia riconosciuta senza righe e con paginatore terminale produce invece un inventario vuoto valido.

Ogni riga può dichiarare collegamenti visibili ai file ufficiali. La risposta di ingest restituisce l’allowlist esatta dei file necessari: l’helper scarica soltanto quei collegamenti e invia i byte a `POST /api/aruba/sync/documenti/:remoteDocumentId/file` con bearer di lettura, `Content-Type: application/octet-stream` e tipo file nell’header dedicato. L’endpoint assegna il remote document come proprietario originario del file: non crea una `aruba_submission` fittizia. XML, P7M, PDF e notifiche sono limitati, validati, hashati e archiviati in modo immutabile; import concorrenti dello stesso file sono idempotenti. Una notifica SdI deve identificare il documento corrente tramite `NomeFile` o identificativo remoto e ogni identificativo dichiarato deve essere coerente; in caso contrario l’import viene rifiutato. Un XML ufficiale può materializzare `ARUBA_HISTORY` soltanto per un match consentito con esito `DELIVERED` o `NOT_DELIVERED`; `REJECTED` conserva file e inventario senza creare un documento fiscale locale.

L’helper interroga il lavoro preflight ogni cinque secondi, oltre al giro ordinario. Una nuova richiesta anticipa la scansione successiva; la ricevuta viene completata solo dopo aver rieseguito tutte le ricerche dichiarate e inviato il nuovo readback, mai riusando la sola cache precedente. Nell’approvazione massiva tutte le ricevute condividono lo stesso hash-manifest dell’insieme e vengono aperte soltanto dopo aver verificato che ogni revisione e proiezione sia ancora corrente.

Il pannello sintetico espone lo scenario `?scenario=inventory`. Safari resta supportato per usare l’app e per il percorso manuale; l’automazione del pannello richiede Chrome o Edge perché l’helper usa un profilo Chromium persistente multipiattaforma.

## Contratto visibile verificato

| Funzione            | Etichette verificate                                                                     | Esito fail-closed                                           |
| ------------------- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| account             | controllo nella barra superiore; la scansione usa l’identità visibile attesa             | mismatch o più corrispondenze arrestano l’helper            |
| upload              | `SELEZIONA DOCUMENTI`, `Carica fattura`, riga col nome file                              | arresto se il controllo o il documento caricato non compare |
| challenge eventuale | `Vuoi disattivare la protezione OTP`, `Inserisci il codice ricevuto per SMS`, `Verifica` | pausa finché il titolare completa personalmente la verifica |
| validazione         | contatore, riga col nome file, `DETTAGLI ERRORI`, codice e descrizione                   | batch non inviabile                                         |
| rimozione           | `SVUOTA PAGINA` per il batch; `ELIMINA` per la singola riga                              | readback obbligatorio fino alla pagina priva di righe       |
| clic finale         | `INVIA TUTTE` per il batch; `INVIA` per la singola riga                                  | vietato senza permesso esatto                               |
| bozza vietata       | `SALVA IN BOZZE`                                                                         | non viene mai usata                                         |
| readback            | anno fiscale, `Fatture inviate`, griglia doppia, numero, data, totale, stato e ID SdI    | mismatch o pagina incompleta mantiene il blocco             |
| file ufficiali      | controlli visibili XML, P7M, PDF e ricevuta SdI nella colonna `Scarica`                  | file assente ignorato; file malformato blocca la sessione   |

Il pannello mostra le date come `GG/MM/AAAA` e gli importi con virgola e simbolo euro; gli attributi sintetici restano ammessi nei test. I limiti riletti sono 4,9 MB per documento, 300 documenti e 30 MB per caricamento. L’helper applica tutti e tre i limiti prima dell’upload.

La lettura Production non usa gli attributi della fixture. Seleziona esattamente l’anno nella barra superiore e la voce `Fatture inviate`, quindi correla per indice le due regioni ExtJS della griglia: la regione primaria fornisce data, sezionale/numero, cliente, tipo TD01/TD04, totale e identificativo SdI; la regione bloccata fornisce stato e controlli dei file ufficiali. Tipi diversi da TD01/TD04 non appartengono agli stream fiscali e vengono ignorati. Dati fiscali non esposti dalla griglia, inclusi riferimenti ordine, identificativo fiscale e indirizzo, restano assenti e non vengono dedotti; matching e preflight conservano gli altri vincoli fail-closed. Coppie mancanti o duplicate, anno incoerente, ID SdI non valido, paginazione ambigua o più controlli dello stesso file arrestano la sessione.

I controlli della colonna `Scarica` producono download del browser, non collegamenti HTTP leggibili. L’helper attende il download ufficiale, lo mantiene soltanto in memoria entro il limite, lo invia immediatamente al server se richiesto e lascia che il profilo temporaneo elimini ogni residuo alla chiusura. Il validatore P7M accetta CMS SignedData sia DER sia BER costruito a lunghezza indefinita, come osservato nel pannello reale, con profondità, conteggio elementi e dimensione strettamente limitati.

Con più documenti l’helper deve usare esclusivamente `INVIA TUTTE`: scegliere il primo `INVIA` di riga invierebbe soltanto una parte del manifest ed è quindi un DOM non riconosciuto. La modalità assistita si arresta prima di qualunque controllo di invio.

L’assenza di una conferma visibile o dell’identificativo remoto dopo il clic non viene interpretata come successo: apre la riconciliazione. Gli stati conclusivi non possono regredire e un invio già osservato non può diventare `REMOVED` e ritentabile.

Ogni divergenza del DOM reale deve aggiornare insieme questo contratto, l’helper e i test sintetici. Non è ammesso usare endpoint Aruba osservati tramite strumenti di sviluppo.
