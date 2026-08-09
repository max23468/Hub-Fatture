# Contratto del dominio ordini

## Confine d’ingresso

I connettori consegnano al dominio un ordine normalizzato e validato. La piattaforma resta fonte autorevole per ordine, pagamento, evasione, annullamento e dati sorgente; Hub Fatture conserva lo snapshot importato e il modello normalizzato senza modificare la piattaforma.

Sono accettati soltanto importi decimali rappresentabili esattamente in centesimi e nel dominio `integer` PostgreSQL, quantità nello stesso dominio, testi privi di byte NUL, sconti non superiori al lordo della riga, codici Paese di Italia o Stati UE, valuta EUR e timestamp con offset rappresentabili come `timestamptz`. Un input invalido, un ordine ripetuto nello stesso batch, un Paese fuori perimetro o una valuta diversa interrompono atomicamente l’intero batch. Campi anagrafici mancanti restano invece rappresentabili: l’ordine viene conservato e la preparazione richiede verifica.

## Idempotenza e raggruppamento

- L’identità dell’ordine è `provider + account + external_order_id`.
- L’identità cliente privilegia l’identificativo previsto dal tipo destinatario; Codice Fiscale e P.IVA italiani hanno una chiave canonica indipendente dal Paese opzionale, mentre un identificativo estero conserva e richiede il Paese dichiarato o dell’indirizzo.
- Il fallback anagrafico esatto include nome, e-mail e indirizzo completo, compresi seconda riga e provincia: due recapiti distinti non condividono la stessa identità.
- L’e-mail da sola non unisce clienti. Un’identità insufficiente resta specifica dell’ordine e richiede verifica.
- Gli ordini idonei confluiscono nel raggruppamento interno aperto dello stesso cliente, data ordine `Europe/Rome` e valuta; un advisory lock e un indice univoco parziale rendono atomica la scelta.
- Un raggruppamento già creato non viene ricreato, sciolto o riaperto quando cambia il trigger globale. Il cambio rivaluta soltanto ordini ancora privi di raggruppamento; un ordine diventato idoneo confluisce nel raggruppamento aperto del proprio cliente e giorno e vi porta le proprie anomalie, che restano visibili come tali.
- Un singolo ordine non annullato può essere preparato manualmente prima del trigger; l’operazione è idempotente e registrata nell’audit.
- Un ordine già rimborsato prima della preparazione resta escluso dalla fatturazione anche se è evaso o viene richiesto manualmente.
- Una preparazione con almeno un pagamento pendente resta `NEEDS_REVIEW` e mostra lo stato del pagamento.
- Una risincronizzazione aggiorna gli snapshot sorgente ma non sposta un ordine già raggruppato.
- Una risincronizzazione riconcilia solo i pagamenti sorgente e conserva quelli registrati manualmente.
- Ordini e preparazioni leggono la propria anagrafica immutabile; aggiornare il cliente normalizzato non modifica retroattivamente dati già raggruppati.
- Un aggiornamento con `updated_at_source` meno recente di quello persistito viene confrontato alla precisione di PostgreSQL, ignorato prima di qualsiasi mutazione e conteggiato nel risultato dell’import.
- Se cambiano dati rilevanti per la preparazione — identità e anagrafica cliente, numero visibile dell’ordine, totale, spedizione, righe, pagamenti, stato o annullamento — il raggruppamento esistente passa a `NEEDS_REVIEW`; i timestamp funzionali vengono confrontati in UTC senza perdere le frazioni di secondo, mentre soli timestamp tecnici e campi di provenienza non generano falsi allarmi.
- Ogni conflitto conserva in modo immutabile snapshot normalizzato precedente e corrente. Un annullamento o rimborso prima dell’emissione porta invece la preparazione a `DO_NOT_TRANSMIT` con motivazione e audit.
- Quando un ordine annullato o rimborsato viene rimosso da una preparazione, ogni ordine residuo conserva soltanto il proprio requisito di verifica: lo stato `NEEDS_REVIEW` del vecchio raggruppamento non si propaga ai fratelli sani.
- Le preparazioni `DO_NOT_TRANSMIT` restano consultabili nell’archivio anche quando una successiva rettifica sposta tutti gli ordini in una nuova preparazione. La riattivazione è proposta soltanto quando contengono ordini compatibili e non esiste già un altro raggruppamento aperto per lo stesso cliente, giorno e valuta; eventuali anagrafiche discordanti mantengono la preparazione in `NEEDS_REVIEW`.

## Stato della preparazione e correzioni

Lo stato di una preparazione modificabile è sempre derivato, mai accumulato: una sola espressione decide fra `READY` e `NEEDS_REVIEW` a partire dallo snapshot anagrafico della preparazione e dalle anomalie degli ordini collegati. Import, correzione, separazione, aggiunta e riattivazione riusano quella stessa espressione, quindi una verifica risolta libera davvero la preparazione.

Le anomalie sono distinte per origine: quelle dell’ordine — pagamento non acquisito, totale non riconciliato, conflitto sorgente, ordine annullato o rimborsato — non sono correggibili dalla preparazione; quella anagrafica vive nello snapshot della preparazione ed è correggibile. La preparazione le espone singolarmente, ciascuna con l’azione che la chiude.

L’anagrafica del destinatario è correggibile finché la preparazione è modificabile. La correzione scrive soltanto lo snapshot della preparazione: gli ordini conservano il valore importato e restano confrontabili. Da quel momento lo snapshot corretto è la fonte del destinatario e la discordanza con gli ordini non è più un’anomalia. La correzione riscrive l’insieme completo degli identificativi fiscali dichiarati, quindi il modulo di modifica li presenta tutti; l’audit conserva valore precedente, valore nuovo, autore, motivo e timestamp.

Un ordine può essere separato dalla preparazione finché ne resta almeno un altro: torna idoneo e senza raggruppamento, disponibile per l’aggiunta a una preparazione compatibile o per la preparazione anticipata. L’indice univoco parziale vieta due raggruppamenti aperti per la stessa chiave, quindi la separazione non crea una seconda preparazione dello stesso giorno. Per chiudere una preparazione con un solo ordine si usa `Non trasmettere`.

Ogni mutazione della preparazione dichiara la revisione letta e la incrementa: due schede che partono dalla stessa versione non si sovrascrivono, la seconda riceve conflitto e rilegge.

## Audit e concorrenza

Importazione, creazione del raggruppamento, assegnazione ordine e cambio trigger producono eventi allowlisted. Gli eventi critici condividono la transazione della mutazione attestata. Le revisioni delle impostazioni sono ottimistiche; una scrittura stale restituisce conflitto e richiede rilettura.

Importazioni e cambio trigger si sincronizzano sulla stessa chiave advisory: le importazioni mantengono un lock condiviso mentre leggono e applicano il trigger, mentre la modifica usa il lock esclusivo e rivaluta gli ordini non raggruppati.

I dettagli di ordine e preparazione vengono letti con una singola istruzione SQL, così testata, righe, pagamenti, audit e revisioni appartengono allo stesso snapshot PostgreSQL anche durante aggiornamenti concorrenti.
