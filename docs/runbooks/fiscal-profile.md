# Attivazione del profilo fiscale

Il profilo fiscale applicativo deriva da una TD01 già accettata dallo SdI e dalle regole di numerazione confermate. Il file sorgente resta fuori dal repository, con permessi riservati, e non viene copiato nei log o nelle fixture.

Prerequisiti:

- audit Aruba concluso;
- una TD01 accettata per il profilo e l'ultimo documento accettato della serie condivisa, TD01 o TD04;
- serie privata `FPR` annuale verificata;
- regola a cavallo d’anno confermata: data di approvazione e numerazione del nuovo anno;
- procedura di scarto confermata: correzione con stessa data e stesso numero;
- account `matteo` già configurato nel database;
- variabili dell’ambiente applicativo caricate.

Con un XML TD01 accettato disponibile in un percorso locale esterno al repository:

```sh
chmod 600 /percorso/riservato/fattura-accettata.xml
npm run fiscal-profile:activate -- /percorso/riservato/td01.xml /percorso/riservato/ultimo-td01-o-td04.xml
```

Il secondo percorso è facoltativo soltanto quando la TD01 del profilo è già l'ultimo documento accettato. Il comando valida entrambi gli XML contro lo schema FatturaPA offline, estrae il profilo del cedente e il progressivo FPR più recente tra TD01 e TD04, salva nel database una nuova versione `AUDITED`, ritira la versione attiva precedente e registra l’audit critico. La numerazione applicativa parte dal progressivo successivo, considerando anche gli eventuali documenti già approvati nel database; un’attivazione con un progressivo osservato inferiore a quello attivo viene rifiutata. In output compare soltanto il numero di versione; dati fiscali, progressivo e hash non vengono stampati.

Dopo il readback della versione attiva, rimuovere in modo sicuro l’eventuale copia temporanea dell’XML. Non attivare il profilo da una fattura scartata, da un PDF o da un file modificato manualmente.

Lo storage dei documenti approvati usa `DOCUMENT_STORAGE_ROOT`; il valore predefinito Development è `storage/documents`, già escluso da Git. In Production deve puntare al volume persistente previsto dal deployment.
