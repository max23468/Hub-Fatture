# Backup cifrato e ripristino

## Backup

Il timer giornaliero esegue `scripts/backup.sh`. Backup e deploy acquisiscono lo stesso lock: una contesa termina prima di toccare dati o container e pubblica l’errore sul Notifications Topic configurato. PostgreSQL viene esportato in formato custom dentro `/dev/shm`, quindi dump, documenti e manifest non segreto vengono cifrati con il solo destinatario pubblico `age`. Solo l’archivio cifrato viene caricato nel bucket OCI privato tramite Instance Principal. Dimensione e checksum vengono riletti da Object Storage prima di aggiornare la ricevuta mostrata in **Impostazioni > Sistema**.

Il processo non possiede credenziali Object Storage statiche. L’Instance Principal può creare e rileggere soltanto gli oggetti cifrati del bucket per verificarne dimensione e metadati, ma non può cancellarli. Ogni esecuzione crea un oggetto archivio immutabile e aggiorna una copia cifrata protetta `current`; il lifecycle elimina soltanto gli archivi scaduti e non può selezionare `current`, quindi non può eliminare l’ultimo backup valido.

## Copia sul Mac

Scaricare periodicamente l’oggetto cifrato più recente in `~/HubFatture-Backups/`, fuori dal checkout, verificarne dimensione e checksum rispetto alla ricevuta e sostituire la sola copia corrente dopo il confronto. L’identità privata resta in `/Users/Matteo/Documents/Hub-Fatture-Recovery/age-identity.txt`, con permessi del solo titolare e protetta da FileVault; non viene copiata sulla VPS.

## Restore drill

Il drill usa `scripts/restore.sh` in un target nuovo ed esplicito. Sono obbligatori archivio, checksum SHA-256 della ricevuta, identità, database isolato e conferma esatta `RESTORE:<target>`. Lo script verifica il checksum prima di decifrare, rifiuta target esistenti, decifra in streaming, ripristina con `pg_restore` e rimuove il dump temporaneo.

La prova è conclusa soltanto dopo:

- checksum dell’archivio coerente con la ricevuta;
- schema e conteggi principali riletti;
- documenti sintetici presenti e integri;
- login case-insensitive di `Massimo` e `Codex`, nomi canonici e privilegi corretti;
- health check verde nel target isolato.

Un restore Production è distruttivo e resta vietato senza autorizzazione separata, conservazione delle prove e piano di rientro.
