# Changelog

## 0.3.0

- Aggiunta la ricerca globale da ogni pagina per ordini, fatture e clienti, con risultati immediati, scorciatoia da tastiera e campi anagrafici e fiscali.
- Introdotto il dettaglio cliente con dati di fatturazione, ordini e fatture recenti collegati alle rispettive superfici operative.
- Completati stati iniziale, caricamento, vuoto ed errore, navigazione da tastiera e layout coerente con la Dashboard su desktop e mobile.
- Stabilizzata una sola richiesta per query e rimossa su mobile l’indicazione `Esc`, mantenendo la chiusura tramite il comando visibile.

## 0.2.5

- Le code operative della Dashboard aprono viste che riflettono gli stessi criteri dei rispettivi conteggi.
- I pagamenti in attesa includono anche gli ordini con un movimento pendente e stato sintetico già aggiornato; le note di credito in bozza sono raggiungibili dalla coda Attività filtrata.

## 0.2.4

- Lo stato operativo non segnala più aggiornamenti Aruba da completare quando il primo readback non è ancora necessario; l’avviso resta vincolato alla presenza di un batch aperto.

## 0.2.3

- Manifest della release allegato con il nome canonico `release-manifest.json`, senza modifiche al comportamento applicativo.

## 0.2.2

- Allowlist GitHub Actions allineata ai repository Docker approvati con pin SHA obbligatorio, evitando che un aggiornamento valido venga rifiutato prima dell’avvio dei job.
- Metadati di release riallineati al commit Production esatto senza modifiche al comportamento applicativo.

## 0.2.1

- Ripristinata la separazione visiva fra l’azione di riconnessione e la conferma dell’import iniziale completato nelle schede Shopify ed eBay.
- Workflow Production aggiornato alle ultime Action Docker su Node 24, mantenendo i riferimenti fissati a SHA completi.

## 0.2.0

- Dashboard riorganizzata come regia operativa: priorità, criticità e collegamenti hanno gerarchie distinte e azioni dirette.
- Stato dei collegamenti reso esplicito anche quando non esistono ancora aggiornamenti o il dato è obsoleto, senza dichiarare esiti positivi non osservati.
- Documenti emessi accompagnati dall’andamento reale degli ultimi sette giorni, con resa coerente anche nello stato vuoto.
- Layout della Dashboard verificato su desktop, mobile, tema chiaro e tema scuro.

## 0.1.1

- Separati rendering, orchestrazione HTTP e persistenza nei flussi Impostazioni e Preparazione fattura, impedendo import runtime dei moduli server nel client.
- Isolati storage documentale e validazione degli identificativi PostgreSQL, eliminando il ciclo fra documenti e comandi ordine.
- Aggiunti il gate automatico sui cicli di import e fixture temporali deterministiche per le note di credito.
- Il backup pre-deploy usa ora il bundle operativo della release installata, evitando incompatibilità con i moduli del candidato prima del passaggio di versione.

## 0.1.0

- Prima release tecnica versionata della Production, con rollback al digest precedente.
- Dashboard completata con tutte le code operative, gli errori provider, gli ultimi aggiornamenti e i documenti emessi.
- Ordini e Attività resi più leggibili su mobile, con viste auto-centrate, filtri espliciti, reset e cronologia più compatta.
- Impostazioni rese navigabili a 320 px, con salvataggi abilitati solo dopo una modifica e dettagli tecnici senza overflow.
- Empty state e pagina non trovata ora offrono una prossima azione coerente.

## In lavorazione

- M6 locale: rimborsi, TD04 cumulative, vincoli PostgreSQL, copia cliente e trasporto sintetico Nodemailer.
- HF-O07 resta aperta: PoC OCI preparato ma non eseguito; nessun trasporto Production è stato ancora approvato.
