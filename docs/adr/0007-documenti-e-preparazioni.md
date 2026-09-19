---
status: accepted
---

# Documenti per consultare, preparazione per lavorare

`Documenti` è sola consultazione: ogni documento ha una propria pagina con contenuto emesso,
trasmissione, file, e-mail e collegamenti. Ogni decisione che porta a emettere o trasmettere,
comprese revisione e approvazione di una nota di credito, avviene nella preparazione fattura.
La preparazione resta un luogo di lavoro solo finché è aperta; chiusa con una fattura emessa, il
suo indirizzo porta al documento.

## Considered Options

- Approvare la nota di credito dalla sua pagina in `Documenti`: scartato, perché reintroduce in
  `Documenti` un'azione che autorizza una trasmissione e divide il lavoro fra due destinazioni.
- Lasciare le preparazioni chiuse consultabili come archivio: scartato, perché duplica il
  documento con una vista della bozza meno completa e porta l'utente in `Ordini` per consultare
  una fattura.

## Consequences

Aperta o chiusa è una proprietà derivata, non un nuovo stato persistito: una preparazione resta
aperta negli stati modificabili, con una trasmissione API in attesa di conferma o con una nota di
credito in bozza. Un rimborso successivo all'emissione riapre quindi la preparazione della
fattura. Una preparazione chiusa senza fattura, per esempio con `Non trasmettere`, resta
consultabile per motivo e riattivazione.
