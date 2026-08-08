# Contratto del dominio ordini

## Confine d’ingresso

I connettori consegnano al dominio un ordine normalizzato e validato. La piattaforma resta fonte autorevole per ordine, pagamento, evasione, annullamento e dati sorgente; Hub Fatture conserva lo snapshot importato e il modello normalizzato senza modificare la piattaforma.

Sono accettati soltanto importi decimali rappresentabili esattamente in centesimi e nel dominio `integer` PostgreSQL, quantità nello stesso dominio, testi privi di byte NUL, sconti non superiori al lordo della riga, codici Paese alfabetici di due lettere, valuta EUR e date con offset. Un input invalido, un ordine ripetuto nello stesso batch o una valuta diversa interrompono atomicamente l’intero batch. Campi anagrafici mancanti restano invece rappresentabili: l’ordine viene conservato e la preparazione richiede verifica.

## Idempotenza e raggruppamento

- L’identità dell’ordine è `provider + account + external_order_id`.
- L’identità cliente privilegia l’identificativo previsto dal tipo destinatario; Codice Fiscale e P.IVA italiani hanno una chiave canonica indipendente dal Paese opzionale, mentre un identificativo estero conserva e richiede il Paese dichiarato o dell’indirizzo.
- L’e-mail da sola non unisce clienti. Un’identità insufficiente resta specifica dell’ordine e richiede verifica.
- Gli ordini idonei confluiscono nel raggruppamento interno aperto dello stesso cliente, data ordine `Europe/Rome` e valuta; un advisory lock e un indice univoco parziale rendono atomica la scelta.
- Un raggruppamento già creato non viene ricreato quando cambia il trigger globale. Il cambio rivaluta soltanto ordini ancora privi di raggruppamento.
- Un singolo ordine non annullato può essere preparato manualmente prima del trigger; l’operazione è idempotente e registrata nell’audit.
- Un ordine già rimborsato prima della preparazione resta escluso dalla fatturazione anche se è evaso o viene richiesto manualmente.
- Una preparazione con almeno un pagamento pendente resta `NEEDS_REVIEW` e mostra lo stato del pagamento.
- Una risincronizzazione aggiorna gli snapshot sorgente ma non sposta un ordine già raggruppato.
- Una risincronizzazione riconcilia solo i pagamenti sorgente e conserva quelli registrati manualmente.
- Ordini e preparazioni leggono la propria anagrafica immutabile; aggiornare il cliente normalizzato non modifica retroattivamente dati già raggruppati.
- Un aggiornamento con `updated_at_source` meno recente di quello persistito viene confrontato alla precisione di PostgreSQL, ignorato prima di qualsiasi mutazione e conteggiato nel risultato dell’import.
- Se cambiano dati rilevanti per la preparazione — identità e anagrafica cliente, totale, righe, pagamenti, stato o annullamento — il raggruppamento esistente passa a `NEEDS_REVIEW`; soli timestamp tecnici e campi di provenienza non generano falsi allarmi.
- Ogni conflitto conserva in modo immutabile snapshot normalizzato precedente e corrente. Un annullamento o rimborso prima dell’emissione porta invece la preparazione a `DO_NOT_TRANSMIT` con motivazione e audit.
- Le preparazioni `DO_NOT_TRANSMIT` restano consultabili nell’archivio anche quando una successiva rettifica sposta tutti gli ordini in una nuova preparazione. La riattivazione è proposta soltanto quando contengono ordini compatibili e non esiste già un altro raggruppamento aperto per lo stesso cliente, giorno e valuta; eventuali anagrafiche discordanti mantengono la preparazione in `NEEDS_REVIEW`.

## Audit e concorrenza

Importazione, creazione del raggruppamento, assegnazione ordine e cambio trigger producono eventi allowlisted. Gli eventi critici condividono la transazione della mutazione attestata. Le revisioni delle impostazioni sono ottimistiche; una scrittura stale restituisce conflitto e richiede rilettura.

Importazioni e cambio trigger si sincronizzano sulla stessa chiave advisory: le importazioni mantengono un lock condiviso mentre leggono e applicano il trigger, mentre la modifica usa il lock esclusivo e rivaluta gli ordini non raggruppati.

I dettagli di ordine e preparazione vengono letti con una singola istruzione SQL, così testata, righe, pagamenti, audit e revisioni appartengono allo stesso snapshot PostgreSQL anche durante aggiornamenti concorrenti.
