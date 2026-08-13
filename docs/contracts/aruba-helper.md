# Contratto verificato dell’helper Aruba

Questo contratto governa la pagina sintetica e l’helper locale unico per macOS e Windows. La prova controllata precedente al Canary Production lo ha qualificato sul pannello Aruba Base reale con un TD01 e un TD04 dedicati, correttamente caricati e rimossi senza invio.

## Confini di sicurezza

- Il solo host operativo ammesso è `https://fatturazioneelettronica.aruba.it`; in prova sono ammessi esclusivamente i loopback e `/aruba-sintetica`.
- L’helper usa Chrome o Edge installato localmente e un profilo browser dedicato. Non legge, esporta o trasmette cookie e local storage.
- L’account corrente non usa la 2FA e non richiede un SMS per ogni upload. Login, password e qualunque challenge OTP/SMS/CAPTCHA inattesa sono sempre umani: se richiesti, l’helper si mette in pausa.
- Il codice di avvio scade, vale per un batch, viene revocato quando termina la propria fase e non autorizza `Invia`. Durante una pausa umana l’helper ne rinnova la scadenza breve con heartbeat, entro un limite assoluto di 45 minuti dalla creazione; prima del limite il server revoca il token e forza il readback se l’operazione non è conclusa.
- Il permesso di invio automatico è distinto, scade ed è consumato atomicamente sul manifest esatto. In ambiente operativo il kill switch disabilita gli invii automatici ordinari e forza i nuovi batch alla modalità assistita.
- L’unica eccezione è l’invio pilota esplicitamente autorizzato dal titolare: parte da un batch assistito ancora intatto contenente l’unica TD01 HUB approvata, in assenza di altri batch Production aperti; crea un nuovo batch `AUTOMATIC` con un manifest distinto e un solo permesso interno `CANARY`, quindi annulla il batch sorgente senza modificarne il manifest. Il flag globale deve restare `false`.
- Può esistere una sola finestra pilota: dopo il consumo del permesso resta occupata finché il batch non è terminale e riconciliato. Il server serializza preparazione, approvazioni fiscali e creazione di altri batch, rifiuta nuove approvazioni o batch mentre la finestra è occupata, revoca e fa scadere i permessi inutilizzati, assegna al nuovo manifest un tentativo successivo e univocamente ordinabile e ricontrolla l’isolamento prima del consumo. Ambiente, modalità, batch, manifest, documento, revisione, hash, validazione, scadenza e stato del kill switch devono coincidere.
- Dopo un esito incerto il manifest espone soltanto l’operazione `READBACK`: nessun nuovo upload o invio è ammesso fino alla riconciliazione.

## Manifest

Il manifest immutabile comprende ambiente, modalità, riferimento non segreto dell’account atteso, tentativo e, per ogni documento, ID, revisione, hash XML, nome file, dimensione, numero fiscale, data e totale. L’hash del manifest vincola il permesso monouso. Gli XML scaricati dall’helper vengono accettati soltanto se dimensione e SHA-256 coincidono.

La preparazione dell’invio pilota avviene in **Documenti** con una conferma esplicita riferita al singolo documento e al singolo tentativo. Non abilita l’uso automatico ordinario, non invia il documento e non sostituisce l’autorizzazione separata richiesta immediatamente prima del Canary Production.

Gli endpoint interni espongono manifest, singolo XML, import dei file ufficiali, eventi sanitizzati e consumo del permesso. Accettano soltanto il bearer breve; non ricevono mai dati di autenticazione Aruba.

## Contratto visibile verificato

| Funzione            | Etichette verificate                                                                     | Esito fail-closed                                           |
| ------------------- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| account             | pulsante account nella barra superiore, confrontato col riferimento atteso               | mismatch o più corrispondenze arrestano l’helper            |
| upload              | `SELEZIONA DOCUMENTI`, `Carica fattura`, riga col nome file                              | arresto se il controllo o il documento caricato non compare |
| challenge eventuale | `Vuoi disattivare la protezione OTP`, `Inserisci il codice ricevuto per SMS`, `Verifica` | pausa finché il titolare completa personalmente la verifica |
| validazione         | contatore, riga col nome file, `DETTAGLI ERRORI`, codice e descrizione                   | batch non inviabile                                         |
| rimozione           | `SVUOTA PAGINA` per il batch; `ELIMINA` per la singola riga                              | readback obbligatorio fino alla pagina priva di righe       |
| clic finale         | `INVIA TUTTE` per il batch; `INVIA` per la singola riga                                  | vietato senza permesso esatto                               |
| bozza vietata       | `SALVA IN BOZZE`                                                                         | non viene mai usata                                         |
| readback            | ricerca/inviate, nome, numero, data, totale, stato e ID remoto                           | mismatch o `NOT_FOUND` mantiene il blocco                   |
| file ufficiali      | link visibili `Scarica XML/P7M/PDF/notifica`                                             | file assente ignorato; file malformato blocca la sessione   |

Il pannello mostra le date come `GG/MM/AAAA` e gli importi con virgola e simbolo euro; gli attributi sintetici restano ammessi nei test. I limiti riletti sono 4,9 MB per documento, 300 documenti e 30 MB per caricamento. L’helper applica tutti e tre i limiti prima dell’upload.

Con più documenti l’helper deve usare esclusivamente `INVIA TUTTE`: scegliere il primo `INVIA` di riga invierebbe soltanto una parte del manifest ed è quindi un DOM non riconosciuto. La modalità assistita si arresta prima di qualunque controllo di invio.

L’assenza di una conferma visibile o dell’identificativo remoto dopo il clic non viene interpretata come successo: apre la riconciliazione. Gli stati conclusivi non possono regredire e un invio già osservato non può diventare `REMOVED` e ritentabile.

Ogni divergenza del DOM reale deve aggiornare insieme questo contratto, l’helper e i test sintetici. Non è ammesso usare endpoint Aruba osservati tramite strumenti di sviluppo.
