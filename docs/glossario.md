# Glossario

| Termine UI           | Equivalente tecnico      | Significato                                                 | Non usare                  |
| -------------------- | ------------------------ | ----------------------------------------------------------- | -------------------------- |
| Preparazione fattura | `billing_case`           | Area di lavoro che raggruppa gli ordini prima del documento | scheda, pratica            |
| Bozza                | `draft`                  | Documento modificabile e non numerato                       | fattura emessa             |
| Approvazione         | `approval`               | Conferma esplicita che precede numerazione e preparazione   | invio                      |
| Numerazione          | `numbering`              | Assegnazione irreversibile del numero fiscale verificato    | salvataggio                |
| Trasmissione         | `submission`             | Invio acquisito da Aruba                                    | validazione                |
| Consegna             | `delivered`              | Esito confermato da SdI                                     | caricato                   |
| Scarto               | `rejected`               | Rifiuto confermato da Aruba o SdI                           | errore generico            |
| Fattura              | `invoice`                | Documento fiscale di vendita                                | ordine                     |
| Nota di credito      | `credit_note`            | Documento TD04 collegato a una fattura emessa               | rimborso                   |
| Rimborso             | `refund`                 | Restituzione economica osservata sulla piattaforma          | nota di credito            |
| Totale sorgente      | `source_total`           | Totale immutabile importato                                 | totale finale              |
| Totale documento     | `document_total`         | Totale corrente della bozza                                 | totale sorgente            |
| Differenza           | `difference`             | Scostamento motivato fra i due totali                       | arrotondamento implicito   |
| Pagamento pendente   | `pending_payment`        | Incasso non ancora confermato                               | non pagato definitivamente |
| Non trasmettere      | `do_not_transmit`        | Bozza archiviata senza numero né invio                      | elimina                    |
| Shopify / eBay       | provider sorgente        | Fonte autorevole dell’ordine                                | gestionale fiscale         |
| Aruba                | provider di trasmissione | Pannello ufficiale usato per upload e readback              | API HF                     |
| SdI                  | Sistema di Interscambio  | Fonte dell’esito fiscale                                    | Aruba                      |
| Development          | `development`            | Ambiente con fixture e dati sintetici                       | staging                    |
| Production           | `production`             | Ambiente con dati reali autorizzati                         | live generico              |
| Publish Git          | merge/push Git           | Pubblicazione del codice in repository                      | deploy                     |
| Deploy               | distribuzione            | Attivazione di un artefatto su un ambiente                  | release                    |
| Release              | versione                 | Tag e GitHub Release autorizzati                            | deploy                     |
