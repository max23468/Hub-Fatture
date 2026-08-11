# Incidenti Production

## Classificazione

- **P0:** invio fiscale non autorizzato o duplicato, dati persi/corrotti, segreto esposto o esito Aruba non determinabile.
- **P1:** import, sincronizzazione o approvazione indisponibile con dati integri e workaround sicuro.
- **P2:** degradazione non bloccante.

## Procedura P0

1. Verificare e mantenere `ARUBA_SUBMISSION_ENABLED=false`; non alterare documenti già registrati.
2. Preservare database, file, log sanitizzati, hash, ricevute e identificativi remoti.
3. Identificare commit, digest, schema, ultimo backup e ultimo deploy.
4. In stato incerto, rileggere Aruba prima di qualunque retry; credenziali, OTP e sessione restano nel browser umano.
5. Riprodurre soltanto in Development con fixture anonimizzate.
6. Correggere la causa condivisa e aggiungere il più piccolo test che prima falliva.
7. Ottenere autorizzazione prima di rollback/deploy Production, restore o correzioni fiscali.
8. Chiudere con smoke, readback e postmortem breve.

Il monitor locale controlla container, disco e ricevuta backup; OCI Monitoring copre istanza, CPU, memoria e load; il monitor HTTP esterno copre DNS, TLS, Caddy e `/health`. Una notifica non autorizza automaticamente alcuna mutazione.
