# Evidenza integrazione Aruba locale

## Capacità verificabili localmente

- pagina Aruba sintetica con upload ordinario senza challenge, autenticazione e challenge di sicurezza post-upload inattesa in pausa, validazione valida/non valida, DOM inatteso ed esito incerto;
- helper TypeScript unico per Chrome o Edge su macOS e Windows, con allowlist stretta;
- manifest immutabile, codice di avvio breve e permesso monouso distinto e atomico;
- arresto assistito prima di `Invia` e kill switch che forza i nuovi batch Production all’assistito;
- blocco dopo stato incerto, sessione successiva in solo readback e nuovo tentativo soltanto dopo rimozione riconciliata;
- esito automatico accettato soltanto con identità, stato e identificativo remoto osservati;
- export XML, import helper/manuale, consultazione e download verificato di XML, P7M, PDF e notifiche SdI;
- fixture sanificate in `tests/fixtures/aruba`, migrazione, batch misto, audit atomico, permessi scaduti/riusati/mismatched, eventi fuori ordine, parser ostile e scenari browser sintetici.

## Gate reale prima del Canary Production

L’implementazione locale è completata. Prima del Canary Production resta obbligatoria la qualifica del contratto candidato: una sessione separatamente autorizzata prova nel pannello Aruba reale il caricamento del solo XML anonimizzato approvato, la lettura di validazione e riepilogo, l’arresto prima di **Invia**, la rimozione dell’upload pendente e il readback conclusivo. La sessione deve aggiornare contratto, helper e test se il DOM osservato diverge.

La pubblicazione tecnica della repository e il completamento locale non sostituiscono questo gate, non autorizzano accesso Aruba, upload reale, creazione di bozze o invio e non consentono l’avvio del Canary Production.
