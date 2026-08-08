# Contratto del dominio ordini

## Confine d’ingresso

I connettori consegnano al dominio un ordine normalizzato e validato. La piattaforma resta fonte autorevole per ordine, pagamento, evasione, annullamento e dati sorgente; Hub Fatture conserva lo snapshot importato e il modello normalizzato senza modificare la piattaforma.

Sono accettati soltanto importi decimali rappresentabili esattamente in centesimi e nel dominio `integer` PostgreSQL, valuta EUR e date con offset. Un input invalido o una valuta diversa interrompono atomicamente l’intero batch. Campi anagrafici mancanti restano invece rappresentabili: l’ordine viene conservato e la preparazione richiede verifica.

## Idempotenza e raggruppamento

- L’identità dell’ordine è `provider + account + external_order_id`.
- L’identità cliente privilegia l’identificativo previsto dal tipo destinatario; Codice Fiscale e P.IVA italiani hanno una chiave canonica indipendente dal Paese opzionale, mentre un identificativo estero richiede il Paese dichiarato o dell’indirizzo.
- L’e-mail da sola non unisce clienti. Un’identità insufficiente resta specifica dell’ordine e richiede verifica.
- Gli ordini idonei confluiscono nel raggruppamento interno aperto dello stesso cliente, data ordine `Europe/Rome` e valuta; un advisory lock e un indice univoco parziale rendono atomica la scelta.
- Un raggruppamento già creato non viene ricreato quando cambia il trigger globale. Il cambio rivaluta soltanto ordini ancora privi di raggruppamento.
- Un singolo ordine non annullato può essere preparato manualmente prima del trigger; l’operazione è idempotente e registrata nell’audit.
- Una risincronizzazione aggiorna gli snapshot sorgente ma non sposta un ordine già raggruppato.
- Ordini e preparazioni leggono la propria anagrafica immutabile; aggiornare il cliente normalizzato non modifica retroattivamente dati già raggruppati.
- Un aggiornamento con `updated_at_source` meno recente di quello persistito viene ignorato prima di qualsiasi mutazione e conteggiato nel risultato dell’import.
- Se cambiano dati rilevanti per la preparazione — identità e anagrafica cliente, totale, righe, pagamenti, stato o annullamento — il raggruppamento esistente passa a `NEEDS_REVIEW`; soli timestamp tecnici e campi di provenienza non generano falsi allarmi.

## Audit e concorrenza

Importazione, creazione del raggruppamento, assegnazione ordine e cambio trigger producono eventi allowlisted. Gli eventi critici condividono la transazione della mutazione attestata. Le revisioni delle impostazioni sono ottimistiche; una scrittura stale restituisce conflitto e richiede rilettura.

Importazioni e cambio trigger si sincronizzano sulla stessa chiave advisory: le importazioni mantengono un lock condiviso mentre leggono e applicano il trigger, mentre la modifica usa il lock esclusivo e rivaluta gli ordini non raggruppati.
