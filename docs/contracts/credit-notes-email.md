# Contratto note di credito ed e-mail

## Rimborsi e TD04

Ogni rimborso è identificato dalla chiave composta da provider, account, ordine e ID rimborso. Gli stati hanno questi effetti:

| Momento e stato                                   | Effetto                                                |
| ------------------------------------------------- | ------------------------------------------------------ |
| prima dell’emissione, completato e pari al totale | preparazione `Non trasmettere`                         |
| prima dell’emissione, completato e parziale certo | totale e righe della bozza ridotti                     |
| importo ambiguo o assente                         | `NEEDS_REVIEW`, senza stime                            |
| pending o failed                                  | nessuna nota e nessuna riduzione                       |
| dopo un esito `DELIVERED` o `NOT_DELIVERED`       | creazione o aggiornamento della TD04 cumulativa aperta |
| dopo l’approvazione della TD04                    | il rimborso successivo apre una nuova bozza            |

La TD04 eredita cliente, profilo fiscale e riferimenti dalla fattura originaria. Le righe sono aggregate per ordine e riportano l’importo rimborsato. Proiezione e XML definitivo usano il generatore FatturaPA comune, includono `DatiFattureCollegate` e attraversano lo stesso batch, manifest, helper assistito/automatico e fallback manuale delle fatture.

Il database registra quale rimborso è già stato sottratto prima dell’emissione e gli impedisce di entrare anche in una TD04. Un rimborso totale viene isolato nella propria preparazione `Non trasmettere`, senza chiudere altri ordini dello stesso cliente e giorno; un rimborso parziale rigenera subito totale, righe e proiezione della bozza. Il database impedisce inoltre il doppio collegamento dello stesso rimborso, il superamento del totale originario, il collegamento a una fattura non approvata o senza esito SdI valido e la modifica di documenti approvati. Collegamento, ricalcolo cumulativo e audit critico avvengono nella stessa transazione. Ogni TD04 richiede comparatore fiscale, hash e revisione correnti, `can_approve` e conferma esplicita.

## Copia e-mail al cliente

La modalità globale è `AUTOMATIC` oppure `MANUAL`. Prima dell’approvazione il titolare vede mittente, destinatario, oggetto, corpo, allegato previsto e sceglie `SEND` o `SKIP` per il singolo documento. La scelta e i contenuti approvati vengono congelati sul documento.

La consegna viene accodata una sola volta quando sono presenti insieme:

- documento approvato con scelta `SEND`;
- primo esito autorevole `DELIVERED` o `NOT_DELIVERED`;
- PDF ufficiale Aruba importato e verificato.

Validazione XML, acquisizione Aruba, `REJECTED` e stati incerti non autorizzano l’e-mail. Il job `send_customer_email` usa una chiave messaggio stabile, lease e tentativi persistenti. Registra `PENDING`, `SENT` o `FAILED`, trasporto, mittente, destinatario, Message-ID, tentativi, data ed esclusivamente un codice errore sanificato. Dopo un crash successivo all’avvio SMTP l’esito diventa `EMAIL_DELIVERY_UNCERTAIN`: non parte un retry cieco. Il reinvio manuale è vietato finché esiste un job attivo per il documento.

Un fallimento SMTP non aggiorna mai `documents.status`, le submission Aruba o le notifiche SdI. Soltanto gli errori temporanei ricevuti prima dell’accettazione vengono ritentati automaticamente; configurazione, autenticazione e rifiuti permanenti attendono una correzione e un reinvio manuale. Log e audit non contengono destinatario, corpo, allegato, credenziali o risposta SMTP integrale.

## Trasporto

Nodemailer è l’unico adapter. Ogni ambiente seleziona esattamente un trasporto: `SYNTHETIC`, `EXISTING_SMTP` oppure `OCI_EMAIL_DELIVERY`; non esistono doppio invio, bilanciamento o fallback automatico. `SYNTHETIC` usa il trasporto JSON locale e non apre connessioni di rete. I trasporti reali richiedono TLS e interrompono l’invio se non è disponibile; Production rifiuta il mittente sintetico. Il mittente mostrato prima dell’approvazione viene congelato sul documento insieme a destinatario, oggetto e corpo.

Il controllo del DNS è stato confermato dal titolare. HF-O07 resta aperta fino all’esecuzione separatamente autorizzata del [PoC OCI Email Delivery](../runbooks/oci-email-delivery-poc.md) e alla scelta documentata fra OCI e SMTP esistente. Fino ad allora non esiste un trasporto Production approvato e Development resta sintetico.
