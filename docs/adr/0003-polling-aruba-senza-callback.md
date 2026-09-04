---
status: accepted
---

# Polling Aruba senza callback

L’inventario e gli stati Aruba usano polling server-side incrementale ogni 15 minuti, rilettura
mirata dei documenti non terminali, scansione completa mensile e l’azione manuale
`Aggiorna stato Aruba`. Le ricerche esplicite e il readback post-invio attraversano la stessa
validazione e riconciliazione canonica.

I callback Aruba sono esclusi dalla soluzione e non costituiscono un’evoluzione prevista. Non
vengono creati receiver, route, segreti, tabelle, code, contratti o feature flag preparatori. Un
cambiamento di questa decisione richiederebbe una nuova decisione di prodotto esplicita, non il
completamento di scaffolding latente.

## Motivazione

Il polling copre integralmente il monitoraggio richiesto, mantiene una sola autorità verificabile e
consente di applicare gli stessi limiti, checkpoint, deduplicazione e transizioni monotone a ogni
osservazione. Evitare un secondo canale elimina il rischio di eventi mancanti, duplicati, fuori
ordine o riferiti ad altre utenze delegate e riduce superficie esposta, segreti e recovery da
presidiare.

## Conseguenze

Il worker conserva cursori, overlap, lease esclusivo, cooldown persistente e riconciliazione
periodica completa. Dopo un invio accettato da Aruba, il readback mirato parte subito e prosegue ogni
15 minuti fino a uno stato terminale o a un controllo azionabile. Un errore o uno stato remoto
incerto non produce mai un retry fiscale cieco. Frequenze e budget delle chiamate restano vincolati
ai limiti provider qualificati.
