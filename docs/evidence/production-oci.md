# Evidenza Production OCI

## Capacità locali verificate

- account applicativi canonici `Massimo` e `Codex`, login case-insensitive, bootstrap atomico e vincoli database append-only;
- `can_approve=true` consentito soltanto a `Massimo`, con blocco server-side delle transizioni fiscali per `Codex`;
- immagine ARM64 unica per web e worker, runtime non-root con `xmllint` e senza TypeScript o tool di build;
- Compose Production con database interno, filesystem applicativo read-only, capability eliminate e kill switch Aruba fissato a `false`;
- Caddy con TLS automatico, header essenziali, limite body e log ruotati senza richieste contenenti query string;
- workflow manuale serializzato con candidato già in `main`, scansione, attestazione, gate `Production`, deploy per digest e readback;
- script versionati per preflight, deploy, ricevuta, backup cifrato, monitor e restore esplicito.

## Baseline infrastrutturale verificata

- istanza OCI ARM64, VNIC e hostname Ubuntu canonici `fatture-hub-vm`, con kernel e pacchetti correnti, aggiornamenti automatici, accesso SSH ristretto, `rpcbind` disabilitato e firewall su SSH/HTTP/HTTPS;
- `fatture.opik.net` risolto sull’IPv4 stabile della VPS, senza wildcard o IPv6, e preflight negativo che rifiuta un hostname diverso;
- plugin Compute Instance Monitoring attivo, topic `hub-fatture-operations` e sottoscrizione e-mail attiva, con pubblicazione e consegna verificate tramite le metriche native del topic;
- quattro allarmi abilitati per metriche assenti, CPU, memoria e load average;
- dominio APM Always Free `hub-fatture-production` attivo con monitor HTTP `hub-fatture-health` ogni 6 minuti da Milano e allarme dedicato dopo due esecuzioni consecutive senza successo;
- bucket privato `hub-fatture-backups`, lifecycle di 30 giorni limitato a `hub-fatture/archive/` e copia `hub-fatture/current/` esclusa;
- dynamic group `hub-fatture-backup` ristretto alla sola VPS e policy limitata alla creazione e al readback degli oggetti cifrati e alla pubblicazione sul topic; la VPS non può cancellare backup né eseguire comandi OCI;
- Environment GitHub `Production` limitato ai branch protetti, con `max23468` come unico reviewer e segreti SSH scoped.
- log applicativi ruotati dal driver locale Docker, access log Caddy ruotati nativamente e journal di sistema gestito da `systemd`.

## Ricevute remote

Ambiente `Production`, regione `eu-milan-1`, istanza OCI con suffisso `v6almouq`, hostname `fatture-hub-vm`. Nessun valore segreto, IP, dato cliente o output SMTP integrale è registrato.

### Deploy e readback

