# Procedura manuale Aruba

Questa è la procedura permanente quando le API Aruba non sono disponibili o non sono autorizzate.
È l’unico fallback applicativo al canale API.

1. In **Documenti**, verificare numero, data, destinatario e totale; quindi scaricare l’XML approvato.
2. Aprire manualmente il pannello ufficiale Aruba e completare personalmente login e password. Se compare una challenge OTP, SMS o CAPTCHA inattesa, completarla senza comunicare questi dati a Hub Fatture.
3. Usare il caricamento XML del pannello. La configurazione corrente non richiede un SMS per ogni upload; se Aruba presenta comunque una verifica di sicurezza, completarla personalmente prima di proseguire. Non usare **Salva in bozze** e non modificare i dati del documento nel pannello.
4. Leggere la validazione di ogni XML. Se anche un documento è invalido, non inviare: usare **SVUOTA PAGINA** per rimuovere tutti gli upload del batch e verificare nel pannello che non siano rimasti pendenti.
5. Confrontare di nuovo numero, data, destinatario e totale. In una prova controllata fermarsi qui, prima di **INVIA TUTTE** o **INVIA**, usare **SVUOTA PAGINA** e fare readback.
6. In un invio manuale realmente autorizzato, il clic **Invia** resta un’azione personale del titolare. Se la risposta è incerta, non ripetere l’upload o l’invio: cercare prima il documento nel pannello per nome, numero, data, destinatario e totale.
7. Dal pannello scaricare i file ufficiali disponibili: XML, P7M, PDF e notifiche SdI.
8. In **Documenti → Importa file ufficiale**, selezionare il documento e il tipo corretto, quindi importare ogni file. L’XML deve coincidere con l’hash approvato; file non riconosciuti vengono rifiutati. Verificare infine che ogni elemento compaia in **File ufficiali archiviati** e che il relativo download sia leggibile.
9. Se il readback resta incerto o un upload non può essere rimosso, lasciare il batch bloccato. Preparare un nuovo tentativo soltanto dopo una riconciliazione conclusiva che confermi la rimozione.

Il pannello qualificato mostra i limiti di 4,9 MB per XML, 300 documenti e 30 MB per caricamento. Le protezioni di accesso possono variare con la configurazione dell’account; l’eventuale verifica resta sempre un passaggio umano. Fonti: [caricamento XML](https://guide.aruba.it/soluzioni-fatturazione-elettronica/fe/fatture-documenti/carica-fatture/come-caricare-fatture-formato-xml-pannello), [accesso al pannello](https://guide.aruba.it/soluzioni-fatturazione-elettronica/fe/accesso-homepage/accesso-pannello-e-app/come-accedere-pannello-fe), [download dei file ufficiali](https://guide.aruba.it/soluzioni-fatturazione-elettronica/fe/fatture-inviate-ricevute-bozze/fatture-inviate/come-scaricare-fatture-inviate).

## Readback in entrata e preflight

Se l’inventario globale è sano ma manca il controllo immediato di una preparazione, il titolare deve eseguire tutte le ricerche mostrate dalla preparazione, acquisire ogni riga di tutte le pagine e importare i file ufficiali di ogni candidato. La verifica vale soltanto per revisione e hash correnti, non aggiorna la freschezza globale e scade dopo cinque minuti. Un candidato, una pagina mancante o uno stato incerto mantiene il blocco.

Se invece la scansione automatica è fallita o incompleta, la verifica specifica non basta. Il readback completo deve coprire ogni stream indicato in Impostazioni, dall’estremo temporale richiesto fino alla pagina terminale, includendo tutte le righe una sola volta oppure un export ufficiale integrale. Conservare filtri, ordinali, conteggi, estremi e file necessari. Uno dei due account amministrativi con permesso di approvazione può finalizzare la ricevuta; la sessione automatica fallita resta nella cronologia e collisioni, file non validi, match ambigui o stati remoti incerti non sono superabili manualmente.

In **Impostazioni → Connessione Aruba → Recupero manuale**, aprire il readback completo, copiare tutte le pagine nel formato mostrato e finalizzare soltanto dopo che il riepilogo copre ogni stream richiesto. Ordinali mancanti, pagina terminale assente, righe duplicate o una sincronizzazione ancora attiva bloccano la finalizzazione. L’operazione riuscita crea una nuova ricevuta manuale completa senza cancellare né trasformare i giri automatici falliti.

Per una preparazione usare invece **Readback manuale specifico**: riportare tutte le pagine delle ricerche indicate. Una pagina vuota e completa produce una ricevuta monouso valida cinque minuti; qualunque candidato produce un blocco e deve prima essere importato e riconciliato.

## Decisioni sui documenti Aruba già emessi

In **Controlli**, importare prima l’XML ufficiale sul documento Aruba corretto. Se il matcher propone più candidati già compatibili, Massimo può selezionare l’ordine e confermare con una motivazione di almeno dieci caratteri. La decisione è auditata e non può aggirare il profilo fiscale. Per `DELIVERED` e `NOT_DELIVERED` la conferma materializza il documento storico e aggiorna atomicamente ordine, preparazione o rimborsi; stati intermedi e `REJECTED` non sono collegabili.

Quando XML ufficiale, data vicina e destinatario individuano un ordine ma l’importo è diverso, il sistema non collega automaticamente il documento. Massimo può scegliere **Collega come fattura già emessa** solo dopo avere confrontato le evidenze, indicato il motivo della differenza e confermato esplicitamente la decisione. Il documento storico conserva separatamente totale Aruba, totale fatturabile locale, scostamento e motivazione; l’ordine viene chiuso come fatturato senza creare né inviare una nuova fattura. I rimborsi completati prima della data fiscale riducono il totale locale; quelli completati dopo restano post-emissione e avviano la normale riconciliazione TD04. Un rimborso completato nello stesso giorno resta ambiguo e impedisce il collegamento finché l’ordine temporale non è provato.

Una TD04 storica recuperata dall’API conserva il metodo di pagamento dichiarato nell’XML ufficiale, anche se diverso dal default corrente delle nuove note di credito. Questo dato non basta a collegarla: emittente, profilo fiscale, numero, data, totale, fattura richiamata e insieme dei rimborsi devono coincidere; in caso contrario la riconciliazione resta bloccata.

Se un documento terminale con XML ufficiale presenta un conflitto di profilo o un riferimento ordine esplicito incompatibile, ma nessun candidato locale compatibile né collegamento preesistente, il solo titolare può confermarlo come fattura fuori perimetro con una motivazione di almeno venti caratteri. La decisione è critica e auditata, classifica l’origine come esterna a Hub Fatture, resta stabile alle scansioni successive e rimuove quel documento dai blocchi dell’inventario senza creare clienti, ordini, preparazioni, documenti o movimenti locali. Questa classificazione comprende ordini e fatture che non passano da eBay o Shopify e che non fanno parte dello scope di Hub Fatture. Non usare l’azione quando esiste anche un solo candidato compatibile, manca l’XML ufficiale oppure il documento appartiene al perimetro dei due canali gestiti.

Se una fattura esterna copre un solo ordine di una preparazione multipla, verificare che l’ordine coperto risulti fatturato e che la bozza residua contenga ancora tutti e soli gli altri ordini con importi e revisione rigenerati. Per una TD04 verificare che tutti e soli i rimborsi coperti siano collegati alla stessa nota di credito. Qualunque esito parziale o incoerente richiede di lasciare il caso in verifica: non correggere direttamente XML, documenti approvati o collegamenti DB.
