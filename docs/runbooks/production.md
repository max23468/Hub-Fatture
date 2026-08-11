# Produzione OCI

## Confine

La Production canonica è la VPS OCI `fatture-hub-vm` in `eu-milan-1`, raggiunta soltanto tramite `fatture.opik.net`. Il workflow manuale `Production` accetta esclusivamente un commit già contenuto in `main`, costruisce una sola immagine ARM64, blocca vulnerabilità alte o critiche note, pubblica e attesta il digest, quindi attende l’approvazione dell’Environment prima di accedere ai segreti SSH.

La VPS non compila codice. Web e worker consumano lo stesso digest; PostgreSQL non pubblica porte; Caddy è l’unico ingresso. `ARUBA_SUBMISSION_ENABLED=false` è fissato anche nel Compose e ogni readback deve confermarlo.

## Prima del deploy

1. Gate locali e CI verdi sul commit esatto.
2. DNS Dynu, istanza, regione e hostname verificati da `scripts/production-preflight.sh`.
3. Environment `Production` limitato a `main` e protetto dal solo titolare.
4. `.env` VPS con permessi `600`, senza valori nei log o nella repository.
5. Digest di rollback presente in `.deploy.env` e ultimo backup verificato quando il deploy modifica schema o storage.

## Deploy e readback

Avviare manualmente il workflow indicando lo SHA completo di `main`. Il workflow verifica attestazione e target, prepara Compose e Caddyfile come candidati, installa gli script versionati, esegue il pull per digest e attende gli health check. La ricevuta remota contiene commit, versione, digest, ultima migrazione, stato del kill switch e timestamp; non contiene IP, credenziali o dati cliente. Prima di sostituire un deploy esistente, lo script conserva in `data/operations/` il precedente environment di deploy senza segreti insieme ai relativi Compose e Caddyfile.

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
