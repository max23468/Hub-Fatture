# Backup cifrato e ripristino

## Backup

Il timer giornaliero esegue `scripts/backup.sh`. Backup e deploy acquisiscono lo stesso lock: una contesa termina prima di toccare dati o container e pubblica l’errore sul Notifications Topic configurato. PostgreSQL viene esportato in formato custom dentro `/dev/shm`, quindi dump, documenti e manifest non segreto vengono cifrati con il solo destinatario pubblico `age`; la pipeline fallisce se `tar` o `age` non completa il proprio lavoro. Solo l’archivio cifrato viene caricato nel bucket OCI privato tramite Instance Principal. Dimensione e checksum vengono riletti da Object Storage prima di aggiornare la ricevuta mostrata in **Impostazioni > Sistema**.

Il processo non possiede credenziali Object Storage statiche. L’Instance Principal può creare e rileggere soltanto gli oggetti cifrati del bucket per verificarne dimensione e metadati, ma non può cancellarli. Ogni esecuzione crea un oggetto archivio immutabile e aggiorna una copia cifrata protetta `current`; il lifecycle elimina soltanto gli archivi scaduti e non può selezionare `current`, quindi non può eliminare l’ultimo backup valido.

Il monitor locale somma le dimensioni degli oggetti tramite lo stesso Instance Principal e avvisa al raggiungimento di 15 GB, margine prudenziale rispetto ai 20 GB inclusi verificati per Object Storage. Un errore di lettura della quota è a sua volta un’anomalia; `OCI_BACKUP_WARNING_BYTES` serve soltanto per il collaudo controllato della soglia.

## Copia sul Mac

Scaricare periodicamente l’oggetto cifrato più recente in `/Users/Matteo/Progetti/Hub-Fatture/backups/`, verificarne dimensione e checksum rispetto alla ricevuta e sostituire la sola copia corrente dopo il confronto. La directory deve mantenere permessi `700`, gli archivi `600` ed è esclusa da Git tramite `.gitignore`; prima di eliminare, ricreare o eseguire una pulizia del checkout che includa i file ignorati, trasferire la copia in una posizione protetta e verificarla nuovamente. L’identità privata `age` e la chiave AEAD delle credenziali restano nel recovery kit `/Users/Matteo/Documents/Hub-Fatture-Recovery/`, con permessi del solo titolare e protetto da FileVault; non vengono copiate dalla VPS nel backup.

## Restore drill

Il drill usa `scripts/restore.sh` in un target nuovo ed esplicito. Sono obbligatori archivio, checksum SHA-256 della ricevuta, identità, database isolato e conferma esatta `RESTORE:<target>`. Lo script verifica il checksum prima di decifrare, rifiuta target esistenti, decifra in streaming, ripristina con `pg_restore` e rimuove il dump temporaneo.

La prova è conclusa soltanto dopo:

- checksum dell’archivio coerente con la ricevuta;
- schema e conteggi principali riletti;
- almeno un documento sintetico con file, percorso, metadati e hash collegati nel database, riletto tramite l’applicazione;
- una credenziale sintetica cifrata nel database e decifrata dall’applicazione usando soltanto la chiave AEAD recuperata dal kit;
- login case-insensitive di `Massimo` e `Codex`, nomi canonici e privilegi corretti;
- health check verde nel target isolato.

Un restore Production è distruttivo e resta vietato senza autorizzazione separata, conservazione delle prove e piano di rientro.
