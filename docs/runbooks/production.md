# Produzione OCI

## Confine

La Production canonica è la VPS OCI `fatture-hub-vm` in `eu-milan-1`, raggiunta soltanto tramite `fatture.opik.net`. Sul push runtime a `main`, `Production artifact` costruisce una sola immagine ARM64, blocca vulnerabilità alte o critiche note, pubblica e attesta il digest senza accedere alla VPS. Dentro un ciclo `Pubblica` già autorizzato, `scripts/dispatch-production.sh <sha>` avvia subito il workflow `Production` appena è noto lo SHA del merge; non attende localmente i check post-merge perché la barriera exact-SHA del workflow li attende in parallelo all'artefatto. Il workflow accetta esclusivamente un commit già contenuto in `main`, confronta il candidato con l'ultimo deployment riuscito e riusa l'artefatto; costruisce un fallback soltanto se il digest verificato non è disponibile. Classificazione, gate, immagine e release non dichiarano l’Environment e non vedono i relativi segreti; il solo job di backup o deploy usa l’Environment senza reviewer obbligatori, rilegge la ricevuta VPS autorevole, riconcilia una baseline GitHub eventualmente arretrata e procede senza ulteriori conferme. Un merge fuori da un ciclo autorizzato non avvia alcun deploy.

La VPS non compila codice. Web e worker consumano lo stesso digest; PostgreSQL non pubblica porte; Caddy è l’unico ingresso. `ARUBA_SUBMISSION_ENABLED=false` è fissato anche nel Compose e ogni readback deve confermarlo.

Deploy Hub Fatture e build/manutenzioni Docker Sequent condividono un lock host dedicato. Dopo un readback riuscito, la corsia Production elimina soltanto le immagini Hub Fatture che non corrispondono né al digest live né al rollback e che non sono usate da alcun container. La selezione usa il label OCI del repository, non tag generici o una pulizia Docker globale; un’identità protetta assente interrompe l’operazione.

Per un candidato precedente al Canary tecnico Production, dopo il normale readback eseguire anche `scripts/production-release-candidate-readback.sh`: il controllo fallisce se trova documenti approvati, import iniziali non completati, ordini storici non riconciliati o batch Aruba aperti.

## Prima del deploy

1. `npm run publish:preflight` classifica il diff rispetto a `origin/main` ed esegue soltanto i gate locali applicabili; audit, DB e contract test indipendenti procedono in parallelo.
2. DNS Dynu, istanza, regione e hostname verificati da `scripts/production-preflight.sh`.
3. Environment `Production` limitato a `main`, privo di reviewer obbligatori e usato soltanto dal job che necessita dei segreti; il dispatch manuale o la richiesta affermativa di pubblicazione costituisce l’autorizzazione.
4. `.env` VPS con permessi `600`, Notifications Topic OCI obbligatorio e nessun valore nei log o nella repository.
5. Digest di rollback presente in `.deploy.env` per ogni sostituzione di un deployment esistente e ultimo backup verificato quando il deploy modifica schema o storage; il bootstrap di un target privo di ricevuta non inventa un rollback inesistente.

Il workflow verifica direttamente i check `CI`, `Foundation`, CodeQL e React
Doctor dell'ultimo commit non distribuito che attiva la rispettiva superficie.
Un successivo commit solo documentale non può quindi mascherare con check no-op
un errore sul runtime ancora da distribuire; un fix successivo della stessa
superficie sostituisce invece il gate precedente. Una modifica solo documentale,
di test o governance che non introduce differenze runtime dal commit già
distribuito termina senza avviare il job Production. Se più PR runtime
sono state assorbite in `main`, si distribuisce una sola volta il candidato
finale.

Un candidato precedente al deployment corrente è trattato esplicitamente come
rollback deliberato: il workflow classifica le superfici rimosse, verifica i
gate storici sul commit target e prova subito a riusare il relativo digest
attestato, senza attendere il workflow artefatto di un nuovo merge. Classificatore
e barriera dei check provengono sempre dalla revisione fidata del workflow, non
dal candidato storico. Prima di creare il deployment exact-SHA o sostituire i
container, il preflight confronta l'ultima migrazione del target con la ricevuta
Production e vieta il rollback se divergono. Se in Production è attiva la
disattivazione globale delle e-mail al cliente, vieta inoltre il ritorno a un
candidato che non riconosce quella modalità. Il deployment riuscito diventa poi
la nuova base.

