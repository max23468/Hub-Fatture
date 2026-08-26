---
status: accepted
---

# Permesso monouso per il canary API Aruba

M13 includerà un solo invio API reale, autorizzato da Massimo mediante un permesso breve e
monouso vincolato a ambiente, batch, documento, revisione e hash XML esatti. Il worker consuma
il permesso atomicamente immediatamente prima della prima mutazione Aruba; il kill switch
ordinario delle trasmissioni resta disabilitato e nessun altro documento può riusare
l'autorizzazione.

Il canary M13 copre una TD01 reale. La TD04 viene qualificata con fixture e `dryRun=true`, ma il
suo invio API resta disabilitato e usa il fallback manuale finché un rimborso reale idoneo non
consente un secondo canary monouso separatamente autorizzato.

## Conseguenze

Creazione del permesso, invio fiscale reale e successivo readback richiedono l'autorizzazione
specifica del proprietario al momento dell'esecuzione. Esito incerto, mismatch, scadenza o
consumo parziale bloccano qualunque retry finché Aruba non viene riconciliata; al termine M13 non
deve restare alcun permesso valido né una modalità ordinaria di invio attiva.
