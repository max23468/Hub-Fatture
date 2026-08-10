# Attivazione del profilo fiscale

Il profilo fiscale applicativo deriva da una TD01 già accettata dallo SdI e dalle regole di numerazione confermate. Il file sorgente resta fuori dal repository, con permessi riservati, e non viene copiato nei log o nelle fixture.

Prerequisiti:

- audit Aruba concluso;
- serie privata `FPR` annuale verificata;
- regola a cavallo d’anno confermata: data di approvazione e numerazione del nuovo anno;
- procedura di scarto confermata: correzione con stessa data e stesso numero;
- account `matteo` già configurato nel database;
- variabili dell’ambiente applicativo caricate.

Con un XML TD01 accettato disponibile in un percorso locale esterno al repository:

```sh
chmod 600 /percorso/riservato/fattura-accettata.xml
npm run fiscal-profile:activate -- /percorso/riservato/fattura-accettata.xml
```

Il comando valida l’XML contro lo schema FatturaPA offline, estrae soltanto il profilo del cedente e le regole tecniche qualificate, salva nel database una nuova versione `AUDITED`, ritira la versione attiva precedente e registra l’audit critico. In output compare soltanto il numero di versione; dati fiscali e hash non vengono stampati.

Dopo il readback della versione attiva, rimuovere in modo sicuro l’eventuale copia temporanea dell’XML. Non attivare il profilo da una fattura scartata, da un PDF o da un file modificato manualmente.

Lo storage dei documenti approvati usa `DOCUMENT_STORAGE_ROOT`; il valore predefinito Development è `storage/documents`, già escluso da Git. In Production deve puntare al volume persistente previsto dal deployment.
