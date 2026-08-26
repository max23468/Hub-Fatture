---
status: accepted
---

# API Aruba come canale primario del ciclo attivo

Hub Fatture adotterà le API Aruba documentate come destinazione architetturale per inventario,
file ufficiali, stati, caricamento e trasmissione. L'adozione avverrà per tranche indipendenti e
fail-closed — lettura, file e stati, upload senza invio, invio — ciascuna promossa soltanto dopo
qualifica tecnica, contrattuale ed economica; questa decisione non autorizza operazioni fiscali
reali.

L'accordo forfettario per circa 500 fatture per mese solare comprende l'uso API pianificato ed è
approvato. Tier e contatori del Premium delegato non appartengono al prodotto; la qualifica verifica
soltanto limiti tecnici, risposta `429` e condizioni necessarie all'integrazione. Prima di quel gate
il canale corrente resta operativo; dopo la promozione, l'indisponibilità delle API conduce al
fallback manuale approvato e non mantiene due integrazioni automatiche permanenti.

## Conseguenze

Il dominio provider-first, l'approvazione esplicita, i batch immutabili, i due arresti e la
gestione dello stato incerto restano invarianti. Preferito e helper sono componenti transitori:
ogni percorso browser viene ritirato separatamente solo dopo parità misurabile della capacità API
corrispondente e prova del fallback approvato.

La parità tecnica o un periodo di shadow non rimuovono automaticamente alcun componente. Per
inbound e outbound Codex presenta separatamente evidenze, divergenze e rischi residui; il ritiro
di preferito, helper, UI e infrastruttura collegata richiede una decisione esplicita del
proprietario riferita alla capacità esatta.
