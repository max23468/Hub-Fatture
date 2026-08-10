# Evidenza integrazione Aruba locale

## Capacità verificabili localmente

- pagina Aruba sintetica con autenticazione in pausa, validazione valida/non valida, DOM inatteso ed esito incerto;
- helper TypeScript unico per Chrome o Edge su macOS e Windows, con allowlist stretta;
- manifest immutabile, codice di avvio breve e permesso monouso distinto e atomico;
- arresto assistito prima di `Invia` e kill switch che forza i nuovi batch Production all’assistito;
- blocco dopo stato incerto, sessione successiva in solo readback e nuovo tentativo soltanto dopo rimozione riconciliata;
- esito automatico accettato soltanto con identità, stato e identificativo remoto osservati;
- export XML, import helper/manuale, consultazione e download verificato di XML, P7M, PDF e notifiche SdI;
- fixture sanificate in `tests/fixtures/aruba`, migrazione, batch misto, audit atomico, permessi scaduti/riusati/mismatched, eventi fuori ordine, parser ostile e scenari browser sintetici.

## Gate ancora aperto

L’integrazione non è completata finché una sessione separatamente autorizzata non prova il contratto candidato nel pannello Aruba reale: caricamento del solo XML anonimizzato approvato, lettura di validazione e riepilogo, arresto prima di **Invia**, rimozione dell’upload pendente e readback conclusivo. La sessione deve aggiornare contratto e test se il DOM osservato diverge.

La pubblicazione tecnica della repository non sostituisce questo gate e non autorizza accesso Aruba, upload reale, creazione di bozze o invio.
