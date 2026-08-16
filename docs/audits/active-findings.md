# Finding tecnici attivi

Questo documento è la vista breve dello stato tecnico corrente. Il registro completo delle verifiche storiche resta nell'[audit del release candidate](release-candidate-review.md); qui devono comparire soltanto finding ancora azionabili o appena corretti ma non ancora verificati sull'HEAD esatto.

## Correzioni in verifica

| Finding | Stato | Correzione |
| ------- | ----- | ---------- |
| RC-65 | In verifica | Il completamento incompleto committa lo stato `INCOMPLETE` prima di restituire l'errore, evitando che il rollback cancelli la diagnosi. |
| RC-66 | In verifica | Stream e finestra minima vengono fotografati nella sessione Aruba e non sono più ricalcolati al completamento. |
| RC-68 | In verifica | Il fallback manuale traduce JSON non valido in `ARUBA_INVENTORY_INVALID`. |
| RC-71 | In verifica | Lo snapshot della sessione include anche l'anno fiscale che può iniziare prima della sua scadenza. |
| RC-74 | In verifica | I documenti storici Aruba materializzano `document_lines` dallo snapshot immutabile e restano protetti dalle mutazioni successive. |
| RC-76 | In verifica | I download ufficiali Production vengono letti in streaming con limite anticipato e interruzione del body oltre soglia. |

## Debito strutturale

I moduli legacy già grandi sono soggetti a un ratchet di dimensione: non possono crescere ulteriormente. Manifest e completamento dell'inventario Aruba sono stati estratti in un modulo dedicato; nuove responsabilità non devono essere aggiunte ai file legacy sovradimensionati.

Il ratchet non impone una riscrittura. Quando una modifica futura tocca una responsabilità isolabile di uno dei moduli legacy, quella responsabilità va estratta con la relativa regressione nello stesso intervento.

## Regola di chiusura

Un finding passa a **Chiuso** soltanto quando la correzione e la regressione dedicata sono verdi sui gate applicabili dell'HEAD esatto. Una volta chiuso, può essere rimosso da questa vista breve perché il registro storico conserva l'evidenza.