- workflow manuale [Production 31534190604](https://github.com/max23468/Hub-Fatture/actions/runs/31534190604) concluso con successo dopo approvazione dell’Environment;
- commit `f875b578447cb42f28873f336d8c72f6faeb6db3`, digest ARM64 `sha256:0eb76e32fb64ca923135fd98de3e768c2321692400b7f539f1063ce1ca5e310b`, attestazione verificata prima del pull e stessa immagine riletta su web e worker;
- versione applicativa `0.0.0`, schema `015_canonical_account_names.sql`, `ARUBA_SUBMISSION_ENABLED=false`, ricevuta e health `ok`;
- smoke autenticato finale del `2026-08-11T21:12:42Z`: `mAsSiMo` e `CODEX` accedono rispettivamente come `Massimo` titolare e `Codex` operatore; menu, profilo e audit usano i nomi canonici e solo `Massimo` espone il permesso fiscale;
- readback database: due soli account, `Massimo` con `can_approve=true` e `Codex` con `can_approve=false`; indice univoco case-insensitive e vincolo che rifiuta il privilegio su `Codex` verificati anche nel restore isolato.

### Rollback e ritorno

- backup pre-rollback completato, quindi rollback reale al commit `3eccac2a18f53b5bcd38aa7abd7ab4be39666afa` e digest `sha256:8ed61a4a81480d06e280f89385c8d71d45bcd1f2216ba507a06deb0dba32f77a`;
- readback rollback del `2026-08-11T22:13:34Z`: schema `015_canonical_account_names.sql`, kill switch `false`, health verde, web e worker sul digest precedente e login riuscito per entrambi gli account;
- con zero connessioni è stato inserito un solo job sintetico `shopify_sync_orders` con un unico tentativo: il worker precedente lo ha acquisito e chiuso `FAILED` con `PROVIDER_NOT_CONFIGURED`, senza chiamare provider; coda e connessioni sono rimaste a zero e il job è stato rimosso puntualmente;
- ritorno allo stesso commit e digest correnti verificato alle `2026-08-11T22:13:59Z`, senza down migration e con gli stessi gate di health, schema, worker, coda, connessioni e kill switch.

### Backup e restore drill

- il backup Production `current` pulito, verificato alle `2026-08-11T21:28:53Z`, è stato scaricato e ripristinato sul Mac in un primo PostgreSQL isolato; qui, senza modificare la Production, sono stati creati una fattura sintetica collegata al relativo oggetto storage e una connessione sintetica cifrata tramite il codice applicativo;
- la chiave AEAD Production è stata copiata fuori dalla VPS nel recovery kit protetto, con permessi `600` e corrispondenza verificata tramite digest senza stampare il valore; il database isolato non contiene la credenziale sintetica in chiaro;
- il nuovo archivio cifrato `hub-fatture/archive/2026/08/11/20260811T215518Z-recovery-drill-linked.tar.age`, di `153832` byte e SHA-256 `cadb73a26d6228b5b6493fbbd04512bb54110265e5abf17cec5583595dd0d43e`, è stato caricato nel bucket, riletto per metadati e dimensione, riscaricato e verificato prima della decifratura;
- `scripts/restore.sh` ha ripristinato l’archivio riscaricato in un secondo PostgreSQL e filesystem isolati: 15 migrazioni, 2 account, 18 eventi di audit, 1 documento, 1 oggetto storage e 1 connessione cifrata sono risultati coerenti;
- la stessa immagine Production ha riletto il documento tramite il collegamento database/storage verificandone lo SHA-256 `f2758cfd5a1eca08b355b2da84d427a9bee9e59512012c5585f036c3e19b190f`, ha decifrato la credenziale esclusivamente con la chiave del recovery kit ed è risultata sana; login case-insensitive, nomi canonici e rifiuto database di `can_approve=true` per `Codex` restano verificati;
- target, container, rete, dump e database temporanei sono stati rimossi; la Production è rimasta priva di documenti, connessioni e dati sintetici, senza modifiche alla numerazione fiscale, e il suo backup `current` è rimasto quello pulito.

### OCI e sistema operativo

- istanza `VM.Standard.A1.Flex` portata a 4 OCPU e 24 GB, massimo Ampere Always Free disponibile nel tenancy; boot volume mantenuto a 47 GB per non consumare senza necessità il plafond storage condiviso con le altre VPS;
- riavvio conseguente verificato: kernel Oracle corrente, nessun pacchetto APT o snap pendente e nessun altro riavvio richiesto;
- agent OCI, Compute Instance Monitoring, OS Management Hub, Block Volume Management e Bastion attivi; dopo il collaudo controllato, il plugin Run Command è stato disabilitato e il relativo permesso è stato rimosso dal dynamic group di backup preservando tutti gli altri plugin;
- il riavvio controllato ha portato `hub-fatture-metrics-absent` da `OK` a `FIRING` alle `2026-08-11T21:13:12Z` e di nuovo a `OK` alle `2026-08-11T21:15:15Z`; la notifica di rientro è stata ricevuta e gli allarmi CPU, memoria e load average sono rimasti sani;
- il monitor locale è stato eseguito due volte senza ricevuta backup, poi dopo il ripristino della ricevuta e ancora una volta in stato sano: la deduplicazione ha prodotto esattamente un allarme e un rientro, confermati alle `2026-08-11T21:28:00Z` dalle metriche OCI con `2` messaggi pubblicati e `2` consegnati;
- il target del solo monitor esterno è stato portato temporaneamente su una route inesistente: due esecuzioni consecutive hanno prodotto Availability `0` alle `2026-08-11T21:27:00Z` e `2026-08-11T21:33:00Z`, quindi `hub-fatture-health-unavailable` è passato da `OK` a `FIRING` alle `2026-08-11T21:36:11Z`; ripristinato il target canonico, Availability è tornata a `1` alle `2026-08-11T21:39:00Z` e l’allarme a `OK` alle `2026-08-11T21:42:06Z`, senza downtime pubblico e con esattamente `2` messaggi pubblicati e `2` consegnati per allarme e rientro;
- timer `hub-fatture-backup` e `hub-fatture-monitor` attivi dopo il riavvio; monitor locale sano, container applicativi ripartiti automaticamente e tutti gli allarmi riletti `OK` dopo i collaudi.

## Limiti osservati

Questa è una pubblicazione tecnica della Production, non il go-live: nessuna GitHub Release, nessun invio Aruba, nessuna e-mail cliente e nessun ordine reale sono stati prodotti. Il canary e la qualifica sul pannello Aruba restano ai gate successivi del Master Plan.
