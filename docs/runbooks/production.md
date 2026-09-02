# Produzione OCI

## Confine

La Production canonica è la VPS OCI `fatture-hub-vm` in `eu-milan-1`, raggiunta soltanto tramite `fatture.opik.net`. Sul push runtime a `main`, `Production artifact` costruisce una sola immagine ARM64, blocca vulnerabilità alte o critiche note, pubblica e attesta il digest senza accedere alla VPS. Dentro un ciclo `Pubblica` già autorizzato, `scripts/dispatch-production.sh <sha>` avvia subito il workflow `Production` appena è noto lo SHA del merge; non attende localmente i check post-merge perché la barriera exact-SHA del workflow li attende in parallelo all'artefatto. Il workflow accetta esclusivamente un commit già contenuto in `main`, confronta il candidato con l'ultimo deployment riuscito e riusa l'artefatto; costruisce un fallback soltanto se il digest verificato non è disponibile. Classificazione, gate, immagine e release non dichiarano l’Environment e non vedono i relativi segreti; il solo job di backup o deploy usa l’Environment senza reviewer obbligatori, rilegge la ricevuta VPS autorevole, riconcilia una baseline GitHub eventualmente arretrata e procede senza ulteriori conferme. Un merge fuori da un ciclo autorizzato non avvia alcun deploy.

Caddy è il proxy pubblico condiviso dell’host. Oltre al virtual host Hub Fatture, importa i file regolari `*.caddy` `root:root:0644` dalla directory root-owned `/opt/shared-caddy/sites` `0755`, montata in sola lettura, e si collega alla rete Docker esterna `sequent-proxy`. I container applicativi Hub restano esclusi da quella rete. Il deploy fallisce prima di sostituire i container se directory, almeno un virtual host, proprietà, permessi o rete esterna non coincidono, così una rigenerazione di Compose e Caddyfile non può eliminare silenziosamente i virtual host degli altri servizi autorizzati.

La VPS non compila codice. Web e worker consumano lo stesso digest; PostgreSQL non pubblica porte; Caddy è l’unico ingresso. `ARUBA_SUBMISSION_ENABLED` assume `false` in assenza di un valore esplicito. Ogni deploy ordinario rileva il valore live esplicito, lo conserva invariato e lo rilegge prima e dopo il riavvio; un valore assente, duplicato, non valido o cambiato durante il ciclo blocca il deploy. Soltanto una vera transizione da `false` a `true` usa la corsia separata descritta sotto.

Deploy Hub Fatture e build/manutenzioni Docker Sequent condividono un lock host dedicato. Dopo un readback riuscito, la corsia Production elimina soltanto le immagini Hub Fatture che non corrispondono né al digest live né al rollback e che non sono usate da alcun container. La selezione usa il label OCI del repository, non tag generici o una pulizia Docker globale; un’identità protetta assente interrompe l’operazione.

Per un candidato precedente al Canary tecnico Production, dopo il normale readback eseguire anche `scripts/production-release-candidate-readback.sh`: il controllo fallisce se trova documenti Hub approvati privi di una prova terminale di qualifica, import iniziali non completati, ordini storici non riconciliati o batch Aruba aperti. Una catena Production `DOCUMENT_ONLY` conclusa correttamente con `dryRun=true` viene conteggiata separatamente come qualifica completata e non viene trasformata in invio, riconciliazione o cancellazione.

## Accesso SSH dal Mac

Usare `scripts/ssh-production.sh [comando remoto]`. Il comando avvia un `ssh-agent` effimero,
decifra in streaming il blob `age` con l'identità del recovery kit locale e offre soltanto quella
identità tramite `IdentitiesOnly=yes`; alla chiusura elimina agent e file pubblico temporaneo. Non
crea copie plaintext della chiave privata e non dipende dalle identità predefinite di `~/.ssh`.

Per impostazione predefinita il recovery kit è in `~/Documents/Hub-Fatture-Recovery`; percorsi e
target possono essere sostituiti per un recovery controllato con `HUB_FATTURE_RECOVERY_DIR`,
`HUB_FATTURE_AGE_IDENTITY`, `HUB_FATTURE_SSH_KEY_AGE`, `HUB_FATTURE_SSH_HOST` e
`HUB_FATTURE_SSH_USER`, senza salvare valori sensibili nel repository.

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

Avviare `scripts/dispatch-production.sh <sha>` indicando lo SHA completo di `main`; usare il secondo argomento `false` soltanto quando una policy distinta vieta esplicitamente la release. Per la versione `1.0.0` il secondo argomento `true|false` è sempre obbligatorio: `true` rappresenta l’autorizzazione distinta al go-live, mentre l’assenza del flag fallisce chiusa. Il workflow verifica attestazione e target, prepara Compose, Caddyfile e bundle operativo come candidati, esegue il pull per digest e attende gli health check. Gli script e le unità `systemd` candidate vengono installati soltanto dopo il readback riuscito, così un rollback continua a usare il bundle operativo precedente. Backup e deploy condividono lo stesso lock per l’intera fase critica. Il deploy acquisisce sotto lo stesso lock la modalità invii già attiva e la passa esplicitamente a preflight, readback del candidato e readback dell’eventuale rollback, senza modificarla. Per codice ordinario viene riletta una ricevuta giornaliera riuscita e recente; migrazioni o modifiche allo storage producono un backup aggiuntivo prima del deploy e uno dopo il readback. La ricevuta remota contiene commit, versione, digest, ultima migrazione, stato del kill switch e timestamp; non contiene IP, credenziali o dati cliente. Se il candidato coincide già con la ricevuta live, il workflow riconcilia GitHub ma non ridistribuisce né sovrascrive il vero rollback. Un target senza ricevuta segue invece il percorso di bootstrap e registra esplicitamente l'assenza di un predecessore nel manifest. Dopo il readback il workflow registra un deployment tecnico separato, marcato con lo SHA realmente installato: questo record, non lo SHA del workflow dispatch, diventa la base del diff successivo. Prima di sostituire un deploy esistente, lo script conserva in `data/operations/` il precedente environment di deploy senza segreti insieme ai relativi Compose e Caddyfile.

