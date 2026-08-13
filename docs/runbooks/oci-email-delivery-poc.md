# PoC OCI Email Delivery in Development

## Stato e confine

Il titolare ha confermato il controllo del dominio mittente e ha autorizzato il PoC Development. Nella regione di Milano risultano attivi il dominio e-mail, la firma DKIM e un mittente approvato; il record SPF con OCI Europa è pubblicato e verificato sui quattro server Aruba e sui resolver pubblici. La credenziale SMTP dedicata è custodita soltanto nel file locale ignorato da Git e leggibile dal solo titolare.

La tenancy espone a Milano un limite tecnico di 50.000 e-mail al giorno. Questo limite non è una soglia di spesa: il listino OCI include gratuitamente le prime 3.000 e-mail al mese e tariffa l'eccedenza. Il titolare stima al massimo 500 copie mensili; anche applicando il margine operativo prudenziale di 2.500 invii, Hub-Fatture resta nella fascia gratuita.

## Preparazione completata

- adapter applicativo unico Nodemailer e trasporto OCI selezionabile senza fallback;
- Development sintetico senza rete e Production fail-closed senza configurazione completa;
- sender, destinatario, contenuto, allegato, tentativi e Message-ID persistiti senza finire nei log;
- casi consegna, errore, retry e crash riproducibili localmente con trasporto JSON;
- dominio, DKIM e mittente approvato verificati attivi nella stessa regione;
- SPF OCI pubblicato e verificato sui DNS autorevoli e pubblici;
- configurazione Compose condivisa da app e worker, protetta dal default sintetico;
- autenticazione TLS riuscita e credenziale alterata rifiutata con il solo codice sanificato;
- primo invio e reinvio manuale accettati verso il mittente controllato, con allegato sintetico;
- primo invio e reinvio confermati nella casella controllata, allegati compresi;
- hard bounce ottenuto con un solo indirizzo riservato `.invalid` e suppression automatica verificata;
- criteri e record di uscita definiti qui sotto.

## Confronto con l'SMTP esistente

Il readback pubblico del 2026-08-11T13:11:20Z identifica Google come servizio di posta già autorizzato dal dominio: i record MX puntano a Google e lo SPF include `_spf.google.com`. Il titolare conferma che l'indirizzo mittente è già usato dal negozio. Il confronto non ha richiesto credenziali Google né un altro invio.

| Criterio                 | SMTP esistente del negozio                                                                                                                                                       | OCI Email Delivery                                                                                                                      | Esito                                                              |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Autenticazione           | funziona per l'uso umano corrente, ma Hub-Fatture non dispone di una credenziale applicativa dedicata; l'adozione richiederebbe una password per app o OAuth legati alla casella | credenziale SMTP separata, autenticazione TLS riuscita e credenziale alterata rifiutata con `EAUTH`                                     | OCI separa l'app dalla casella personale                           |
| Deliverability osservata | posta ordinaria del negozio operativa; nessuna prova applicativa isolata con allegato, mancata consegna e reinvio                                                                | primo invio e reinvio ricevuti con allegato; hard bounce e suppression osservati                                                        | OCI copre l'intero percorso richiesto a Hub-Fatture                |
| Limiti                   | dipendono dal piano e dall'account Google correnti; la quota applicabile non è stata qualificata per un client automatico                                                        | limite tecnico della tenancy 50.000 al giorno, prime 3.000 e-mail mensili incluse e massimo previsto 500, con margine prudenziale 2.500 | OCI ha capacità e costo verificati per il volume previsto          |
| Diagnosi                 | nessuna ricevuta o suppression applicativa dedicata è stata dimostrata; la diagnosi resterebbe mescolata alla casella usata dal negozio                                          | errori SMTP sanificati, conteggio accettati/rifiutati e suppression OCI con ID e motivo `HARDBOUNCE`                                    | OCI offre un confine diagnostico dedicato                          |
| Semplicità operativa     | evita nuove risorse, ma richiede collegare Hub-Fatture alla casella e al suo ciclo di credenziali e autenticazione                                                               | dominio, DKIM, SPF, mittente e credenziale dedicata sono già verificati; app e worker condividono un solo trasporto                     | OCI è più semplice da gestire senza coinvolgere la posta personale |

L'SMTP esistente resta tecnicamente possibile, ma non offre oggi un'identità applicativa isolata né la stessa evidenza end-to-end. OCI soddisfa tutti e cinque i criteri senza un nuovo provider a pagamento e viene quindi scelto come unico trasporto canonico.

## Decisione

`OCI_EMAIL_DELIVERY` è il solo trasporto SMTP canonico scelto per Hub-Fatture. Non esistono fallback o doppio invio. La configurazione Production e il relativo secret store appartengono alla fase di messa in produzione; l'app Development già in esecuzione resta sintetica finché non viene riavviata nel normale ciclo operativo.

HF-O07 si riapre se il volume previsto raggiunge 2.500 invii mensili, se cambia la fascia gratuita o se consegna e suppression non restano affidabili. In quel caso Hub-Fatture torna a `SYNTHETIC` finché il titolare non approva un nuovo trasporto gratuito.

## Evidenza necessaria per chiudere HF-O07

- volume previsto compatibile con la fascia gratuita e assenza di costi verificata;
- sender e allineamento SPF/DKIM verificati senza pubblicare valori sensibili;
- consegna, errore, hard bounce, suppression e reinvio osservati con dati sintetici;
- nessun destinatario, contenuto, credenziale o risposta SMTP integrale nei log;
- decisione `EXISTING_SMTP` o `OCI_EMAIL_DELIVERY`, con motivazione e rollback.

Tutti i punti sono verificati. HF-O07 è chiusa su `OCI_EMAIL_DELIVERY`.

## Qualifica del candidato Production

La qualifica sul candidato distribuito usa `build-server/operations/email-delivery-qualification.js` dentro il container worker. Lo script importa lo stesso adapter SMTP del job applicativo e non crea documenti, numeri fiscali, righe e-mail o job sintetici nel database Production.

Prerequisiti:

1. PR pubblicata, candidato distribuito e readback di commit, versione e digest completato;
2. autorizzazione specifica del titolare per una sola e-mail sintetica verso il mittente controllato;
3. `SMTP_TRANSPORT=OCI_EMAIL_DELIVERY`, configurazione completa e kill switch Aruba invariato;
4. nessun valore SMTP o indirizzo stampato nel terminale o nell’evidenza.

Esecuzione presidiata, soltanto dopo l’autorizzazione:

```sh
docker compose -f compose.yaml --env-file .env --env-file .deploy.env exec -T \
  -e "EMAIL_QUALIFICATION_CONFIRM=QUALIFY_EMAIL:<commit-esatto>" app-worker \
  node build-server/operations/email-delivery-qualification.js
```

La diagnostica rifiuta ambienti diversi da Production, commit o digest non canonici, trasporti diversi da OCI e conferme non legate al commit. Esegue prima un’autenticazione intenzionalmente errata, che deve essere classificata come permanente senza inviare; ripete poi lo stesso messaggio sintetico con la credenziale canonica. Il solo destinatario è il mittente controllato già configurato e l’allegato dichiara esplicitamente di non essere fiscale.

La ricevuta JSON ammessa contiene soltanto commit, versione, digest, trasporto, classificazione dell’errore, conteggi accettati/rifiutati e hash di Message-ID e allegato. La chiusura richiede inoltre il readback umano della singola e-mail e dell’allegato nella casella controllata. Qualunque esito diverso lascia il gate aperto e non autorizza un secondo tentativo automatico.
