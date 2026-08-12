# Changelog

## 0.3.12

- La riconciliazione storica riconosce la stessa riga di indirizzo quando Aruba separa il civico in un campo strutturato.
- Nome, civico, CAP, città, Paese, data, totale, profilo fiscale e unicità restano obbligatori; i casi non univoci continuano a essere bloccati.

## 0.3.11

- La tabella Clienti mostra l’identificativo fiscale dopo l’e-mail senza distinguerne il tipo e usa uno stato neutro quando il dato non è disponibile.
- La tabella Attività espone lo stesso dato dopo il cliente, ricavandolo dallo snapshot autorevole di ordine, preparazione, fattura o documento anche per rimborsi, job falliti e note di credito.
- Le nuove colonne restano leggibili nei layout desktop e passano alla presentazione a schede sui viewport più stretti.

## 0.3.10

- Le anagrafiche importate e corrette separano lo snapshot sorgente immutabile, il profilo canonico usato per il matching e una forma di presentazione coerente per interfaccia e documenti.
- Nomi personali, città e indirizzi italiani vengono resi leggibili senza reinterpretare ragioni sociali, casing intenzionale o indirizzi esteri ambigui; e-mail, PEC, codici destinatario, Paese, provincia e CAP sono uniformati nei rispettivi formati.
- La suite PostgreSQL limita la concorrenza del runner e i test e-mail rivendicano il job dell'esatta consegna, eliminando contesa e selezioni non deterministiche senza modificare la coda Production.

## 0.3.9

- La riconciliazione storica eBay collega gli XML Aruba privi di riferimento marketplace soltanto quando data, totale e destinatario identificano un candidato univoco nell’intero storico.
- Per destinatari senza identificativo fiscale sono richiesti identità completa e indirizzo coerente; l’ordine dei token resta flessibile soltanto per nome e cognome di persona, mentre ragioni sociali, omonimi e rimborsi ambigui restano prudenzialmente bloccati.
- I metodi di pagamento storici MP01, MP05 e MP08 vengono conservati senza modificare il profilo fiscale attivo; lo stesso documento non può essere riutilizzato su ordini diversi.

## 0.3.8

- Le fatture Aruba storiche conservano la modalità di pagamento effettiva `MP01`, `MP05` o `MP08`, purché usino l'unica condizione ammessa `TP02`.
- Il confronto non confonde più il metodo documentale con il default `MP08` del profilo fiscale e continua a bloccare modalità mancanti, multiple o non supportate.

## 0.3.7

- Gli XML Aruba storici Shopify senza riferimento esplicito possono essere collegati soltanto quando data, destinatario, totale fatturabile, profilo fiscale e unicità individuano lo stesso ordine.
- Riferimenti a ordini diversi, marker marketplace incompatibili, importi lordi in presenza di commissioni Shopify Payments, rimborsi ambigui o documenti già collegati bloccano il confronto.
- Gli ordini Shopify restano in revisione storica e non approvabili finché il confronto con l'XML ufficiale non produce un esito verificato.

## 0.3.6

- Gli ordini eBay recuperano l'identificativo fiscale con il marketplace corretto; Shopify usa come ultimo fallback un unico CF o P.IVA italiana presente nel campo interno dell'indirizzo di fatturazione.
- Dopo il deploy, gli ordini già importati vengono riallineati automaticamente tramite il normale import idempotente, senza duplicati.
- Il nome Hub Fatture resta su una sola riga e accompagna apertura e chiusura della sidebar desktop con una transizione coordinata di larghezza e opacità.
- Corretto il ritorno a capo istantaneo che compariva perché il nome tornava visibile prima che la sidebar avesse recuperato una larghezza sufficiente.
- Il pulsante di ricerca non mostra più il badge della scorciatoia da tastiera; la scorciatoia resta disponibile senza occupare spazio nell'interfaccia.

## 0.3.5

- Pubblicazione proporzionata all'impatto delle modifiche, con classificazione conservativa e verifiche indipendenti eseguite in parallelo.
- Deploy Production escluso per modifiche prive di impatto runtime, vincolato ai check cumulativi non mascherabili da no-op e registrato sul commit realmente installato.
- Immagine Production costruita, analizzata e attestata una sola volta, poi riutilizzata dal deploy senza ricostruzioni divergenti.
- Backup straordinario riservato alle modifiche di schema o storage; negli altri casi il deploy riusa un backup giornaliero ancora valido.
- Rollback deliberato verso un commit precedente distinto dall'avanzamento cumulativo, vincolato al digest attestato e bloccato prima del deploy quando lo schema diverge.

## 0.3.4

- La pagina Attività organizza le verifiche in una tabella compatta per elemento, cliente, canale o tipo, data ordine e ultimo aggiornamento, con riepilogo operativo e cronologia più leggibili.
- Paginazione a 50 righe, celle su una riga e passaggio anticipato a schede mantengono scansionabili decine di attività su desktop, viewport intermedie e mobile; l’azione resta contenuta nella propria colonna con margine stabile dal bordo.
- La vista si concentra su ordini, documenti e operazioni non riuscite: le richieste privacy non compaiono più in Attività, mentre registrazione e gestione tecnica dei webhook Shopify restano invariate.

## 0.3.3

- La nuova sezione Clienti riunisce ricerca, filtri di verifica e riepilogo delle anagrafiche collegate a Shopify ed eBay, senza esporre identificativi fiscali nell’elenco.
- Il dettaglio cliente collega anagrafica corrente, fonti, ordini, preparazioni e documenti; il dato fiscale resta disponibile nella ricerca globale e nel dettaglio.
- Sidebar desktop e navigazione mobile includono Clienti con layout responsivo e controlli di regressione contro colonne vuote o contenuti che sbordano dal pannello.

## 0.3.2

- Le commissioni effettive sono sottratte dal totale fatturabile soltanto per transazioni Shopify Payments riuscite; PayPal, bonifici, metodi manuali ed eBay restano al lordo.
- La regola è modificabile nelle Impostazioni e ricalcola in modo serializzato soltanto ordini e documenti ancora modificabili, mantenendo le fee osservate come dato immutabile.
- Riconciliazione storica, comparatore, rimborsi e TD04 usano il totale coerente con la fattura emessa; gli override manuali rispettano il residuo attribuito a ciascun ordine senza alterare il rimborso lordo del provider.

## 0.3.1

- Manifest della release allegato con il nome canonico `release-manifest.json`, senza modifiche al comportamento applicativo.

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