Controlli conclusivi:

- `GET /health` restituisce solo `{"status":"ok"}`;
- login con varianti maiuscole/minuscole e nome canonico in menu/audit;
- sezione **Sistema** coerente con ricevuta, schema e backup;
- app e worker sullo stesso digest;
- nessun container privilegiato, database non pubblicato e filesystem applicativo read-only;
- connessioni non configurate restano fail-closed e nessun provider viene chiamato durante lo smoke.

L’inbound Aruba non richiede operazioni di cutover o ricostruzione della parità: le API sono
l’autorità automatica esclusiva. Il readback operativo usa stato connessione, ultimo giro canonico,
checkpoint, freschezza inventario e conflitti correnti. Il fallback manuale è descritto nel runbook
dedicato e non modifica l’autorità automatica.

## Release tecnica

Dopo il readback Production riuscito, il job `GitHub Release immutabile` estrae
le note della versione corrente dal changelog, costruisce il manifest con
commit, digest distribuito, digest di rollback, schema e attestazione, quindi
usa `scripts/publish-github-release.sh`. Lo script crea la release Latest e
rilegge tag, asset unico e immutabilità; una ripetizione è un no-op soltanto se
release e manifest esistenti coincidono byte per byte. Rollback, backup-only e
deploy senza modifica runtime non pubblicano release.

## Attivazione degli invii Aruba

L’abilitazione dell’uso Production ordinario è distinta dal deploy e dalla release. Prima si
distribuisce il candidato con `ARUBA_SUBMISSION_ENABLED=false` e si pubblica la release immutabile
`v1.0.0` sullo stesso commit. Soltanto dopo l’autorizzazione separata del titolare si esegue:

```sh
scripts/dispatch-production-submission.sh <sha-live> enable
```

Il dispatch rifiuta l’abilitazione se la release stabile corrispondente alla versione live non è
pubblicata, immutabile o riferita allo SHA esatto. La corsia Production rilegge commit, digest e versione dalla ricevuta live, richiede zero
batch e job outbound aperti, modifica atomicamente il solo valore del kill switch, ricrea web e
worker e conserva una ricevuta sanitizzata. Un errore ripristina `false` e ripete il readback.

La corsia non crea, seleziona, approva o trasmette documenti. Il primo invio nasce dal normale
flusso applicativo su un documento già dovuto e approvato dal titolare. In caso di arresto o
incidente, la stessa corsia resta utilizzabile senza dipendere dalla release:

```sh
scripts/dispatch-production-submission.sh <sha-live> disable
```

I deploy successivi preservano la modalità già autorizzata: mantenere `true` non costituisce una
nuova attivazione, mentre un passaggio effettivo da `false` a `true` continua a richiedere questa
corsia e l’autorizzazione separata del titolare.

## Chiusura locale

Dopo il merge e dopo gli eventuali readback Production e release, eseguire dal
checkout pulito di `main`:

```sh
node scripts/publish-close.mjs <branch-temporaneo> <percorso-worktree-assoluto>
```

Il comando rilegge `origin/main` e la PR unita, richiede che l'HEAD locale del
branch coincida con quello della PR e che il merge appartenga alla linea corrente
di `main`. Soltanto dopo questi controlli allinea `main`, elimina il branch remoto
se ancora presente, rimuove il worktree pulito e il branch locale indicati, quindi
verifica l'assenza dei tre residui. Worktree, branch e stash estranei vengono
preservati e stampati: il riepilogo finale li dichiara esplicitamente. Un errore o
un inventario non riportato impediscono di definire conclusa la pubblicazione.

Se il ciclo non ha creato un branch e un worktree temporanei, non forzare il
comando con target estranei: rileggere manualmente `main`, `origin/main`,
`git status`, `git worktree list`, branch locali/remoti e `git stash list`, quindi
dichiarare che la rimozione non era applicabile e riportare i residui preservati.

## Rollback

Il rollback è applicativo: un workflow manuale può scegliere un commit precedente già contenuto in `main`; soltanto se lo schema è rimasto invariato, il deploy ripristina insieme applicazione, Compose e Caddyfile e ripete il readback. Se la modalità e-mail globale è `DISABLED`, il workflow rifiuta anche un candidato precedente che non la supporta, perché il vecchio worker potrebbe altrimenti accodare o inviare nuove copie. Lo script applica inoltre lo stesso ripristino automatico del bundle precedente quando fallisce il deploy in corso. Se lo schema è avanzato, non è rilevabile o la modalità disattivata non è supportata dal target, il rollback è vietato e il candidato resta fermo sul percorso di forward-fix. La chiusura operativa ripete anche login, worker e kill switch. Non esistono down migration automatiche; un restore Production richiede autorizzazione separata.

## Provisioning e hardening

`ops/provision-production.sh` è idempotente per i componenti di base: Docker/Compose, `age`, OCI CLI fissata, utente applicativo, directory con permessi stretti, aggiornamenti di sicurezza, SSH senza password/root e firewall limitato a SSH/HTTP/HTTPS. Prima di applicarlo, l’accesso console OCI resta il rollback dell’hardening SSH.
