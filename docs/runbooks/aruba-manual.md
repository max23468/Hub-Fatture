# Procedura manuale Aruba

Questa è la procedura completa quando l’helper non è disponibile, il browser non è supportato o il pannello è cambiato.

1. In **Documenti**, verificare numero, data, destinatario e totale; quindi scaricare l’XML approvato.
2. Aprire manualmente il pannello ufficiale Aruba e completare personalmente login e password. Se compare una challenge OTP, SMS o CAPTCHA inattesa, completarla senza comunicare questi dati a Hub Fatture o all’helper.
3. Usare il caricamento XML del pannello. La configurazione corrente non richiede un SMS per ogni upload; se Aruba presenta comunque una verifica di sicurezza, completarla personalmente prima di proseguire. Non usare **Salva in bozze** e non modificare i dati del documento nel pannello.
4. Leggere la validazione di ogni XML. Se anche un documento è invalido, non inviare: usare **SVUOTA PAGINA** per rimuovere tutti gli upload del batch e verificare nel pannello che non siano rimasti pendenti.
5. Confrontare di nuovo numero, data, destinatario e totale. In una prova controllata fermarsi qui, prima di **INVIA TUTTE** o **INVIA**, usare **SVUOTA PAGINA** e fare readback.
6. In un invio manuale realmente autorizzato, il clic **Invia** resta un’azione personale del titolare. Se la risposta è incerta, non ripetere l’upload o l’invio: cercare prima il documento nel pannello per nome, numero, data, destinatario e totale.
7. Dal pannello scaricare i file ufficiali disponibili: XML, P7M, PDF e notifiche SdI.
8. In **Documenti → Importa file ufficiale**, selezionare il documento e il tipo corretto, quindi importare ogni file. L’XML deve coincidere con l’hash approvato; file non riconosciuti vengono rifiutati. Verificare infine che ogni elemento compaia in **File ufficiali archiviati** e che il relativo download sia leggibile.
9. Se il readback resta incerto o un upload non può essere rimosso, lasciare il batch bloccato. Preparare un nuovo tentativo soltanto dopo una riconciliazione conclusiva che confermi la rimozione.

Il pannello qualificato mostra i limiti di 4,9 MB per XML, 300 documenti e 30 MB per caricamento. Le protezioni di accesso possono variare con la configurazione dell’account; l’eventuale verifica resta sempre un passaggio umano. Fonti: [caricamento XML](https://guide.aruba.it/soluzioni-fatturazione-elettronica/fe/fatture-documenti/carica-fatture/come-caricare-fatture-formato-xml-pannello), [accesso al pannello](https://guide.aruba.it/soluzioni-fatturazione-elettronica/fe/accesso-homepage/accesso-pannello-e-app/come-accedere-pannello-fe), [download dei file ufficiali](https://guide.aruba.it/soluzioni-fatturazione-elettronica/fe/fatture-inviate-ricevute-bozze/fatture-inviate/come-scaricare-fatture-inviate).

## Preparazione dell’invio pilota

Questa procedura si usa soltanto dopo la chiusura del collaudo e l’autorizzazione separata del titolare per un singolo documento reale. Non costituisce autorizzazione a eseguire il Canary.

1. Verificare dal readback Production che `ARUBA_SUBMISSION_ENABLED=false`, che non esistano altri documenti approvati o upload pendenti e che non restino permessi pilota validi.
2. In **Documenti**, individuare il batch assistito ancora nello stato **Preparato** e contenente esattamente il documento autorizzato.
3. Selezionare la conferma riferita al singolo documento e al singolo tentativo, quindi usare **Prepara invio pilota**. L’app crea un nuovo manifest automatico e annulla il batch assistito sorgente; non carica né invia nulla ad Aruba.
4. Rileggere batch, manifest, documento, revisione, hash, scadenza e scope del permesso. Un secondo permesso valido, un batch già avviato, il kill switch attivo o qualunque mismatch devono bloccare l’operazione.
5. Generare il codice helper soltanto quando si è pronti per la sessione presidiata. Il permesso viene consumato atomicamente dopo la validazione e subito prima del clic finale; un crash precedente non autorizza alcun invio.
6. Qualunque errore o stato incerto arresta il flusso. Prima di un nuovo tentativo completare il readback, rimuovere l’upload e verificare che il vecchio permesso sia consumato, scaduto o revocato.
7. Al termine, anche in caso di errore, verificare `ARUBA_SUBMISSION_ENABLED=false` e l’assenza di permessi pilota validi.