## Deploy e readback

Avviare `scripts/dispatch-production.sh <sha>` indicando lo SHA completo di `main`; usare il secondo argomento `false` soltanto quando una policy distinta vieta esplicitamente la release. Per la versione `1.0.0` il secondo argomento `true|false` è sempre obbligatorio: `true` rappresenta l’autorizzazione distinta al go-live, mentre l’assenza del flag fallisce chiusa. Il workflow verifica attestazione e target, prepara Compose, Caddyfile e bundle operativo come candidati, esegue il pull per digest e attende gli health check. Gli script e le unità `systemd` candidate vengono installati soltanto dopo il readback riuscito, così un rollback continua a usare il bundle operativo precedente. Backup e deploy condividono lo stesso lock per l’intera fase critica. Per codice ordinario viene riletta una ricevuta giornaliera riuscita e recente; migrazioni o modifiche allo storage producono un backup aggiuntivo prima del deploy e uno dopo il readback. La ricevuta remota contiene commit, versione, digest, ultima migrazione, stato del kill switch e timestamp; non contiene IP, credenziali o dati cliente. Se il candidato coincide già con la ricevuta live, il workflow riconcilia GitHub ma non ridistribuisce né sovrascrive il vero rollback. Un target senza ricevuta segue invece il percorso di bootstrap e registra esplicitamente l'assenza di un predecessore nel manifest. Dopo il readback il workflow registra un deployment tecnico separato, marcato con lo SHA realmente installato: questo record, non lo SHA del workflow dispatch, diventa la base del diff successivo. Prima di sostituire un deploy esistente, lo script conserva in `data/operations/` il precedente environment di deploy senza segreti insieme ai relativi Compose e Caddyfile.

Controlli conclusivi:

- `GET /health` restituisce solo `{"status":"ok"}`;
- login con varianti maiuscole/minuscole e nome canonico in menu/audit;
- sezione **Sistema** coerente con ricevuta, schema e backup;
- app e worker sullo stesso digest;
- nessun container privilegiato, database non pubblicato e filesystem applicativo read-only;
- connessioni non configurate restano fail-closed e nessun provider viene chiamato durante lo smoke.

## Release tecnica

Dopo il readback Production riuscito, il job `GitHub Release immutabile` estrae
le note della versione corrente dal changelog, costruisce il manifest con
commit, digest distribuito, digest di rollback, schema e attestazione, quindi
usa `scripts/publish-github-release.sh`. Lo script crea la release Latest e
rilegge tag, asset unico e immutabilità; una ripetizione è un no-op soltanto se
release e manifest esistenti coincidono byte per byte. Rollback, backup-only e
deploy senza modifica runtime non pubblicano release.

## Rollback

Il rollback è applicativo: un workflow manuale può scegliere un commit precedente già contenuto in `main`; soltanto se lo schema è rimasto invariato, il deploy ripristina insieme applicazione, Compose e Caddyfile e ripete il readback. Se la modalità e-mail globale è `DISABLED`, il workflow rifiuta anche un candidato precedente che non la supporta, perché il vecchio worker potrebbe altrimenti accodare o inviare nuove copie. Lo script applica inoltre lo stesso ripristino automatico del bundle precedente quando fallisce il deploy in corso. Se lo schema è avanzato, non è rilevabile o la modalità disattivata non è supportata dal target, il rollback è vietato e il candidato resta fermo sul percorso di forward-fix. La chiusura operativa ripete anche login, worker e kill switch. Non esistono down migration automatiche; un restore Production richiede autorizzazione separata.

## Provisioning e hardening

`ops/provision-production.sh` è idempotente per i componenti di base: Docker/Compose, `age`, OCI CLI fissata, utente applicativo, directory con permessi stretti, aggiornamenti di sicurezza, SSH senza password/root e firewall limitato a SSH/HTTP/HTTPS. Prima di applicarlo, l’accesso console OCI resta il rollback dell’hardening SSH.
