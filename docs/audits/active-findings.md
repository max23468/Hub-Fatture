# Finding tecnici attivi

Questo documento è la vista breve dello stato tecnico corrente. Il registro completo delle verifiche storiche resta nell'[audit del release candidate](release-candidate-review.md).

## Stato corrente

**Nessun finding RC aperto nella PR #160.** Le correzioni funzionali sono state verificate sull'albero codice `efeb616f17282129112e5ef179dd04a46a69c45b`; le modifiche successive a questo record sono esclusivamente documentali.

- **RC-65 — Chiuso.** Il completamento incompleto committa lo stato `INCOMPLETE` prima di restituire l'errore, evitando che il rollback cancelli la diagnosi.
- **RC-66 — Chiuso.** Stream e finestra minima vengono fotografati prima che la sessione Aruba sia restituita al chiamante e non sono più ricalcolati al completamento; la regressione verifica anche che l'ordine degli stream resti irrilevante come nel contratto precedente.
- **RC-68 — Chiuso.** Il fallback manuale traduce JSON non valido in `ARUBA_INVENTORY_INVALID`.
- **RC-71 — Chiuso.** Lo snapshot della sessione include anche l'anno fiscale che può iniziare prima della sua scadenza.
- **RC-74 — Chiuso.** Le preparazioni storiche `ARUBA_HISTORY` prive di righe in `document_lines` usano in sola lettura le righe dello snapshot immutabile e l'XML archiviato, senza mutare il documento approvato; una regressione PostgreSQL con storage XML reale copre il percorso.
- **RC-76 — Chiuso.** I download ufficiali diretti vengono letti in streaming con limite anticipato e interruzione del body oltre soglia, inclusi i `data:` URL ammessi dal contratto; il runner Production è vincolato al percorso bounded e l'intercettore è esercitato su un `APIRequestContext` Playwright reale.

## Verifica

Sull'albero codice indicato sono risultati verdi gate standard, PostgreSQL e migrazioni, contract test provider, audit dipendenze, guardie repository, E2E Chromium e WebKit, helper Edge/Windows, Foundation, React Doctor, Dependency Review e CodeQL. L'helper Chrome/macOS era già verde sul medesimo codice funzionale; l'ultima esecuzione equivalente era ancora in coda per disponibilità del runner al momento della chiusura del record.

## Debito strutturale

I moduli legacy già grandi sono soggetti a un ratchet di dimensione: non possono crescere ulteriormente. Manifest e completamento dell'inventario Aruba sono stati separati dal percorso live in un modulo dedicato; nuove responsabilità non devono essere aggiunte ai file legacy sovradimensionati.

Il ratchet non impone una riscrittura. Quando una modifica futura tocca una responsabilità isolabile di uno dei moduli legacy, quella responsabilità va estratta con la relativa regressione nello stesso intervento.

## Regola di chiusura

Un finding passa a **Chiuso** soltanto quando la correzione e la regressione dedicata sono verdi sui gate applicabili dell'albero codice verificato. Modifiche successive esclusivamente documentali non invalidano tale evidenza; qualsiasi modifica al codice richiede una nuova verifica.
