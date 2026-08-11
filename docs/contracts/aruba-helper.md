# Contratto candidato dell’helper Aruba

Questo contratto governa la pagina sintetica e l’helper locale unico per macOS e Windows. I locatori del pannello reale restano candidati finché la prova controllata precedente al Canary Production non li conferma.

## Confini di sicurezza

- Il solo host operativo ammesso è `https://fatturazioneelettronica.aruba.it`; in prova sono ammessi esclusivamente i loopback e `/aruba-sintetica`.
- L’helper usa Chrome o Edge installato localmente e un profilo browser dedicato. Non legge, esporta o trasmette cookie e local storage.
- Login, password, OTP, 2FA, SMS e CAPTCHA sono sempre umani: se richiesti, l’helper si mette in pausa.
- Il codice di avvio scade, vale per un batch, viene revocato quando termina la propria fase e non autorizza `Invia`. Durante una pausa umana l’helper ne rinnova la scadenza breve con heartbeat, entro un limite assoluto di 45 minuti dalla creazione.
- Il permesso di invio automatico è distinto, scade ed è consumato atomicamente sul manifest esatto. In ambiente operativo il kill switch disabilita gli invii automatici ordinari e forza i nuovi batch alla modalità assistita.
- Dopo un esito incerto il manifest espone soltanto l’operazione `READBACK`: nessun nuovo upload o invio è ammesso fino alla riconciliazione.

## Manifest

Il manifest immutabile comprende ambiente, modalità, riferimento non segreto dell’account atteso, tentativo e, per ogni documento, ID, revisione, hash XML, nome file, dimensione, numero fiscale, data e totale. L’hash del manifest vincola il permesso monouso. Gli XML scaricati dall’helper vengono accettati soltanto se dimensione e SHA-256 coincidono.

Gli endpoint interni espongono manifest, singolo XML, import dei file ufficiali, eventi sanitizzati e consumo del permesso. Accettano soltanto il bearer breve; non ricevono mai dati di autenticazione Aruba.

## Contratto visibile candidato

| Funzione       | Etichette candidate                                                                      | Esito fail-closed                                                 |
| -------------- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| upload         | `Seleziona documenti`, `Carica fattura/e`                                                | arresto se il controllo non esiste                                |
| protezione SMS | `Vuoi disattivare la protezione OTP`, `Inserisci il codice ricevuto per SMS`, `Verifica` | pausa finché il titolare completa `Prosegui`, codice e `Verifica` |
| validazione    | riga col nome file, `Dettagli errori`, `errori`                                          | batch non inviabile                                               |
| rimozione      | `Rimuovi`, `Elimina`                                                                     | readback obbligatorio                                             |
| clic finale    | `Invia`, `Invia tutte`                                                                   | vietato senza permesso esatto                                     |
| bozza vietata  | `Salva in bozze`                                                                         | non viene mai usata                                               |
| readback       | ricerca/inviate, nome, numero, data, totale, stato e ID remoto                           | mismatch o `NOT_FOUND` mantiene il blocco                         |
| file ufficiali | link visibili `Scarica XML/P7M/PDF/notifica`                                             | file assente ignorato; file malformato blocca la sessione         |

L’assenza di una conferma visibile o dell’identificativo remoto dopo il clic non viene interpretata come successo: apre la riconciliazione. Gli stati conclusivi non possono regredire e un invio già osservato non può diventare `REMOVED` e ritentabile.

Ogni divergenza del DOM reale deve aggiornare insieme questo contratto, l’helper e i test sintetici. Non è ammesso usare endpoint Aruba osservati tramite strumenti di sviluppo.
