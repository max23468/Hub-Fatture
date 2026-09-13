# Finding tecnici attivi

Questo documento è la vista breve dei finding tecnici ancora da risolvere. Il registro delle verifiche concluse resta nell'[audit del release candidate](release-candidate-review.md).

## Stato corrente

**Nessun finding tecnico attivo nella revisione strutturale corrente.**

I finding sono stati corretti e verificati sul worktree integrato con i gate locali applicabili. Questa vista non attesta lo stato live né sostituisce la CI dell'HEAD.

## Verifica

La verifica locale comprende gate standard, audit, suite unitarie, database e provider, build, Doctor e matrice E2E Chromium/WebKit. Non esistono ancora prove CI o pubblicazione per queste modifiche locali; quei passaggi derivano dalle rispettive fonti autorevoli quando vengono eseguiti.

## Controlli strutturali

La lunghezza di un file non costituisce da sola un difetto e non è soggetta a una soglia numerica. Il controllo automatico tutela invece i confini osservabili: dipendenze applicative acicliche, moduli server con almeno un consumatore runtime, aggiornamento della proiezione dei Controlli fuori dalle richieste web e assenza delle superfici Aruba ritirate.

Quando una modifica tocca responsabilità distinte, confini di effetto reali o dipendenze riusabili, la responsabilità viene estratta con la regressione pertinente nello stesso intervento. Query e transazioni coese restano unite anche se il file è grande.

## Regola di chiusura

Un finding passa a **Chiuso** soltanto quando la correzione e la regressione dedicata sono verdi sui gate applicabili dell'HEAD verificato. Qualsiasi modifica successiva al codice richiede una nuova verifica.
