# Procedura manuale Aruba

Questa è la procedura completa quando l’helper non è disponibile, il browser non è supportato o il pannello è cambiato.

1. In **Documenti**, verificare numero, data, destinatario e totale; quindi scaricare l’XML approvato.
2. Aprire manualmente il pannello ufficiale Aruba e completare personalmente login, OTP, 2FA o CAPTCHA. Non comunicare questi dati a Hub Fatture o all’helper.
3. Usare il caricamento XML del pannello. Non usare **Salva in bozze** e non modificare i dati del documento nel pannello.
4. Leggere la validazione di ogni XML. Se anche un documento è invalido, non inviare: rimuovere tutti gli upload del batch e verificare nel pannello che non siano rimasti pendenti.
5. Confrontare di nuovo numero, data, destinatario e totale. In una prova controllata fermarsi qui, prima di **Invia**, rimuovere l’upload e fare readback.
6. In un invio manuale realmente autorizzato, il clic **Invia** resta un’azione personale del titolare. Se la risposta è incerta, non ripetere l’upload o l’invio: cercare prima il documento nel pannello per nome, numero, data, destinatario e totale.
7. Dal pannello scaricare i file ufficiali disponibili: XML, P7M, PDF e notifiche SdI.
8. In **Documenti → Importa file ufficiale**, selezionare il documento e il tipo corretto, quindi importare ogni file. L’XML deve coincidere con l’hash approvato; file non riconosciuti vengono rifiutati. Verificare infine che ogni elemento compaia in **File ufficiali archiviati** e che il relativo download sia leggibile.
9. Se il readback resta incerto o un upload non può essere rimosso, lasciare il batch bloccato. Preparare un nuovo tentativo soltanto dopo una riconciliazione conclusiva che confermi la rimozione.

La guida Aruba indica un limite XML di 4,9 MB e distingue il caricamento con 2FA attiva dal flusso con codice SMS; l’eventuale codice resta sempre un passaggio umano. Fonti: [caricamento XML](https://guide.aruba.it/soluzioni-fatturazione-elettronica/fe/fatture-documenti/carica-fatture/come-caricare-fatture-formato-xml-pannello), [accesso al pannello](https://guide.aruba.it/soluzioni-fatturazione-elettronica/fe/accesso-homepage/accesso-pannello-e-app/come-accedere-pannello-fe), [download dei file ufficiali](https://guide.aruba.it/soluzioni-fatturazione-elettronica/fe/fatture-inviate-ricevute-bozze/fatture-inviate/come-scaricare-fatture-inviate).
