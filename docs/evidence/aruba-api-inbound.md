# Inbound API Aruba

## Esito inbound API

La milestone inbound API primaria è completata. Il perimetro Production parte in modo permanente
dal 1° luglio 2026 e prosegue con sincronizzazioni incrementali ogni 15 minuti, overlap di sette
giorni, rilettura mirata dei non terminali e scansione completa mensile sullo stesso orizzonte.

Il passaggio di autorità è stato eseguito in modo atomico dopo il dossier di parità. Le API Aruba
sono l’unica fonte automatica; preferito, bridge, helper, sessioni browser, token e relative rotte e
UI sono stati rimossi. Il fallback manuale sui file ufficiali resta disponibile. Gli invii Aruba
sono rimasti disabilitati durante tutte le prove.

## Evidenza Production sanitizzata

Readback del 30 agosto 2026:

- release `v0.4.6`, commit `43a2c0f66d4bf3f9910d1f5f4928c45302068a99`, schema
  `043_remove_aruba_browser_runtime.sql`;
- autorità automatica `API` e `ARUBA_SUBMISSION_ENABLED=false`;
- scansione completa dal floor: 372 documenti, 389 gruppi, 52 pagine, 1.116 file, 372 notifiche e
  834 richieste; checkpoint e ripresa verificati;
- dossier finale `MATCHED`: 345 documenti API contro 345 nella baseline comune, con zero assenti,
  divergenze di stato, divergenze di file o conflitti browser;
- rilettura mirata completata su 102 gruppi su 102, con 206 file, 51 notifiche e nessun errore
  residuo del giro;
- prova incrementale esplicita completata su 38 gruppi; il primo incrementale automatico dopo il
  deploy ha completato nuovamente 38 gruppi senza errori;
- UI live: fonte `API Aruba`, backfill completo, ultima lettura incrementale completata e nessun
  confronto API-pannello residuo.

La salute operativa distingue i documenti esterni dalle decisioni fiscali: 40 casi con file
ufficiale e nessun candidato compatibile sono classificati come esterni. Tre documenti hanno due
candidati compatibili ciascuno e restano intenzionalmente fail-closed in `Documenti → Da
collegare`; sono scelte operative del titolare, non divergenze del canale API né errori della
sincronizzazione.

## Recovery e gate

I test database eseguono dump e restore reali su database temporanei e verificano credenziale
cifrata, decifratura con la sola chiave corretta, checkpoint, budget richieste, reclaim delle lease
e ripresa idempotente. La regressione copre inoltre gruppi multi-documento, XML/P7M, file condivisi,
notifiche, numerazione storica nullable, retry breve dell’autenticazione e validazione differita
delle note transitorie.

La pubblicazione ha superato lint, typecheck, build server e applicativa, unit, suite database,
contract test provider, audit dipendenze, React Doctor, Chromium, WebKit, CodeQL, exact-SHA,
attestazione del digest, deploy e readback live. Non sono stati eseguiti upload, dry-run, invii SdI
o e-mail reali.
