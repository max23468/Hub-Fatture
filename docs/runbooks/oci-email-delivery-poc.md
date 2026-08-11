# PoC OCI Email Delivery in Development

## Stato e confine

Il titolare ha confermato il controllo del dominio mittente e dei suoi record DNS. Questa sessione prepara il PoC ma non autorizza creazione di risorse OCI, modifiche DNS/SPF/DKIM, richiesta o uso di credenziali SMTP, consultazione di suppression contenenti dati reali o invio di e-mail.

Il preflight documentale corrente rileva inoltre che la tabella ufficiale dei [limiti OCI](https://docs.oracle.com/en-us/iaas/Content/General/service-limits/default.htm#email-delivery-limits) indica `max-emails-day = 0` per Always Free. Prima di qualsiasi risorsa va quindi verificata nella tenancy e nella regione scelte l’esistenza di una quota gratuita effettivamente utilizzabile. In assenza, il vincolo «nessun provider a pagamento» rende OCI non idoneo e il trasporto canonico resta l’SMTP esistente.

## Preparazione completata

- adapter applicativo unico Nodemailer e trasporto OCI selezionabile senza fallback;
- Development sintetico senza rete e Production fail-closed senza configurazione completa;
- sender, destinatario, contenuto, allegato, tentativi e Message-ID persistiti senza finire nei log;
- casi consegna, errore, retry e crash riproducibili localmente con trasporto JSON;
- criteri e record di uscita definiti qui sotto.

## Esecuzione futura, solo dopo autorizzazioni specifiche

1. Rileggere nella Console OCI regione, endpoint, quote, limiti e assenza di costi attivabili; interrompere se l’invio gratuito non è disponibile.
2. Scegliere un compartment non root e una regione sola. Approved sender e domini sono regionali: [documentazione Oracle](https://docs.oracle.com/en-us/iaas/Content/Email/Reference/gettingstarted_topic-Create_an_approved_sender.htm).
3. Creare identità e policy minime dedicate, dominio e approved sender. Non riusare credenziali applicative esistenti.
4. Preparare e far approvare le modifiche DNS seguendo le guide OCI per [SPF](https://docs.oracle.com/en-us/iaas/Content/Email/Tasks/configurespf.htm) e DKIM; applicarle soltanto con un’autorizzazione DNS separata.
5. Creare credenziali SMTP dedicate e custodirle nel secret store soltanto con autorizzazione separata.
6. Con documento e destinatario controllati, provare inbox, Message-ID, errore stabile, hard bounce, [suppression](https://docs.oracle.com/en-us/iaas/Content/Email/Tasks/managingsuppressionlist.htm) e reinvio. Ogni invio richiede un’ulteriore autorizzazione esplicita.
7. Confrontare OCI e SMTP esistente per autenticazione, deliverability osservata, limiti, diagnosi, costi e semplicità operativa.
8. Scegliere un solo trasporto Production, aggiornare contratto ed evidenza e rimuovere le risorse OCI se il PoC fallisce.

## Evidenza necessaria per chiudere HF-O07

- quota e assenza di costi lette dalla tenancy nella regione scelta;
- sender e allineamento SPF/DKIM verificati senza pubblicare valori sensibili;
- consegna, errore, hard bounce, suppression e reinvio osservati con dati sintetici;
- nessun destinatario, contenuto, credenziale o risposta SMTP integrale nei log;
- decisione `EXISTING_SMTP` o `OCI_EMAIL_DELIVERY`, con motivazione e rollback.

Senza tutti questi punti la decisione sul trasporto e la milestone corrente restano aperte.
