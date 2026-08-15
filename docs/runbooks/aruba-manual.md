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
3. Selezionare la conferma riferita al singolo documento e al singolo tentativo, quindi usare **Prepara invio pilota**. L’app crea un nuovo manifest automatico con permesso inattivo e annulla il batch assistito sorgente; non carica né invia nulla ad Aruba.
4. Rileggere batch, manifest, documento, revisione, hash e scope. Un secondo batch pilota, un batch già avviato, il kill switch attivo o qualunque mismatch devono bloccare l’operazione.
5. Generare il codice helper soltanto quando si è pronti per la sessione presidiata. Dopo la validazione e un preflight fresco e completo dell’inventario Aruba, attivare il permesso con una nuova conferma specifica immediatamente prima del clic finale; l’helper lo consuma atomicamente. Finché l’inventario provider-first non è disponibile, il consumo resta bloccato.
6. Qualunque errore o stato incerto arresta il flusso. Prima di un nuovo tentativo completare il readback, rimuovere l’upload e verificare che il vecchio permesso sia consumato, scaduto o revocato.
7. Al termine, anche in caso di errore, verificare `ARUBA_SUBMISSION_ENABLED=false` e l’assenza di permessi pilota validi.

## Readback in entrata e preflight

Se l’inventario globale è sano ma manca il controllo immediato di una preparazione, il titolare deve eseguire tutte le ricerche mostrate dalla preparazione, acquisire ogni riga di tutte le pagine e importare i file ufficiali di ogni candidato. La verifica vale soltanto per revisione e hash correnti, non aggiorna la freschezza globale e scade dopo cinque minuti. Un candidato, una pagina mancante o uno stato incerto mantiene il blocco.

Se invece la scansione automatica è fallita o incompleta, la verifica specifica non basta. Il readback completo deve coprire ogni stream indicato in Impostazioni, dall’estremo temporale richiesto fino alla pagina terminale, includendo tutte le righe una sola volta oppure un export ufficiale integrale. Conservare filtri, ordinali, conteggi, estremi e file necessari. Solo Massimo con permesso di approvazione può finalizzare la ricevuta; la sessione automatica fallita resta nella cronologia e collisioni, file non validi, match ambigui o stati remoti incerti non sono superabili manualmente.

In **Impostazioni → Helper Aruba**, aprire il readback completo, copiare tutte le pagine nel formato mostrato e finalizzare soltanto dopo che il riepilogo copre ogni stream richiesto. Ordinali mancanti, pagina terminale assente, righe duplicate o una sessione helper ancora attiva bloccano la finalizzazione. L’operazione riuscita crea una nuova ricevuta manuale completa senza cancellare né trasformare le sessioni automatiche fallite.

Per una preparazione usare invece **Readback manuale specifico**: riportare tutte le pagine delle ricerche indicate. Una pagina vuota e completa produce una ricevuta monouso valida cinque minuti; qualunque candidato produce un blocco e deve prima essere importato e riconciliato.

## Collegamento manuale di un documento esterno

In **Documenti → Da collegare**, importare prima l’XML ufficiale sul documento Aruba corretto. Se il matcher propone più candidati già compatibili, Massimo può selezionare l’ordine e confermare con una motivazione di almeno dieci caratteri. La decisione è auditata e non può rendere compatibile un candidato scartato dal matcher, modificare importi o aggirare il profilo fiscale. Per `DELIVERED` e `NOT_DELIVERED` la conferma materializza il documento storico e aggiorna atomicamente ordine, preparazione o rimborsi; per stati intermedi o `REJECTED` resta soltanto il collegamento operativo senza una nuova riga fiscale.

Se un documento terminale con XML ufficiale è in conflitto con il profilo e non presenta alcun candidato locale compatibile né collegamenti preesistenti, il solo titolare può confermarlo come documento esterno con una motivazione di almeno venti caratteri. La decisione è critica e auditata, resta stabile alle scansioni successive e rimuove quel documento dai blocchi dell’inventario senza creare documenti, collegamenti o movimenti locali. Non usare questa azione quando esiste anche un solo candidato compatibile, manca l’XML ufficiale oppure non è stato verificato che il documento sia realmente estraneo alla gestione corrente.

Se una fattura esterna copre un solo ordine di una preparazione multipla, verificare che l’ordine coperto risulti fatturato e che la bozza residua contenga ancora tutti e soli gli altri ordini con importi e revisione rigenerati. Per una TD04 verificare che tutti e soli i rimborsi coperti siano collegati alla stessa nota di credito. Qualunque esito parziale o incoerente richiede di lasciare il caso in verifica: non correggere direttamente XML, documenti approvati o collegamenti DB.
