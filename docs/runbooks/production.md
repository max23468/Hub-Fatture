# Produzione OCI

## Confine

La Production canonica è la VPS OCI `fatture-hub-vm` in `eu-milan-1`, raggiunta soltanto tramite `fatture.opik.net`. Sul push runtime a `main`, `Production artifact` costruisce una sola immagine ARM64, blocca vulnerabilità alte o critiche note, pubblica e attesta il digest senza accedere alla VPS. Il workflow manuale `Production` accetta esclusivamente un commit già contenuto in `main`, confronta il candidato con l'ultimo deployment riuscito, attende i gate exact-SHA e riusa l'artefatto; costruisce un fallback soltanto se il digest verificato non è disponibile, quindi attende l’approvazione dell’Environment prima di accedere ai segreti SSH.

La VPS non compila codice. Web e worker consumano lo stesso digest; PostgreSQL non pubblica porte; Caddy è l’unico ingresso. `ARUBA_SUBMISSION_ENABLED=false` è fissato anche nel Compose e ogni readback deve confermarlo.

Per un candidato precedente al Canary Production, dopo il normale readback eseguire anche `scripts/production-release-candidate-readback.sh`: il controllo fallisce se trova documenti approvati, import iniziali non completati, ordini storici non riconciliati, batch Aruba aperti o permessi non consumati ancora validi.

## Prima del deploy

1. Gate locali e CI verdi sul commit esatto.
2. DNS Dynu, istanza, regione e hostname verificati da `scripts/production-preflight.sh`.
3. Environment `Production` limitato a `main` e protetto dal solo titolare.
4. `.env` VPS con permessi `600`, Notifications Topic OCI obbligatorio e nessun valore nei log o nella repository.
5. Digest di rollback presente in `.deploy.env` e ultimo backup verificato quando il deploy modifica schema o storage.

Il workflow verifica direttamente i check `CI`, `Foundation`, CodeQL e React
Doctor del candidato. Una modifica solo documentale, di test o governance che
non introduce differenze runtime dal commit già distribuito termina senza
richiedere approvazione Production. Se più PR runtime sono state assorbite in
`main`, si distribuisce una sola volta il candidato finale.

## Deploy e readback

Avviare manualmente il workflow indicando lo SHA completo di `main`. Il workflow verifica attestazione e target, prepara Compose, Caddyfile e bundle operativo come candidati, esegue il pull per digest e attende gli health check. Gli script e le unità `systemd` candidate vengono installati soltanto dopo il readback riuscito, così un rollback continua a usare il bundle operativo precedente. Backup e deploy condividono lo stesso lock per l’intera fase critica. Per codice ordinario viene riletta una ricevuta giornaliera riuscita e recente; migrazioni o modifiche allo storage producono un backup aggiuntivo prima del deploy e uno dopo il readback. La ricevuta remota contiene commit, versione, digest, ultima migrazione, stato del kill switch e timestamp; non contiene IP, credenziali o dati cliente. Prima di sostituire un deploy esistente, lo script conserva in `data/operations/` il precedente environment di deploy senza segreti insieme ai relativi Compose e Caddyfile.

Controlli conclusivi:

- `GET /health` restituisce solo `{"status":"ok"}`;
- login con varianti maiuscole/minuscole e nome canonico in menu/audit;
- sezione **Sistema** coerente con ricevuta, schema e backup;
- app e worker sullo stesso digest;
- nessun container privilegiato, database non pubblicato e filesystem applicativo read-only;
- connessioni non configurate restano fail-closed e nessun provider viene chiamato durante lo smoke.

## Rollback

Il rollback è applicativo: soltanto se lo schema è rimasto invariato, il deploy ripristina insieme `.deploy.env`, Compose e Caddyfile precedenti, ricrea i container e ripete il readback. Se lo schema è avanzato o non è rilevabile, il rollback automatico è vietato e il candidato resta fermo sul percorso di forward-fix. La chiusura operativa ripete anche login, worker e kill switch. Non esistono down migration automatiche; un restore Production richiede autorizzazione separata.

## Provisioning e hardening

`ops/provision-production.sh` è idempotente per i componenti di base: Docker/Compose, `age`, OCI CLI fissata, utente applicativo, directory con permessi stretti, aggiornamenti di sicurezza, SSH senza password/root e firewall limitato a SSH/HTTP/HTTPS. Prima di applicarlo, l’accesso console OCI resta il rollback dell’hardening SSH.
