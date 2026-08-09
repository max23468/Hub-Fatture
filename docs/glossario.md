# Glossario

| Termine UI                  | Equivalente tecnico      | Significato                                                        | Non usare                      |
| --------------------------- | ------------------------ | ------------------------------------------------------------------ | ------------------------------ |
| Preparazione fattura        | `billing_case`           | Area di lavoro che raggruppa gli ordini prima del documento        | scheda, pratica                |
| Quando preparare le fatture | `draft_trigger`          | Regola che avvia la preparazione dopo il pagamento o la spedizione | trigger                        |
| Ordini di esempio           | fixture di sviluppo      | Ordini fittizi usati solo per provare l’app                        | fixture, dati sintetici        |
| Canale di vendita           | `provider`               | Shopify oppure eBay, da cui arriva l’ordine                        | provider, piattaforma          |
| Dati ricevuti               | source snapshot          | Informazioni originali ricevute da Shopify o eBay                  | dati sorgente                  |
| Dati usati da Hub Fatture   | normalized snapshot      | Informazioni rese coerenti e usate per preparare la fattura        | dati normalizzati              |
| Bozza                       | `draft`                  | Documento modificabile e non numerato                              | fattura emessa                 |
| Approvazione                | `approval`               | Conferma esplicita che precede numerazione e preparazione          | invio                          |
| Numerazione                 | `numbering`              | Assegnazione irreversibile del numero fiscale verificato           | salvataggio                    |
| Trasmissione                | `submission`             | Invio acquisito da Aruba                                           | validazione                    |
| Consegna                    | `delivered`              | Esito confermato da SdI                                            | caricato                       |
| Scarto                      | `rejected`               | Rifiuto confermato da Aruba o SdI                                  | errore generico                |
| Fattura                     | `invoice`                | Documento fiscale di vendita                                       | ordine                         |
| Nota di credito             | `credit_note`            | Documento TD04 collegato a una fattura emessa                      | rimborso                       |
| Rimborso                    | `refund`                 | Restituzione economica osservata sulla piattaforma                 | nota di credito                |
| Totale degli ordini         | `source_total`           | Totale immutabile importato                                        | totale sorgente, totale finale |
| Totale documento            | `document_total`         | Totale corrente della bozza                                        | totale sorgente                |
| Differenza                  | `difference`             | Scostamento motivato fra i due totali                              | arrotondamento implicito       |
| Pagamento pendente          | `pending_payment`        | Incasso non ancora confermato                                      | non pagato definitivamente     |
| Non trasmettere             | `do_not_transmit`        | Bozza archiviata senza numero né invio                             | elimina                        |
| Shopify / eBay              | provider sorgente        | Fonte autorevole dell’ordine                                       | gestionale fiscale             |
| Aruba                       | provider di trasmissione | Pannello ufficiale usato per upload e readback                     | API HF                         |
| SdI                         | Sistema di Interscambio  | Fonte dell’esito fiscale                                           | Aruba                          |
| Ambiente di prova           | `development`            | Ambiente con ordini di esempio                                     | Development, staging           |
| Ambiente operativo          | `production`             | Ambiente con dati reali autorizzati                                | Production, live generico      |
| Publish Git                 | merge/push Git           | Pubblicazione del codice in repository                             | deploy                         |
| Deploy                      | distribuzione            | Attivazione di un artefatto su un ambiente                         | release                        |
| Release                     | versione                 | Tag e GitHub Release autorizzati                                   | deploy                         |
