# Finding tecnici attivi

Questo documento è la vista breve dei finding tecnici ancora da risolvere. Il registro delle verifiche concluse resta nell'[audit del release candidate](release-candidate-review.md).

## Stato corrente

**Nessun finding tecnico attivo registrato.**

Lo stato vale soltanto per un HEAD che supera i gate applicabili. Se una review o una verifica successiva apre un finding, va aggiunto qui finché correzione, regressione ed evidenza sul nuovo HEAD non sono complete.

## Verifica

La fonte corrente della verifica è la CI associata all'HEAD, non questo documento. Le prove concluse e il loro perimetro sono conservati nel registro storico.

## Debito strutturale

I moduli legacy già grandi sono soggetti a un ratchet di dimensione: non possono crescere ulteriormente. Manifest e completamento dell'inventario Aruba sono stati separati dal percorso live in un modulo dedicato; nuove responsabilità non devono essere aggiunte ai file legacy sovradimensionati.

Il ratchet non impone una riscrittura. Quando una modifica futura tocca una responsabilità isolabile di uno dei moduli legacy, quella responsabilità va estratta con la relativa regressione nello stesso intervento.

## Regola di chiusura

Un finding passa a **Chiuso** soltanto quando la correzione e la regressione dedicata sono verdi sui gate applicabili dell'HEAD verificato. Qualsiasi modifica successiva al codice richiede una nuova verifica.
