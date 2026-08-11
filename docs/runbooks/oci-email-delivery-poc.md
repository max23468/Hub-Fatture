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
