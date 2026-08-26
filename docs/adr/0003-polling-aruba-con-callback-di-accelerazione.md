---
status: accepted
---

# Polling Aruba con callback di accelerazione

L'inventario e gli stati Aruba usano polling server-side incrementale ogni 15 minuti, rilettura
mirata dei non terminali e scansione completa mensile, affiancati dall'azione manuale
`Sincronizza ora`. Le callback
Aruba possono accelerare gli aggiornamenti soltanto dopo qualifica di autenticazione, replay,
ordine degli eventi e retry; non sostituiscono il polling e non attestano da sole la completezza
dell'inventario.

Le callback sono opzionali e non bloccano alcuna milestone. Possono essere attivate soltanto se
il Premium garantisce per iscritto che endpoint ed eventi sono confinati alla singola utenza
fiscale di Hub Fatture e al solo perimetro autorizzato: un endpoint condiviso che possa recapitare
dati di altri clienti dell'agenzia è incompatibile con il prodotto single-tenant.

Finché queste conferme non esistono, non vengono creati endpoint, segreti, tabelle o test callback
disabilitati. Il polling copre integralmente la roadmap corrente; un futuro receiver nasce in una
tranche autonoma con security review e contratto provider verificato.

## Conseguenze

Il worker conserva cursori, overlap, lease esclusivo e riconciliazione periodica completa. Una
callback viene acquisita come osservazione append-only, poi normalizzata dalla stessa macchina a
stati usata dal polling; eventi mancanti, duplicati, fuori ordine o non verificabili conducono al
recupero via API e mai a un retry fiscale cieco. Frequenze e budget di chiamata restano un gate
economico da fissare sui limiti osservati.
