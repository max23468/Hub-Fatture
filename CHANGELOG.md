# Changelog

## 1.3.18

- La risoluzione di una collisione Aruba archivia la fattura ufficiale scelta anche quando il numero è occupato dal tentativo locale escluso. La deroga richiede una decisione verificata e i due XML; conserva documento, ordini e monitoraggio precedenti senza autorizzare riemissioni.

- L’inventario Aruba viene ripianificato dopo due minuti dal giro precedente, in coerenza con la freschezza richiesta per approvare. Una rilettura mirata non rinvia più l’inventario di quindici minuti e non rinnova la freschezza dell’intera scansione.
- I giri incrementali riusano le evidenze dei gruppi singoli definitivi e invariati, evitando nuove letture di dettaglio e notifiche. Documenti nuovi, cambi di stato, file mancanti, evidenze incerte, gruppi multipli e scansioni complete mantengono la verifica completa; i gate di approvazione restano attivi.

## 1.3.17

- Le collisioni fra documenti Aruba producono un solo controllo con tutti i documenti coinvolti. Dal dettaglio si può confermare la fattura corretta, con motivazione e audit, lasciando il documento errato separato e sotto controllo fino alla verifica dell’esito SdI.
- Le sincronizzazioni successive rispettano la decisione senza ricollegare automaticamente il documento escluso; nuove evidenze o un ulteriore duplicato richiedono una nuova verifica.

## 1.3.16

- Le collisioni fra due documenti Aruba con identità e stato noti, dopo il confronto con gli ordini, bloccano soltanto le preparazioni coinvolte. Le fatture estranee restano approvabili; il numero duplicato, gli stati realmente incerti e le verifiche incomplete restano bloccati anche prima dell’invio.
- Controlli distingue l’identità fiscale duplicata da una possibile fattura da collegare, conserva i candidati degli ordini e mantiene aperto il conflitto senza riconciliare o materializzare automaticamente i documenti coinvolti.

## 1.3.15

- Il monitoraggio delle fatture e le ricerche Aruba attendono il completamento dell’inventario sullo stesso account. Se la sincronizzazione inizia durante una lettura, il controllo riprende dalla coda senza segnalare un guasto della connessione né modificare lo stato fiscale.

## 1.3.14

- Una collisione fiscale Aruba irrisolta resta quarantinata anche nei refresh successivi: il documento non rientra nella riconciliazione automatica e, quando possiede già XML o P7M ufficiale, non richiede nuovamente file, PDF o notifiche fino alla decisione manuale.

## 1.3.13

- La persistenza del refresh API Aruba applica ora la selezione di artefatti calcolata dall’inventario: file fiscali, notifiche e PDF già completi non vengono reimportati, mentre XML e P7M restano equivalenti come fonte fiscale ufficiale. I refresh mirati dei documenti in collisione possono così concludersi senza alterare le evidenze già archiviate.

## 1.3.12

- Il refresh Aruba riconosce come idempotente un file ufficiale già acquisito per un documento coinvolto in una collisione fiscale, anche quando il provider varia metadati accessori della notifica: la sincronizzazione prosegue senza riconciliare né materializzare automaticamente i documenti ambigui.
- I PDF ufficiali già archiviati non vengono scaricati nuovamente a ogni variazione di stato remoto, evitando copie ridondanti generate dal provider senza rinunciare all’acquisizione iniziale.

## 1.3.11

- La ricevuta di readiness Production applica lo stesso criterio dell’attivazione Aruba: i batch `DOCUMENT_ONLY` riconciliati restano visibili come aperti ma non bloccano gli invii, mentre qualsiasi batch realmente trasmissibile o ancora incerto continua a impedire l’abilitazione.

## 1.3.10

- I file ufficiali di documenti Aruba coinvolti in una collisione fiscale irrisolta vengono conservati sul rispettivo identificativo provider senza avviare riconciliazione o materializzazione automatica: la sincronizzazione prosegue, mentre entrambi i documenti restano separati e in stato remoto incerto fino alla verifica manuale.

## 1.3.9

- La riattivazione degli invii distingue i batch realmente bloccanti dai documenti `DOCUMENT_ONLY` già acquisiti e identificati da Aruba: questi ultimi restano isolati e monitorati senza impedire nuove fatture, mentre stati incerti, riconciliazioni pendenti, batch trasmissibili e job outbound continuano a bloccare la procedura.
- Le fatture Aruba con la stessa identità fiscale restano record distinti per identificativo provider e conservano ciascuna il proprio file ufficiale: la collisione continua a richiedere verifica manuale senza interrompere le sincronizzazioni successive.

## 1.3.8

- La validazione preliminare delle fatture Aruba avviene soltanto in locale: Production non chiama più il dry-run remoto, mentre approvazione e invio richiedono conferme distinte e l’inventario Aruba recente.
- La numerazione considera anche i documenti remoti e viene ricontrollata prima della rete; ID Aruba distinti con lo stesso numero o hash restano separati e aprono un conflitto invece di essere fusi.
- Uno scarto SdI autorevole conserva documento e numero originari e riporta in una nuova preparazione soltanto gli ordini ancora fatturabili, senza approvare o trasmettere automaticamente la riemissione.

## 1.3.7

- Le nuove fatture e note di credito uniformano al formato Aruba i dati del destinatario: anagrafica e indirizzo in maiuscolo, nome e cognome separati per i privati e numero civico nel campo dedicato quando è identificabile senza ambiguità.
- Generazione e riconciliazione storica condividono la stessa classificazione degli indirizzi, evitando che vie numerate, civici esteri o complementi vengano interpretati in modo diverso.

## 1.3.6

- La ricerca globale usa un’anteprima leggera dell’inventario Aruba, mantenendo gli stessi criteri e conteggi senza calcolare candidati, differenze e controlli non mostrati nei risultati.

## 1.3.5

- La sincronizzazione Shopify considera equivalenti i default identitari assenti e vuoti, evitando falsi conflitti durante gli aggiornamenti di evasione senza indebolire il blocco sulle differenze effettive.
- L'upgrade rilegge soltanto gli ordini Shopify già bloccati da un conflitto sorgente, così i casi deterministici vengono riallineati mentre quelli ambigui restano da verificare.

## 1.3.4

- L'upgrade rilegge automaticamente la finestra degli ordini eBay provvisori ancora attivi, così la riconciliazione strutturale consolida anche i record creati prima della correzione.
- Production verifica che versione e tag siano liberi o già associati allo stesso candidato prima del deploy, impedendo disallineamenti quando una pubblicazione concorrente conclude per prima.

## 1.3.3

- Il runtime Aruba elimina un wrapper senza comportamento, codice morto e facciate interne non consumate, mantenendo invariati riconciliazione, invio e monitoraggio SdI.
- Il campo Scadenza dei Controlli resta contenuto nel pannello anche sui viewport mobile più stretti.
- L’audit dipendenze ritenta soltanto gli errori transitori del registry entro un limite esplicito e continua a fallire subito quando rileva vulnerabilità.

## 1.3.2

- La sincronizzazione eBay consolida in modo atomico gli ordini provvisori quando il successivo ordine definitivo riunisce le stesse identità di riga, conservando audit e blocchi fiscali nei casi ambigui.
- Il preflight completa l'audit dipendenze prima dei gate locali più pesanti, evitando che la richiesta al registry scada sotto carico senza ridurre le verifiche applicabili.

## 1.3.1

- Il workflow Production sposta la logica operativa in uno script verificabile, mantenendo invariati i gate exact-SHA, il riuso dell’artefatto attestato, il backup, il deploy e il readback.
- Il runtime elimina helper e configurazioni inutilizzati, condivide il parsing delle revisioni DB e dei valori provider e misura i confini architetturali sulla raggiungibilità effettiva dei moduli.

## 1.3.0

- La connessione Aruba rinnova la sessione con il refresh token e mostra nelle Impostazioni identità, scadenza e spazio dell’account verificato, senza conservare token o reinviare credenziali durante il rinnovo.
- Documenti aggiunge ricerca locale avanzata, verifica remota entro le finestre Aruba e lookup puntuale per filename o ID SdI, mantenendo riconciliazione e conflitti fail-closed.
- Le fatture TD01 approvate possono essere trasmesse come XML non firmati tramite il worker; lease, preflight atomico, dry-run sullo stesso hash, rate limit e recovery impediscono retry ciechi o duplicazioni.
- Il polling canonico segue ogni trasmissione fino all’esito SdI, aggiorna attività e controlli operativi e avvia gli effetti fiscali soltanto da stati terminali autorevoli, senza callback.
- La sezione Aruba delle Impostazioni usa un layout compatto e coerente su desktop, tablet e mobile, con azioni allineate e dettagli secondari mostrati solo quando utili.

## 1.2.4

- Le preparazioni mostrano direttamente il numero nativo dell’ordine e il canale di vendita nelle tabelle Ordini e Controlli, distinguendo Shopify ed eBay anche quando una preparazione raggruppa più ordini.

## 1.2.3

- Dashboard, Ordini e dettaglio preparazione mostrano come pagamenti in attesa tutti gli ordini ancora fatturabili con saldo aperto, indipendentemente dal canale e dalla presenza di una preparazione; rimborsi parziali eBay già incassati restano correttamente pagati.
- La sincronizzazione eBay integra le letture Trading `GetOrders` e `GetSellerTransactions` con le due letture Fulfillment, importa gli acquisti ancora prima del checkout e li riconcilia sull’identità stabile `OrderLineItemID` quando eBay assegna l’ordine definitivo.
- Gli acquisti eBay annullati vengono rimossi dai pagamenti in attesa, i cursori Trading lunghi sono suddivisi nel limite di 30 giorni e sovrapposizioni parziali o payload privi dell’identità stabile falliscono chiusi.

## 1.2.2

- I destinatari eBay che includono un riferimento `c/o` conservano nel nome soltanto l’intestatario e spostano il riferimento nella seconda riga dell’indirizzo, senza sovrascrivere un valore già presente; il replay riallinea automaticamente le preparazioni non corrette manualmente.
- Le rettifiche eBay limitate al timestamp di un pagamento non generano più falsi conflitti quando identificativo, importo, metodo, stato e giorno italiano restano invariati; bonifici, cambi di giorno e qualsiasi altra differenza continuano a richiedere verifica.

## 1.2.1

- Le fatture Aruba riconciliate conservano la preparazione originaria: archivio Documenti, ricerca globale e dettaglio della preparazione chiusa permettono di risalire in entrambe le direzioni fra ordine, documento fiscale e preparazioni.
- Il recupero storico collega esclusivamente i quattro abbinamenti confermati `000055`/`FPR 1627`, `000081`/`FPR 1667`, `000093`/`FPR 1685` e `000333`/`FPR 1740`, solo se il candidato resta univoco; casi diversi o ambigui restano invariati e ogni collegamento applicato lascia un evento di audit critico.

## 1.2.0

- Il profilo fiscale applicativo può essere letto e aggiornato tramite un’API interna autenticata usando XML FatturaPA provenienti da documenti SdI accettati, con conferma esplicita, validazione offline, limiti e audit critico atomico.
- L’attivazione è condivisa con la CLI, impedisce regressioni della numerazione e scritture concorrenti obsolete e rende idempotente il retry dello stesso contenuto senza creare versioni o audit duplicati.

## 1.1.0

- Dashboard, Ordini, dettaglio preparazione e Controlli condividono una proiezione operativa canonica con pool mutuamente esclusivi e cause osservabili; l’approvazione continua a rileggere i gate fiscali sotto lock.
- `Controlli` usa ricerca e paginazione keyset, mostra il totale completo e consente di organizzare un’attesa con motivo, scadenza e assegnatario `Massimo` o `Codex`, evidenziando i casi scaduti.
- La retention giornaliera passa nella coda PostgreSQL con lease, retry, ricevuta persistente, stato nelle Impostazioni e controllo bloccante quando fallisce; il contenuto e-mail viene redatto dopo 90 giorni e i metadati residui eliminati dopo 24 mesi.
- Un’e-mail redatta non può essere reinviata implicitamente con dati eliminati: serve un nuovo destinatario esplicito nella preparazione.
- Test deterministici su permutazioni di stati, candidati e finestre storiche proteggono convergenza Aruba e riconciliazione fail-closed; il ratchet architetturale include ora i moduli UI e billing più grandi e la proiezione operativa estratta.

## 1.0.17

- Il replay del matcher Aruba rivaluta anche i documenti storici con data vicina, importo diverso e indirizzo già coincidente, così una P.IVA italiana precedentemente esclusa per il Paese mancante viene ricontrollata senza collegamenti automatici.

## 1.0.16

- Le preparazioni composte esclusivamente da ordini Shopify pagati con bonifico propongono `MP05`; una successiva transazione `manual` vale come conferma soltanto a parità d'importo e senza metodi concorrenti, mentre i casi misti o ambigui conservano il metodo predefinito.
- La riconciliazione Aruba completa il Paese mancante delle P.IVA italiane usando l'indirizzo e trattiene gli importi discordanti quando l'identità coincide per nome, codice fiscale oppure P.IVA e indirizzo; il replay rivaluta i documenti già acquisiti senza collegarli automaticamente.

## 1.0.15

- La riconciliazione Aruba riconosce i nomi dei privati esteri traslitterati dal cirillico e tollera una sola vocale duplicata o omessa soltanto quando il nominativo ha più parti e il Paese coincide; il replay TD01 riallinea i documenti già valutati senza indebolire i controlli su data, importo, unicità e XML ufficiale.

## 1.0.14

- Un documento Aruba con XML ufficiale, data e totale esattamente coincidenti può essere collegato manualmente a un ordine anche quando i dati del destinatario non coincidono, ma soltanto dopo una conferma esplicita e una motivazione che identifichi sia la fattura sia l’ordine; il collegamento non viene mai proposto come automatico e resta tracciato nell’audit come prova esterna.
- La vista “Preparazioni approvabili” mostra anche l’orario del primo ordine di ciascuna preparazione, usando sempre il fuso orario italiano; le altre viste continuano a mostrare la sola data fiscale.

## 1.0.13

- La vista “Preparazioni approvabili” mostra subito l’elenco richiesto e carica in secondo piano le proiezioni fiscali necessarie all’approvazione multipla: l’apertura dalla Dashboard non resta più serializzata dietro la preparazione di ogni candidato.
- La verifica WebKit e Chromium mantiene la navigazione documentale affidabile su mobile e impedisce al caricamento secondario delle azioni multiple di ritardare il titolo e il contenuto della pagina Ordini.

## 1.0.12

- La pagina `Controlli` e la ricerca globale leggono la coda operativa già materializzata senza ricostruirla durante la richiesta: “Apri Controlli”, i link della Dashboard e la ricerca non restano più in attesa della scansione completa, che continua nel worker dopo gli aggiornamenti del dominio.
- Un ratchet esteso all’intero runtime impedisce alle route di reintrodurre la ricostruzione sincrona; il benchmark separa inoltre il costo della lettura della coda dal suo aggiornamento asincrono.

## 1.0.11

- Il passaggio alla Dashboard legge soltanto il riepilogo dei controlli già materializzato, mentre il worker ne accorpa la ricostruzione fuori dalla richiesta: la navigazione non attende più la scansione completa dei dati operativi.
- Il badge `Controlli` arriva con il documento della pagina senza una richiesta automatica concorrente, eliminando la gara di navigazione osservata su Safari e WebKit.

## 1.0.10

- La riconciliazione Aruba conserva l’abbinamento di una nota di credito storica già adottata quando lo stesso documento viene osservato di nuovo; il replay del matcher resta limitato ai tipi fiscali interessati dalla modifica, evitando di riesaminare documenti estranei e di interrompere la sincronizzazione finale.
- Le dipendenze transitive `fast-uri` e `qs` recepiscono le correzioni di sicurezza pubblicate durante la preparazione del candidato.

## 1.0.9

- La navigazione principale e le azioni della Dashboard aprono direttamente la pagina richiesta anche quando Safari iPhone sospende una navigazione dati in corso; Dashboard, Controlli e Preparazioni non restano più dietro al cassetto mobile o a un indicatore di caricamento bloccato.

## 1.0.8

- I conflitti Aruba già valutati prima della correzione dei riepiloghi fiscali nulli vengono rigiocati automaticamente anche quando il documento è fuori dalla finestra incrementale corrente.

## 1.0.7

- Gli XML Aruba con un riepilogo IVA accessorio interamente a zero vengono riconciliati usando i soli riepiloghi fiscalmente effettivi; qualunque blocco con imponibile o imposta non nulli continua a partecipare al controllo univoco di natura e riferimento normativo.

## 1.0.6

- Il ritorno alla Dashboard dalla navigazione laterale resta immediatamente interrompibile e mostra la destinazione in caricamento senza serializzare i clic nelle View Transition native; il badge `Controlli` legge la proiezione già materializzata, mentre la ricostruzione esplicita aggiorna i controlli in batch evitando lavoro duplicato durante ogni cambio pagina.

## 1.0.5

- Una nota di credito Aruba storica priva di `DatiFattureCollegate` può adottare la fattura individuata dal matcher soltanto quando ordine, destinatario, importo e insieme dei rimborsi producono una relazione automatica univoca; un riferimento esplicito discordante continua a bloccare la riconciliazione.

## 1.0.4

- Il matcher Aruba rigioca anche i conflitti TD04 già valutati prima della correzione dei metodi di pagamento storici, così la nota ufficiale viene riconciliata automaticamente senza attendere un cambiamento del provider.

## 1.0.3

- Le note di credito storiche recuperate da Aruba conservano il metodo di pagamento dell’XML ufficiale anche quando differisce dal default corrente; identità fiscale, riferimento alla fattura e rimborsi devono comunque coincidere prima che una bozza locale venga adottata.

## 1.0.2

- I rimborsi incidono sul confronto con una fattura Aruba in base alla loro data effettiva rispetto alla data fiscale: prima riducono il totale, dopo restano da riconciliare con una TD04 e nello stesso giorno mantengono il caso bloccato se la sequenza non è provata.
- Un documento Aruba con destinatario e data coerenti ma importo diverso può essere collegato dal titolare come fattura già emessa soltanto con conferma e motivazione esplicite; il documento storico conserva totale remoto, totale locale, differenza e motivo senza creare o inviare una nuova fattura.
- Per i privati esteri, il metodo ufficiale `MP05` e un bonifico incassato nella data del documento rafforzano l’evidenza temporale del candidato senza rendere automatici i collegamenti con importi discordanti.

## 1.0.1

- I documenti Aruba con importo discordante non riaprono controlli verso ordini già fatturati e collegati a un altro documento approvato; il matcher conserva quegli ordini per riconciliare la loro fattura corretta, mentre le preparazioni ancora prive di documento restano bloccate quando destinatario e data indicano un possibile duplicato.
- I deploy ordinari mantengono e rileggono la modalità invii Aruba già autorizzata; soltanto una transizione effettiva da disabilitata ad abilitata resta nella corsia Production separata.

## 1.0.0

- L’uso Production ordinario dispone di una corsia separata dal deploy e dalla release: resta disabilitato per default, richiede la release immutabile sul commit live esatto, verifica readiness e assenza di job outbound prima dell’attivazione, rilegge entrambi i container e ripristina automaticamente `false` se il cambio non è sano.
- La sincronizzazione Aruba recupera via API i file ufficiali e le notifiche dei documenti storici privi dell'identificativo di gruppo, usando una ricerca limitata e univoca per tipo, data, numero e identità fiscale; risultati assenti, multipli o non attribuibili restano irrisolti e vengono ritentati senza collegamenti presunti.
- Una preparazione non è più approvabile quando il documento Aruba correlato ha un totale diverso: `Controlli` espone importo locale, importo remoto e differenza, mentre collegamento automatico e decisione manuale positiva restano bloccati finché gli importi non coincidono.
- Il comando server di approvazione rilegge sotto lock anche il possibile documento Aruba correlato alla preparazione: una richiesta diretta non può aggirare il blocco mostrato dall’interfaccia, mentre un conflitto riferito ad altri ordini non ferma le candidate sane.
- Il candidato destinato alla prima release operativa viene congelato con invii Aruba ordinari disabilitati; gli allineamenti automatici eBay e Shopify evitano lavoro e clonazioni seriali superflue, la qualifica tecnica è chiusa senza invii reali e il primo invio riguarda un documento ordinario già dovuto e approvato, dopo autorizzazioni separate a release e uso Production.
- Il backup conserva una copia `current` completa e autonoma, ma registra i 35 giorni storici come giornali database cifrati e immutabili: checksum e dimensioni dei due oggetti vengono riletti separatamente, evitando di duplicare quotidianamente l’intero archivio documentale nel bucket OCI.
- Dashboard, viste Ordini e dettaglio usano un’unica classificazione operativa esaustiva: ogni preparazione aperta è approvabile, in attesa del pagamento oppure nei controlli; i conflitti Aruba riferibili a una preparazione non azzerano più le altre candidate sane, mentre inventario assente, obsoleto, fallito o remoto incerto continua a bloccare globalmente le approvazioni.

## 0.5.35

- Una fattura Aruba priva di file ufficiale, vicina per data e riferibile allo stesso destinatario, blocca la preparazione anche quando il totale differisce: il sistema non presume la causa dello scarto, non collega automaticamente il documento e richiede la verifica dalla coda `Controlli`; l’upgrade riallinea con audit i casi già approvabili.
- Il riallineamento fiscale recupera dai dati Shopify l’identità completa dei privati italiani classificati come azienda per un campo società descrittivo, rilegge soltanto la finestra interessata e completa i dati anagrafici mancanti senza sovrascrivere valori fiscali già presenti o correzioni manuali.

## 0.5.34

- Il readback del candidato riconosce come conclusa la qualifica Production `dryRun=true` soltanto quando documento, batch, submission, permesso monouso, tentativo, job, manifest e hash costituiscono una prova terminale integra e priva di invio o artefatti remoti; qualsiasi divergenza resta bloccante senza riscrivere o cancellare l’evidenza M10.

## 0.5.33

- I retry Aruba espliciti possono ripartire con credenziali verificate anche quando il tentativo precedente ha lasciato la connessione in errore; connessioni in pausa, revocate o da riautenticare restano bloccate e lo stato torna collegato soltanto dopo un completamento riuscito.

## 0.5.32

- La verifica finale delle fatture Aruba conserva il Paese del destinatario: i privati esteri con placeholder `99999999999`, nome, data e totale coincidenti vengono collegati deterministicamente anche quando l’indirizzo è traslitterato o Aruba usa quello di spedizione; i conflitti di profilo già falliti vengono ritentati, mentre identificativi reali e Paesi discordanti restano bloccati.

## 0.5.31

- I conflitti eBay già registrati vengono chiusi automaticamente quando lo stesso payload provider permette di ricostruire deterministicamente un rimborso prima ambiguo; qualsiasi variazione del dato grezzo, dell’identificativo o degli altri dati d’ordine resta bloccata.
- Il PostgreSQL sintetico usa un processo init dedicato, così le prove di backup e restore non possono più riavviare il database condiviso durante i gate locali.

## 0.5.30

- I bonifici Shopify pagati con un arrotondamento positivo massimo di due centesimi restano riconciliati al totale ordine senza aumentare l’importo fatturabile; eccedenze superiori, sottopagamenti e altri metodi continuano a richiedere verifica.
- I rimborsi eBay che restituiscono esattamente una seconda spedizione pagata per errore vengono ricostruiti dalle quote di consegna delle righe, mentre i casi non univoci restano bloccati; le fatture Aruba già approvate impediscono inoltre la riapertura di controlli duplicati sugli stessi ordini.
- L’avanzamento ordinario dell’evasione Shopify non genera più un conflitto quando dati economici e anagrafici sono invariati; per i clienti italiani privi di identificativo, il replay può recuperare l’unico CF o la P.IVA disponibile da un altro ordine con lo stesso cliente sorgente e profilo coincidente, senza usare valori discordanti.
- La riconciliazione Aruba interpreta `99999999999` come placeholder convenzionale per i privati esteri e non come una vera partita IVA, mantenendo obbligatoria l’identità fiscale quando il documento dichiara un identificativo reale.

## 0.5.29

- La sincronizzazione Aruba riconosce in ogni scansione sovrapposta un conflitto fiscale immutabile già registrato soltanto quando coincide l’impronta del payload corrente, evitando che la deduplicazione globale interrompa i giri successivi senza allentare i controlli su collisioni nuove o mutate.

## 0.5.28

- La sincronizzazione incrementale Aruba e la rilettura dei documenti non terminali si alternano in base al flusso rimasto più indietro, impedendo che un singolo documento in elaborazione blocchi indefinitamente l'acquisizione delle nuove fatture.

## 0.5.27

- In `Ordini → Da fatturare`, l’elenco delle preparazioni precede l’approvazione in blocco, così la selezione dei documenti resta contestualizzata dal lavoro disponibile; i tooltip della sidebar desktop compressa rimangono interamente visibili sopra il contenuto della pagina.

## 0.5.26

- I privati italiani eBay con Codice Fiscale formalmente valido, intestazione utilizzabile e indirizzo completo non restano più bloccati quando nome e CF non sono coerenti: Hub Fatture applica automaticamente una deroga anagrafica tracciata, conserva immutato lo snapshot del provider e rivaluta la decisione quando cambia l’identità sorgente.
- La migrazione rilegge gli ordini eBay già presenti per applicare la stessa regola ai controlli esistenti; dati obbligatori mancanti e ogni altra anomalia continuano a richiedere revisione, mentre il test PostgreSQL seriale dispone di un timeout coerente con il carico reale senza ridurre le asserzioni.

## 0.5.25

- Le preparazioni approvabili escludono in modo fail-closed qualsiasi ordine già collegato a una fattura approvata; il reimport conserva lo stato `INVOICED` e l’upgrade chiude con audit le preparazioni ricreate, senza modificare i documenti fiscali esistenti.

## 0.5.24

- Il dettaglio dei privati italiani eBay consente a un amministratore di accettare una deroga anagrafica quando nome e cognome non sono controverificabili in modo univoco dal Codice Fiscale; l'eccezione è vincolata all'identità sorgente esatta, riallinea automaticamente soltanto ordini e preparazioni non emessi, conserva immutati i dati grezzi del provider e riapre la verifica se intestazione o identificativo fiscale cambiano.
- Il gate PostgreSQL locale esegue le suite dello stesso worktree in serie, evitando esaurimenti di memoria e timeout da contesa sul database sintetico senza ridurre la copertura dei 54 scenari.

## 0.5.23

- La Dashboard e l’approvazione massiva includono le preparazioni `READY` con proposta server-side valida anche quando non è stata salvata una bozza invariata; pagamenti pendenti, differenze, proiezioni obsolete e inventario Aruba non sano restano esclusi o bloccanti.

## 0.5.22

- Il riallineamento eBay considera una differenza limitata all’e-mail anche quando il provider rappresenta lo stesso recapito assente come campo omesso oppure `null`, chiudendo il falso mismatch senza alterare dati fiscali, anagrafici o correzioni manuali.

## 0.5.21

- La riconciliazione Aruba collega automaticamente una sola TD01 quando codice fiscale italiano, data e totale fatturabile identificano un unico ordine, mantenendo ambigui i casi con collisioni e richiedendo un secondo segnale per la sola P.IVA; i metadati equivalenti non generano più divergenze artificiali e i casi incerti restano fail-closed.
- La rilettura eBay riallinea automaticamente le variazioni limitate all’e-mail su preparazioni non emesse e completa nome e cognome soltanto quando un Codice Fiscale valido orienta univocamente le due parti, conservando correzioni manuali, audit e revisione per ogni altra differenza.
- In `Controlli` è possibile dichiarare che nessun candidato Aruba è corretto anche quando esistono proposte, con attestazione esplicita e registrazione dei candidati scartati; collegamento e rifiuto restano decisioni singole, senza azioni massive.

## 0.5.20

- Su mobile, la selezione di un controllo apre subito una vista di dettaglio dedicata invece di lasciarla dopo l’intera coda; il ritorno alla lista conserva filtri, posizione di scorrimento e focus sul controllo scelto, mentre i collegamenti diretti mantengono una via di ritorno coerente.
- Su desktop, coda e dettaglio restano affiancati e la selezione continua a preservare la posizione corrente.

## 0.5.19

- Nella sidebar desktop compressa l’icona di `Controlli` torna sulla stessa colonna delle altre destinazioni; il badge del conteggio è più piccolo e resta ancorato in basso a destra senza modificare l’allineamento della voce.

## 0.5.18

- `Controlli` ricalcola le preparazioni e le anagrafiche sulle sole cause ancora azionabili, separa le anomalie concrete per totale, cliente, aggiornamento sorgente e fatturabilità e chiude i segnali generici o duplicati quando la fonte non richiede più un intervento, mantenendo bloccanti i casi Aruba incerti.
- La selezione di un controllo conserva la posizione di scorrimento anche in WebKit; Dashboard, ricerca globale e dettagli continuano a usare la stessa identità operativa e portano direttamente alla sede in cui risolvere la causa.
- La Dashboard mobile presenta bloccanti, importanti e ordinari su righe separate e mantiene il valore complessivo leggibile anche a tre cifre; la sidebar desktop compressa riserva spazio sufficiente al badge `99+`, senza sovrapporlo all’icona di Controlli.

## 0.5.17

- La nuova sezione `Controlli` concentra in una sola coda canonica conflitti, duplicati e riconciliazioni che richiedono una decisione: ogni elemento espone gravità, causa, conseguenza, evidenze e azione diretta, mentre Dashboard, ricerca globale e pagine di dominio rimandano allo stesso controllo senza creare conteggi concorrenti.
- La Dashboard distingue il lavoro da svolgere dallo stato tecnico, allinea preparazioni approvabili, controlli da risolvere e pagamenti in attesa e mantiene il riepilogo operativo leggibile anche nel viewport mobile, senza sovrapposizioni o bordi di gravità invasivi.
- La ricerca globale conserva la copertura completa introdotta nelle versioni precedenti ma instrada i problemi azionabili soltanto in `Controlli`; l’inventario Aruba resta neutro, ricercabile e paginato, e le risposte incompatibili durante un deploy degradano a un errore controllato.
- I gate PostgreSQL ed end-to-end usano un database sintetico distinto per worktree e serializzano le esecuzioni dello stesso checkout, eliminando i reset di schema causati da suite concorrenti e trasformando le cadute della connessione in errori diagnostici espliciti.

## 0.5.16

- Le schede già aperte durante un deploy continuano a ricevere il campo fatture atteso dal bundle precedente, evitando che una ricerca trasformi la pagina in un errore.
- Il client valida il contratto completo della ricerca prima di renderizzarlo e mostra un errore controllato se server e bundle non coincidono, senza interrompere la Dashboard.

## 0.5.15

- La ricerca globale copre ordini, fatture, note di credito, clienti, attività da gestire, cronologia e documenti Aruba da collegare, con conteggi completi e collegamenti alle viste filtrate quando l’anteprima non contiene tutti i risultati.
- `Attività → Da gestire` e `Documenti → Da collegare` diventano ricercabili sull’intera coda; i documenti Aruba sono paginati senza il precedente tetto implicito e restano visibili anche prima della creazione di una riga di match.
- L’archivio Documenti trova anche e-mail, telefono, identificativi fiscali e ordini collegati; la Cronologia usa il formato temporale corretto senza interrompere il pannello di ricerca.

## 0.5.14

- Production conserva come baseline ogni deployment già riuscito anche dopo la transizione automatica di GitHub a `inactive`, evitando riclassificazioni cumulative e backup pre/post non richiesti da migrazioni o modifiche allo storage.
- Gli allarmi prudenziali del monitor locale continuano a essere notificati e restano bloccanti nel timer, ma non retrocedono un deploy dopo che digest, servizi, health check e ricevuta sono già stati verificati.

## 0.5.13

- L’interfaccia usa un sistema di movimento condiviso per navigazione, pannelli, tabelle, controlli e messaggi, con transizioni brevi che rendono più immediati stato attivo, pressione e cambio pagina senza modificare la gerarchia visiva Foundation.
- Ricerca globale, menu mobile, profilo e contenuti espandibili hanno entrate e uscite coordinate; la ricerca conserva il pannello durante l’uscita, restituisce correttamente il focus e disattiva animazioni e attese quando è richiesta la riduzione del movimento.

## 0.5.12

- La directory clienti aggrega ordini, pratiche e documenti in un solo passaggio per tabella invece di ripetere le stesse scansioni per ogni cliente; sul benchmark sintetico ripetibile da 1.000 clienti il tempo mediano scende da 372,7 ms a 19,3-22,4 ms, mantenendo invariati filtri, conteggi e ordinamento.

## 0.5.11

- La validazione dei file XML Aruba applica i limiti di profondità e numero elementi con uno scanner lineare pre-DOM che conta anche i nomi Unicode, impedendo strutture complesse oltre soglia senza alterare XML FatturaPA, namespace, commenti o CDATA legittimi.

## 0.5.10

- Shopify ed eBay supportano gli ordini con cliente svizzero come destinatario extra-UE distinto dai clienti UE, riusando il profilo fiscale del margine e il tracciato estero FatturaPA già validato.
- Dashboard e Impostazioni mantengono il canale visibilmente collegato quando fallisce l’importazione di un ordine, mostrano separatamente l’errore di sincronizzazione e riservano `Non collegato` alle credenziali assenti, revocate o da rinnovare.
- L’upgrade riavvolge il cursore dal primo payload non riconosciuto e rende nuovamente schedulabili i canali bloccati, così gli ordini svizzeri precedentemente rifiutati vengono riletti.

## 0.5.9

- La scheda Aruba in Dashboard distingue lo stato tecnico della connessione e della sincronizzazione dalle verifiche di riconciliazione: segnala pause, errori, sincronizzazioni ferme o mai eseguite, mentre le fatture da verificare restano nel riepilogo operativo dedicato.

## 0.5.8

- Una preparazione con un possibile documento Aruba offre l’azione diretta `Collega fattura Aruba` e apre soltanto le fatture candidate pertinenti, mantenendo la conferma manuale motivata e senza forzare il collegamento.
- La vista mobile dei documenti da collegare elimina l’intestazione vuota, rende sempre visibili le viste, presenta etichette e azioni in schede leggibili e conserva spazio sicuro sopra i controlli del browser.

## 0.5.7

- Gli ordini eBay già importati vengono riletti una sola volta con il mapper che sottrae gli sconti di consegna, così righe, spedizione e totale tornano riconciliati anche per le preparazioni storiche.

## 0.5.6

- Una pagina Aruba può consolidare più osservazioni sulla stessa identità locale soltanto quando il medesimo run registra un conflitto fiscale irrisolto; conteggi, completezza dei file e cardinalità delle osservazioni restano verificati prima del checkpoint.

## 0.5.5

- La sincronizzazione Aruba conserva il documento già archiviato quando il provider ripropone la stessa identità fiscale con totale o XML diversi, registra il conflitto fiscale immutabile e prosegue con le altre fatture senza attribuire i nuovi file al documento precedente.
- La rivalutazione dei match memorizzati avviene una sola volta alla chiusura atomica del giro Aruba, dopo tutte le finestre acquisite e prima del ricalcolo delle pratiche.

## 0.5.4

- I documenti Aruba già emessi con data e totale esatti restano disponibili per una verifica manuale motivata quando l’identità è parziale, senza trasformare un indizio in un collegamento automatico; i match memorizzati vengono rivalutati dopo una sincronizzazione o una correzione locale.
- Gli ordini eBay sottraggono gli sconti di spedizione dal costo di consegna, con controlli su valuta e importi non validi, evitando differenze artificiali fra totale sorgente e righe fatturabili.

## 0.5.3

- Il runtime elimina definitivamente tabelle, colonne, facciate ed export del precedente percorso browser Aruba: API e import manuale restano gli unici proprietari delle rispettive capacità, con provenienza storica conservata soltanto per l’audit.
- Connettori, import ordini, riconciliazione Aruba e documenti separano connessioni, job, webhook, materializzazione, approvazioni e archiviazione in moduli con dipendenze esplicite, senza mantenere barrel o compatibilità interne inutilizzate.
- Impostazioni, fogli di stile e scenari di test sono partizionati per responsabilità; un ratchet blocca la ricomparsa di monoliti, moduli server orfani e percorsi legacy, mentre i controlli TypeScript rifiutano simboli e parametri inutilizzati.

## 0.5.2

- Le tre modalità Aruba usano nomi espliciti e coerenti che distinguono la creazione del documento, la conferma prima dell’invio e l’invio automatico successivo all’approvazione, senza suggerire che l’approvazione possa essere automatica.
- Il controllo mobile delle modalità resta leggibile anche con metriche tipografiche diverse, mentre ogni retry E2E ricrea le proprie fixture per non ereditare lo stato del tentativo fallito.

## 0.5.1

- La Dashboard conta separatamente ordini da verificare e pagamenti in attesa, esclude sovrapposizioni e falsi positivi già risolti, e mostra lo stato dei collegamenti in base alla freschezza dei dati realmente restituiti.
- Shopify estrae P.IVA, codice fiscale e codice destinatario da ragioni sociali italiane soltanto quando sono etichettati esplicitamente e validi, conservando la priorità dei campi strutturati e lasciando invariati valori ambigui, esteri o non verificabili.
- Su desktop ricerca globale e profilo tornano allineati al margine destro dell’intestazione senza alterare la navigazione mobile.

## 0.5.0

- La transizione Aruba è chiusa sul treno corretto: API unica autorità automatica, fallback manuale presidiato e nessuna istruzione operativa per preferiti, bridge o helper nel runtime e nella documentazione corrente.
- Il ratchet copre anche README, versione applicativa e origine dei nuovi readback manuali; le ricevute manuali non materializzano più token o identità dispositivo fittizie, mentre audit e provenienza storica `HELPER` restano consultabili.

## 0.4.9

- Su mobile la barra inferiore viene sostituita da un menu laterale animato che mostra tutte e sei le sezioni, mantiene evidente la destinazione attiva e gestisce chiusura, focus e riduzione del movimento in modo coerente su Chromium e WebKit; la sidebar desktop resta invariata.
- La ricerca globale intercetta `Esc` prima del comportamento nativo dei campi di ricerca WebKit, chiude sempre il pannello e restituisce il focus al comando di apertura anche dopo il passaggio al viewport mobile.

## 0.4.8

- La riconciliazione Aruba collega automaticamente una singola TD01 quando esiste un solo ordine forte dello stesso giorno e risolve come coorte completa le fatture altrimenti indistinguibili, mantenendo l'associazione monotona fra progressivi fiscali e cronologia degli ordini.
- Coorti incomplete, XML ufficiali mancanti, riferimenti espliciti, cardinalità non biunivoche e ordini già collegati restano fail-closed in `Da collegare` per la decisione manuale.

## 0.4.7

- Il controllo salute riconosce il FULL API qualificato prima del cutover come baseline canonica dopo il passaggio all’autorità API, senza riscrivere la provenienza storica SHADOW; freschezza, errori e conflitti successivi restano fail-closed sui giri CANONICAL.
- I nuovi worktree preparano automaticamente le dipendenze: riusano in sicurezza `node_modules` del checkout principale quando il lockfile coincide e installano un ambiente isolato con `npm ci` quando differisce.

## 0.4.6

- Aruba usa esclusivamente le API come runtime automatico: preferito, bridge, helper, scansioni browser, endpoint, token, workflow e UI correlati vengono rimossi, conservando soltanto audit e provenienza storica e il fallback manuale sui file ufficiali.
- Dashboard e Attività contano azioni umane effettive, escludono valori obsoleti dai totali operativi e aggiornano lo stato dei connettori senza moltiplicare un singolo problema provider per tutte le preparazioni coinvolte.

## 0.4.5

- La validazione differita delle note di credito ignora una bozza transitoria già eliminata nella stessa transazione di riconciliazione Aruba, ma continua a bloccare ogni nota persistente che non quadra con ordini e rimborsi collegati.

## 0.4.4

- La rilettura mirata Aruba congela l’elenco dei gruppi, consolida ciascun gruppo separatamente e riprende dal primo checkpoint non completato dopo un errore provider, senza rileggere né perdere le pratiche già acquisite e senza dipendere dal browser.

## 0.4.3

- La parità Aruba considera divergenza di file soltanto evidenze ufficiali presenti su entrambe le fonti e incompatibili: l'assenza di file nel vecchio baseline browser non blocca più il cutover quando l'API dispone del payload ufficiale, la cui completezza resta verificata dal gate dedicato.

## 0.4.2

- L’inventario API Aruba usa come confine permanente il 1° luglio 2026: la prima scansione completa e le full mensili non rileggono periodi anteriori, mentre gli incrementali mantengono la sovrapposizione senza oltrepassare il confine e i dati storici già acquisiti restano conservati.
- Il dossier confronta API, baseline browser e conflitti soltanto sulla popolazione temporale comune dal 1° luglio 2026, evitando divergenze prodotte da documenti intenzionalmente fuori perimetro; una continuazione precedente al nuovo confine non viene ripresa.

## 0.4.1

- Il backfill e le scansioni complete Aruba ricavano e persistono l’identità fiscale dai byte XML/P7M anche nei gruppi con più fatture, senza invalidare il dossier quando un incrementale shadow successivo completa; la parità usa una popolazione temporale comune e resta fail-closed sui conflitti browser.
- Il passaggio atomico all’autorità API ritira il preferito come fonte automatica e accoda una riconciliazione canonica mirata che rilegge con file e notifiche ufficiali anche i documenti terminali ancora `Da verificare`, senza trasformare date e importi in collegamenti automatici.
- Il report di chiusura distingue preparazione, finalizzazione e chiusura effettiva: M9 risulta chiusa soltanto dopo audit del cutover, job canonico completato, nessuna attività o errore operativo e zero verifiche Aruba irrisolte.

## 0.4.0

- Il backfill API Aruba cede il worker dopo ogni pagina consolidata, conserva il checkpoint e riprende dalla coda senza consumare tentativi; i job operativi non restano più bloccati dietro una scansione storica lunga e lo stop Production concede fino a tre minuti per completare la pagina in corso.
- Massimo può qualificare una sola verifica Aruba Production `dryRun=true` per un documento e un manifest esatti, mentre l’invio resta globalmente disabilitato. Il permesso scade, viene consumato prima della chiamata e non può essere riusato; un’interruzione dopo l’avvio produce uno stato remoto incerto e richiede readback, senza retry automatico.
- La qualifica richiede un consenso esplicito accessibile e idempotente, verificato in Chromium e WebKit. I comandi E2E standalone ricostruiscono sempre il bundle prima del collaudo, evitando risultati riferiti a una build precedente.

## 0.3.97

- La superficie web Production integra manifest, favicon SVG con fallback PNG, icona Apple Touch, pinned tab Safari e metadati standalone per una migliore esperienza su browser desktop e mobile, mantenendo titoli specifici per pagina.
- La non indicizzazione viene ribadita anche dal reverse proxy con `X-Robots-Tag`; `robots.txt`, meta `noindex` e autenticazione restano invariati e non vengono introdotti sitemap, canonical o dati strutturati pubblici.

## 0.3.96

- Il Caddy condiviso conserva i virtual host root-owned degli altri servizi autorizzati e la rete pubblica esterna anche dopo un deploy Hub Fatture; il preflight blocca directory, permessi o rete divergenti, evitando che la rigenerazione di Compose e Caddyfile renda irraggiungibile un servizio coesistente.

## 0.3.95

- Il mapper API Aruba normalizza i totali provider con segno alla rappresentazione monetaria interna non negativa, coerente con il readback browser e con i vincoli del dominio, evitando che una fattura storica con totale API negativo interrompa il backfill. Una regressione copre il caso osservato in Production.

## 0.3.94

- Il retry manuale di un backfill Aruba fallito continua dal checkpoint consolidato e conserva documenti, file e notifiche shadow già validati, invece di riavviare lo storico dal 2019. La continuazione resta fail-closed e mantiene autorità browser, limiti API e audit del job.
- Il test del rate limit misura l’intervallo di lettura usando l’orologio applicativo, evitando falsi errori quando PostgreSQL nel container ha uno scarto temporale rispetto al processo Node.

## 0.3.93

- Il backfill Aruba può usare temporaneamente un intervallo prudente di 5,2 secondi fra le letture, restando sotto il limite documentato di 12 richieste al minuto per canale. Il valore predefinito resta 6,1 secondi, la configurazione rifiuta valori fuori dall’intervallo sicuro e conserva coordinamento PostgreSQL, singolo giro canonico e cooldown condiviso sui `429`.
- Il readback Production registra l’intervallo effettivo del worker senza modificare il blocco degli invii Aruba.

## 0.3.92

- L’immagine applicativa usa Debian 13 Trixie Slim in tutti gli stage, mantenendo Node 26.7.0 e npm 12.0.2 negli stage di build. Base e repository APT restano immutabili tramite digest e snapshot, mentre il runtime continua a eseguire come utente non-root senza npm, npx o strumenti di build; host Ubuntu, Caddy e PostgreSQL non cambiano.

## 0.3.91

- Il backfill Aruba accetta i P7M storici validi secondo lo schema ufficiale FatturaPA anche quando la numerazione non segue la serie interna corrente; XML non fiscali, contenitori P7M non validi e documenti fuori schema restano bloccati.

## 0.3.90

- Le Impostazioni distinguono i tentativi Aruba storici dagli errori ancora operativi, mostrano undici verifiche tecniche fail-closed e un’anteprima sanitizzata dei documenti che, dopo il backfill, dispongono di firma API unica e file ufficiale per una rilettura mirata.
- Un report read-only raccoglie commit, schema, ultimo giro, dossier, gate e riconciliazione senza contattare Aruba né modificare il database. Backup e ripristino sintetici verificano la credenziale cifrata e i checkpoint su database isolati.
- Il percorso canonico e il passaggio atomico all’API sono preparati ma non esposti nell’interfaccia: richiedono storico completo, parità, file, notifiche, assenza di conflitti e una futura decisione esplicita del titolare sul fallback. Il browser resta autorevole e upload, dry-run e invii Aruba rimangono disabilitati.
- La parità confronta la stessa impronta fiscale quando un canale espone l’XML e l’altro il contenitore P7M; gli snapshot shadow precedenti con P7M vengono invalidati e ricalcolati senza riusare evidenze non normalizzate. Nel giro canonico il P7M originale resta archiviato, mentre il suo XML fiscale validato alimenta riconciliazione e documento operativo.

## 0.3.89

- La lettura Aruba coordina in PostgreSQL limiti prudenti e separati per inventario e notifiche fra processi e istanze; le autenticazioni restano serializzate e ogni `429` applica una pausa di sicurezza condivisa di 65 minuti, evitando raffiche causate da worker duplicati, riavvii o configurazioni concorrenti della VPS senza confondere i Tier di invio con le API di lettura.
- Le Impostazioni mostrano l’avanzamento del backfill dai checkpoint consolidati, con finestre residue e stima indicativa, e distinguono gli errori operativi attuali da quelli storici già superati.
- Il dossier di parità espone copertura, assenze e divergenze nei due versi; i gate di recovery verificano con dati sintetici che backup e ripristino preservino credenziale cifrata e checkpoint. L’autorità resta al browser e questa release non abilita upload o invii Aruba.

## 0.3.88

- Dopo il collegamento Aruba, le Impostazioni mostrano una sintesi compatta e montano il modulo soltanto quando Massimo sceglie di aggiornare le credenziali; nome utente e identità fiscale vengono ripristinati dal dato cifrato, mentre la password non viene mai restituita.
- Il dossier inbound confronta lo snapshot browser esatto, separa la copertura di XML, P7M, PDF e notifiche e resta divergente in presenza di conflitti browser irrisolti, senza confondere file non acquisibili dal browser con differenze di parità.
- I tentativi Aruba rifiutati non occupano più l’identità fiscale del tentativo successivo: entrambi restano nello storico, i tentativi validi conservano l’unicità e i vecchi conflitti vengono riconciliati senza collegamenti forzati.

## 0.3.87

- Il backfill API Aruba conserva come sconosciuto il Paese destinatario assente nei dettagli storici, senza dedurre `IT` dagli identificativi fiscali, e prosegue la lettura shadow di documenti, file e notifiche.

## 0.3.86

- Il backfill API Aruba usa la data principale quando una notifica storica restituisce `notificationDate` vuota e aggiorna in modo deduplicato i contatori di file e notifiche realmente osservati nel giro shadow.

## 0.3.85

- Il backfill API Aruba accetta il `channelGroup` nullo restituito dai dettagli storici Production, mantenendo il rifiuto di tipi diversi e proseguendo l’acquisizione read-only di XML, PDF e notifiche.

## 0.3.84

- Il backfill API Aruba riconosce la sentinella documentata dal comportamento Production per una finestra storica vuota, normalizzandola come pagina 1 terminale senza allentare i controlli su pagine non vuote o metadati incoerenti.

## 0.3.83

- I campi delle credenziali Aruba partono dalla stessa quota anche quando un testo di aiuto va a capo; tutti i pannelli della sezione usano inoltre lo stesso distacco verticale su desktop e mobile.
- Dopo la verifica dell’accesso, pausa e sincronizzazione diventano controlli compatti con checkbox native e azioni a larghezza naturale. La revoca resta separata e riconoscibile senza ereditare le dimensioni dei normali campi del modulo.

## 0.3.82

- Le Impostazioni Aruba identificano esplicitamente le credenziali del pannello di Fatturazione Elettronica, distinguendole dall’account e-mail Aruba e chiarendo verifica, cifratura e identità fiscale attesa.
- Il riepilogo della lettura automatica accorpa le otto tessere in sei senza perdere stato, parità, storico, checkpoint o limiti; campi, azioni e sincronizzazione recuperano una spaziatura coerente anche su schermi stretti grazie al token di layout valido condiviso.

## 0.3.81

- Dopo ogni deploy riuscito, la VPS conserva soltanto le immagini Hub Fatture live e di rollback e quelle ancora referenziate da container; la selezione usa il label OCI del repository e fallisce se un’identità protetta non è disponibile.
- Deploy Hub Fatture e build o manutenzioni Docker Sequent condividono un lock host, evitando che operazioni concorrenti sul motore Docker saturino o alterino lo storage comune.

## 0.3.80

- La connessione Aruba API verifica l’identità prima di cifrare la credenziale, parte in pausa e riserva a Massimo configurazione, rotazione, revoca e attivazione; Codex mantiene la sola lettura operativa e il comando “Sincronizza ora”. Il cambio dell’autorità non è esposto e richiederà una futura autorizzazione esplicita.
- Il worker acquisisce in sola lettura lo storico del ciclo attivo con finestre da 48 ore, checkpoint per pagina, tetto fail-closed di 10.000 richieste per giro, limiti provider condivisi, ripresa dopo errori transitori, incrementale con sovrapposizione, rilettura dei non terminali e scansione completa mensile.
- XML o P7M, PDF e notifiche vengono validati e confrontati per hash in giri shadow separati dall’inventario browser; nei gruppi multipli ogni notifica deve identificare una sola fattura tramite il numero provider. Il dossier richiede correlazione biunivoca e zero differenze di stato o file; una pausa terminalizza il giro attivo e l’esaurimento del budget crea una continuazione dallo stesso checkpoint.
- Dashboard, Impostazioni e Attività espongono salute, avanzamento, checkpoint ed errori senza mostrare credenziali o dati Premium. Upload, dry-run e invio Aruba restano assenti e l’autorità browser non cambia con il deploy.

## 0.3.79

- La pubblicazione avvia Production subito dopo il merge autorizzato e lascia al workflow l’attesa dei gate exact-SHA e dell’artefatto, eliminando conferme Environment duplicate senza trasformare ogni merge in un deploy automatico.
- Il preflight locale classifica il diff e limita gate, browser e verifiche multipiattaforma alle superfici coinvolte; setup npm e Playwright riusano cache e installano soltanto ciò che serve.
- Il gate Codex reagisce agli eventi della review, mantiene P0/P1 bloccanti e risolve automaticamente soltanto i thread inline P2/P3 già registrati sull’HEAD esatto.
- Dopo un readback Production riuscito, il workflow pubblica in modo idempotente la GitHub Release immutabile con note di versione e manifest verificato di commit, immagine, rollback, schema e attestazione.

## 0.3.78

- La qualifica read-only Aruba v2 distingue gruppi API e documenti, verifica la paginazione completa della finestra autorizzata e restituisce soltanto conteggi sanitizzati per tipi e stati canonici.
- Il contratto fail-closed copre stati documentati, forme di dettaglio, file e notifiche, limiti tecnici e risposta `429`; Tier e contatori Premium restano fuori dal prodotto e non vengono letti né mostrati.
- Un comparatore shadow correla soltanto identificativi remoti nello stesso namespace o identità fiscali complete, senza dedurre serie mancanti né dichiarare parità fra finestre temporali non allineate. Backfill, file reali e autorità inbound restano nella fase successiva.
- I comandi locali per test database ed E2E avviano e attendono automaticamente PostgreSQL quando `TEST_DATABASE_URL` non è già configurato; gli ambienti CI continuano a usare il database esplicito fornito dal gate.

## 0.3.77

- Il piano canonico adotta le API Aruba v2 come destinazione primaria per il ciclo attivo, con inbound, outbound, credenziali cifrate, modalità di trasmissione, arresti indipendenti, fallback manuale e gate Production distinti.
- La roadmap separa qualifica read-only, inventario API, outbound senza invio, decisione su preferito/bridge e helper Playwright, ricertificazione, canary TD01 monouso e go-live. Nessun componente browser viene ritirato senza un dossier di parità e una decisione esplicita.
- Un probe locale rigorosamente read-only verifica host, identità fiscale, stato account, schema e limiti di paginazione senza scaricare file né esporre credenziali. La sola prova Production osservata resta registrata con il suo limite effettivo; le qualifiche non ancora eseguite non sono dichiarate concluse.

## 0.3.76

- Il preferito Aruba importa durante la sincronizzazione soltanto gli XML ufficiali che Hub Fatture richiede. Il ponte trasferisce i byte senza esporre cookie o credenziali Aruba, applica il limite dimensionale condiviso e continua a funzionare con il preferito già salvato.
- La ricerca preliminare tollera fino a tre giorni tra ordine e documento e ignora i comuni titoli personali nel nome. Questi segnali servono esclusivamente a richiedere l’XML e a sospendere prudentemente la preparazione: i metadati della griglia non possono più creare un collegamento automatico definitivo.
- L’XML ufficiale diventa il gate esplicito del matcher automatico. Dopo ogni import, match, documento e stato della preparazione vengono ricalcolati nella stessa transazione, così Dashboard e Attività riflettono subito la riconciliazione senza un secondo passaggio manuale.

## 0.3.75

- La sincronizzazione Aruba riconosce come candidati anche i documenti della griglia che coincidono in modo univoco per data, importo e nome completo del destinatario, pur senza considerarli fiscalmente collegati finché manca l’XML ufficiale. Le preparazioni coinvolte passano da “Pronte” a “Da verificare”; più candidati equivalenti restano ambigui.
- All’avvio della sincronizzazione Hub Fatture rivaluta in modo selettivo i dati già estratti dal preferito, senza rileggere documento per documento l’intero inventario. La versione del matcher resta coerente anche quando una scansione completa segnala un documento non più visibile.
- Il dettaglio della preparazione indica esplicitamente quando la verifica dipende da una possibile fattura già presente su Aruba e rimanda ai documenti da collegare. Importo o nome generico, da soli, non producono alcun candidato.

## 0.3.74

- La sincronizzazione Aruba usa una finestra incrementale di sette giorni dopo il primo allineamento e ripete la lettura completa ogni trenta giorni. Prima di ogni ciclo l’helper rilegge il piano corrente; prima di interrompere una lettura incrementale imposta e verifica l’ordinamento Aruba per data documento decrescente ed estende la finestra fino alla verifica puntuale più vecchia. Questa versione forza una sola rilettura completa per riclassificare lo storico con il nuovo interprete degli stati; le esecuzioni successive tornano incrementali.
- Gli stati effettivi mostrati da Aruba, inclusi “Emessa e consegnata” ed “Emessa e non cons.”, vengono tradotti nello stato operativo corretto invece di generare verifiche irrisolte generiche. Il testo originale resta disponibile per la diagnosi e una concentrazione anomala di stati sconosciuti interrompe la lettura senza considerarla allineata.
- Un errore di account precedente non resta più visibile dopo una sincronizzazione completata; quando l’inventario è aggiornato ma contiene conflitti, le Impostazioni distinguono chiaramente le verifiche documentali da un errore di collegamento.
- I pulsanti di dettaglio nelle tabelle Attività centrano testo e icona nello spazio disponibile, eliminando lo sbilanciamento laterale condiviso dalle azioni tabellari.

## 0.3.73

- Il preferito Aruba mantiene il riferimento alla finestra Hub Fatture nel contesto che l’ha aperta e offre al lettore un relay locale filtrato. Il runtime non trasferisce più il `WindowProxy` tra script, eliminando il timeout osservato su Chrome dopo il caricamento corretto del lettore.
- La regressione rende intenzionalmente inutilizzabile il vecchio riferimento globale e completa comunque il collegamento cross-origin. Poiché cambia il codice statico del preferito, dopo il deploy quello salvato va sostituito una volta con il nuovo pulsante “Sincronizza Aruba”.

## 0.3.72

- Il preferito Aruba non usa più canali trasferibili tra finestre, che sul pannello reale potevano non arrivare e lasciare il messaggio fermo su “Collegamento sicuro a Hub Fatture…”. Lettore e ponte comunicano direttamente verificando a ogni messaggio origine, finestra mittente e operazione consentita.
- La regressione disabilita esplicitamente `MessageChannel` e completa il collegamento sia in Chromium sia in WebKit, anche con il vero ponte applicativo. Il preferito già installato carica automaticamente il lettore corretto e non deve essere sostituito.

## 0.3.71

- Il ponte Aruba consegna il lettore, attende la sua conferma esplicita e verifica il canale in entrambe le direzioni prima di creare la sessione server. Un collegamento incompleto non lascia più una sessione orfana che blocca i tentativi successivi.
- I timeout del canale e della risposta server hanno ora codici e messaggi distinti. Il preferito già installato continua a caricare automaticamente il lettore corrente e non deve essere sostituito.

## 0.3.70

- Dopo l’avvio, il lettore e il ponte Aruba comunicano tramite un canale dedicato del browser: le richieste non dipendono più dall’identità della finestra cross-origin che lasciava il messaggio fermo su “Collegamento sicuro a Hub Fatture…”.
- Il preferito già installato continua a caricare automaticamente il lettore corrente. La regressione rifiuta il vecchio trasporto tra finestre e verifica il canale dedicato con due avvii su Chromium e WebKit.

## 0.3.69

- Il riepilogo della preparazione usa una sola gerarchia visiva: dati sintetici, ordini e azione occupano tutta la larghezza utile senza colonne sbilanciate, mentre campo e pulsante restano allineati su desktop e si impilano senza overflow su mobile.
- Il registro mantiene evento, nota e data in colonne coerenti. I separatori recuperano inoltre la spaziatura prevista sostituendo il token inesistente che annullava il distacco sopra “Ordini inclusi” e nelle conferme delle revisioni.

## 0.3.68

- La finestra di collegamento risponde una sola volta ai segnali ravvicinati e la pagina Aruba consente una sola copia attiva del lettore, impedendo che più clic si contendano le stesse risposte e restino in attesa.
- Dopo un errore il lettore chiude automaticamente il ponte, così il tentativo successivo carica sempre il codice corrente; le regressioni eseguono davvero due avvii e verificano l’unicità della richiesta e la chiusura sui due motori browser.

## 0.3.67

- Il lettore Aruba riusa direttamente il collegamento già autorizzato dal preferito, senza avviare un secondo handshake che sul ponte reale restava in attesa fino alla scadenza.
- La regressione usa un ponte che consegna il lettore una sola volta, così i test non possono più mascherare duplicazioni del collegamento.

## 0.3.66

- Le preparazioni aprono subito i dati del destinatario e della fattura, dispongono i campi su più colonne quando lo spazio lo consente e mantengono centrato il comando “Apri preparazione” senza vuoti laterali sbilanciati.
- I pannelli Aruba e approvazione hanno altezze coerenti negli stati compatti; quando l’approvazione contiene il riepilogo completo, ogni pannello usa invece tutta la larghezza utile. Il registro attività distribuisce gli eventi orizzontalmente su desktop e torna a una colonna su mobile, eliminando sia grandi interruzioni vuote sia testi eccessivamente compressi.

## 0.3.65

- Il preferito Aruba carica il lettore corrente da Hub Fatture a ogni avvio: dopo la sostituzione una tantum, le correzioni future non richiedono più di cancellarlo e aggiungerlo di nuovo.
- Il ponte autenticato consegna il lettore soltanto alla pagina Aruba attesa e continua a non salvare credenziali Aruba o token nel preferito.

## 0.3.64

- La sincronizzazione non dipende più da un nome account che Aruba non mostra nel pannello: prima di importare, verifica l’account confrontando i documenti letti con l’identità fiscale immutabile già acquisita.
- Le pagine restano fuori dall’inventario finché il controllo dell’account non riesce; un account diverso viene respinto senza scrivere documenti e la diagnosi indica ora la causa reale.

## 0.3.63

- La preparazione fattura porta subito ai controlli essenziali e all’approvazione: il numero viene assegnato automaticamente soltanto con “Approva fattura”, mentre il salvataggio compare quando i dati vengono modificati.
- Dati cliente, modifica fattura, confronto e XML restano disponibili in sezioni espandibili; titoli, riepilogo finale e comandi rimangono dentro i rispettivi box anche su schermi stretti.
- La sincronizzazione Aruba resta un’attività separata in Dashboard e Impostazioni; durante la preparazione viene mostrato soltanto l’eventuale avviso che impedisce l’approvazione.
- La conferma esplicita del pulsante sostituisce il checkbox ridondante e il controllo Aruba viene riletto atomicamente prima della numerazione.

## 0.3.62

- Il preferito riconosce il vero controllo data di Aruba e prosegue quando è vuoto, senza cercare o modificare campi che nel pannello reale non esistono; un filtro attivo produce invece un’indicazione specifica.
- La paginazione usa lo stato del singolo pulsante, così percorre tutte le pagine anche quando ExtJS marca impropriamente come disabilitato il contenitore della barra.
- Il pulsante da trascinare nei preferiti usa il solo nome “Sincronizza Aruba”, senza l’icona a freccia.

## 0.3.61

- Il preferito riconosce la paginazione con cui Aruba riusa le stesse righe e aggiorna soltanto il testo, attendendo che tutte le celle della griglia siano stabili prima di importarle.
- Ogni stream azzera e applica il filtro data prima della scansione completa, evitando che un filtro precedente escluda documenti dall’inventario.

## 0.3.60

- La sincronizzazione Aruba completa tutte le pagine anche quando il pannello aggiorna la griglia tramite richieste create prima dell’avvio del preferito: attende le richieste osservabili e usa come fallback il cambio stabile dei documenti mostrati.
- Gli errori di lettura più comuni indicano ora come riprovare, senza esporre codici tecnici al posto di un’azione correttiva.

## 0.3.59

- Il preferito Aruba può avviare la sincronizzazione anche dalla Home: accompagna l’utente a Fatture inviate e acquisisce soltanto la richiesta prodotta dal clic esplicito.
- Ogni sincronizzazione di produzione riparte dalla prima pagina e legge l’intero inventario, evitando omissioni quando una scansione precedente viene interrotta o quando cambiano i confini delle pagine.
- La sessione resta viva durante caricamenti e controlli preliminari, registra in modo coerente completamenti ed errori e mantiene separati gli account e i dispositivi collegati.

## 0.3.58

- La sincronizzazione in sola lettura Aruba si avvia da un preferito del browser su Safari, Chrome o Edge, senza installare Node, npm o un’app locale e senza conservare token permanenti.
- Le Impostazioni guidano il collegamento e l’aggiornamento dell’inventario con meno box, stato compatto e una modalità Aruba proporzionata, mantenendo testi e comandi leggibili su desktop e mobile.
- Ogni avvio crea automaticamente una sessione temporanea confinata all’account autenticato; l’helper di invio resta separato, limitato a Chrome/Edge e non viene attivato dalla sola lettura.

## 0.3.57

- Le sessioni di lettura Aruba congelano atomicamente stream e finestra di riconciliazione prima di restituire il token, includono il possibile passaggio d’anno e conservano lo stato `INCOMPLETE` quando la copertura non è dimostrabile.
- I download dei file ufficiali interrompono lo streaming oltre il limite prima della materializzazione completa; runner, route e test usano un unico percorso bounded senza implementazioni legacy parallele.
- Le fatture storiche Aruba restano riapribili dalle righe dello snapshot immutabile e dall’XML archiviato, mentre gli input manuali non validi mantengono un errore di dominio esplicito.

## 0.3.56

- Dashboard e Attività mostrano soltanto gli errori di sincronizzazione ancora azionabili: un readback completo riuscito supera i tentativi precedenti e webhook e job derivato non vengono più contati due volte, mentre lo storico resta conservato per audit e retention.

## 0.3.55

- I comandi di sola lettura Aruba spiegano ora effetto e limiti prima dell’azione; il readback manuale resta visivamente separato e i pulsanti su mobile mantengono spazio verticale anche quando il testo va a capo.

## 0.3.54

- Le commissioni Shopify Payments espresse nella valuta di presentazione vengono convertite nella valuta dell’ordine usando esclusivamente il tasso di regolamento della stessa transazione, con controlli fail-closed e un solo arrotondamento finale.

## 0.3.53

- Le Impostazioni Aruba separano correttamente i tre comandi operativi, mantenendo spaziatura coerente anche quando vanno a capo.

## 0.3.52

- La ricevuta di ogni backup include commit, versione applicativa, digest immagine, schema DB e motivo, oltre a checksum e dimensione già verificati su OCI.
- La corsia Production può creare un backup del solo candidato live senza ridistribuirlo e rifiuta ricevute che non coincidono con commit, versione o schema attesi.
- La readiness registra separatamente la ripresa del profilo Chrome Aruba persistente, senza nuovo login né azioni sul provider.

## 0.3.51

- Le Impostazioni separano i documenti Aruba senza un ordine Shopify/eBay dalle ambiguità e dai conflitti che richiedono una verifica.
- Un documento non collegato ma con un riferimento ordine esplicito incompatibile resta bloccante e compare nelle attività; la sola vicinanza temporale a ordini locali non basta.
- Il titolare può chiudere anche questo conflitto come esterno soltanto dopo XML ufficiale, stato terminale, assenza di candidati compatibili e motivazione auditata.
- I documenti nati fuori dai due canali restano visibili nell’inventario per prevenire duplicati, ma non entrano nel flusso operativo né bloccano il canary tecnico quando non presentano riferimenti espliciti o match compatibili.

## 0.3.50

- Il canary M9 diventa una verifica tecnica Production senza selezionare, approvare, numerare, caricare o inviare fatture reali e senza generare e-mail.
- I permessi Aruba monouso e il percorso pilota vengono rimossi: l’eventuale invio automatico ordinario richiede il kill switch abilitato, il manifest esatto e documenti già validati.
- Le Impostazioni mostrano ora l’ultima attività e il readback dell’helper Aruba leggendo anche le sessioni di inventario del profilo persistente, confinati per ambiente e account.

## 0.3.49

- I documenti Aruba terminali con XML ufficiale, senza candidati eBay o Shopify compatibili né collegamenti locali, possono essere confermati dal solo titolare come fuori perimetro con motivazione e audit critico.
- La classificazione resta stabile alle scansioni successive, conserva la sola evidenza remota e non crea clienti, ordini, preparazioni, documenti o movimenti locali.
- Il classificatore CI include i moduli condivisi dall’helper Aruba, così ogni loro modifica richiede nuovamente le prove Chrome/macOS ed Edge/Windows.

## 0.3.48

- Il connettore Shopify recupera Codice Fiscale e civico dall’indirizzo di spedizione soltanto quando identità e località coincidono con la fatturazione e il dato è univoco; gli ordini già importati vengono riletti e le preparazioni singole ancora in revisione si riallineano senza perdere audit o proiezione.
- Un tentativo di pagamento pendente non resta più azionabile dopo che pagamenti successivi coprono l’intero lordo dell’ordine; dashboard, filtri, anomalie, trigger, bozza e riconciliazione condividono la stessa regola.
- Le preparazioni storiche riconciliate e realmente non fatturate restano pronte: il correttivo non le sopprime né le trasforma in falsi positivi.
- I vincoli di sequenzialità delle letture Aruba sotto lock e transazione sono ora espliciti nel gate statico, senza modificare l’inventario né autorizzare invii.

## 0.3.47

- L’helper rifiuta esplicitamente i cookie Aruba opzionali quando il banner tardivo intercetta i controlli della griglia, quindi prosegue soltanto dopo la sua chiusura verificata.
- Ogni ciclo Production riparte dalla Home, mantiene aperta la correlazione fino alla prima richiesta ExtJS asincrona e riporta alla prima pagina uno stream già selezionato prima di riprenderne il cursore.
- Le interazioni restano limitate nel tempo e riprovano una sola volta quando Cookiebot compare durante il click; in assenza della richiesta correlata terminano in fail-closed.

## 0.3.46

- La scansione conserva gli XML FPR12 validi che includono riepiloghi fiscali estranei al profilo N5 e li segnala come conflitti di profilo, senza interrompere l’intero inventario né materializzare documenti incompatibili.
- Identità strutturale, destinatario e riferimenti di riconciliazione vengono estratti indipendentemente dall’ammissibilità al profilo fiscale attivo; l’import resta fail-closed prima di qualsiasi collegamento fiscale.

## 0.3.45

- La selezione ExtJS usa la sequenza di puntatore nativa richiesta dal pannello Aruba reale, mantenendo la correlazione fra click, richiesta dati e stabilizzazione della griglia.
- L’import degli XML ufficiali accetta più riepiloghi fiscali soltanto quando Natura e riferimento normativo convergono sullo stesso profilo; valori discordanti restano bloccati.

## 0.3.44

- La sincronizzazione in sola lettura usa la doppia griglia ExtJS osservata nel pannello Aruba reale, seleziona anno e pagine in modo fail-closed e importa soltanto TD01 e TD04 nel relativo stream.
- I file ufficiali richiesti vengono scaricati dai controlli visibili della riga, mantenuti entro il limite in memoria e trasferiti immediatamente al server senza copie locali persistenti.
- Il validatore dei P7M ufficiali accetta CMS SignedData sia DER sia BER costruito a lunghezza indefinita, conservando i limiti strutturali e dimensionali.
- Matching e preflight ricostruiscono dall’XML ufficiale i segnali che la griglia Aruba non espone e restano bloccati se l’evidenza manca o non coincide.

## 0.3.43

- La verifica dell’identità Aruba considera soltanto l’elemento visibile che dichiara esattamente l’account atteso, ignorando i controlli annidati con lo stesso nome accessibile ma privi dell’identità testuale.
- La regressione riproduce la struttura osservata nel pannello reale e mantiene il blocco fail-closed in caso di identità assente o realmente ambigua.

## 0.3.42

- L’helper distingue la chiave applicativa dell’account Aruba dalla descrizione visibile usata per verificarne l’identità, evitando il falso mismatch emerso nella prima scansione reale.
- L’autenticazione resta vincolata alle sole origini ufficiali osservate e attende il reindirizzamento tardivo al login senza scambiare una pagina transitoria per il pannello operativo.
- Il profilo Production richiede esplicitamente l’identità Aruba qualificata e il preflight ne impedisce la sostituzione con il valore sintetico.

## 0.3.41

- Hub Fatture mantiene un inventario provider-first di fatture e TD04 presenti in Aruba, inclusi i documenti creati senza passare dall’app, e ne aggiorna gli stati senza regressioni.
- Dashboard, preparazioni, ordini, Attività e Documenti rendono visibili freschezza, progressi remoti, conflitti e documenti da collegare; Aruba mai letto o non affidabile non può più apparire come situazione sotto controllo.
- L’helper locale read-only esegue una scansione completa a ogni avvio, aggiornamenti incrementali ogni 15 minuti e preflight on-demand; sessione, lease, cursori, ripresa e fallback manuale restano confinati per account e ambiente.
- Matching, materializzazione dei documenti storici e collegamento delle TD04 sono fail-closed: totale mai sufficiente, file ufficiali obbligatori, decisioni manuali del titolare motivate e auditabili, rimborsi collegati atomicamente una sola volta.
- Approvazione e numerazione richiedono inventario globale affidabile e preflight fresco vincolato alla revisione esatta; il kill switch di invio Aruba e il confine del Canary restano invariati.

## 0.3.40

- Il manifest tecnico della release passa sempre dallo script canonico, che lo rinomina `release-manifest.json`, ne verifica identità e contenuto prima della pubblicazione e rilegge asset, tag e immutabilità dopo la creazione.
- Il record di readiness collega il deploy e il readback Production del contratto pilota `0.3.39`; l’inventario Aruba provider-first resta l’unico gate M8 aperto e mantiene il Canary bloccato.

## 0.3.39

- La preparazione dell’invio pilota crea una registrazione inattiva; l’attivazione richiede una seconda conferma specifica immediatamente prima del consumo.
- Il consumo pilota resta bloccato finché l’inventario Aruba provider-first non fornisce un preflight fresco e privo di conflitti sul candidato esatto.

- Il titolare può preparare un invio pilota Aruba per un solo documento già approvato mentre il kill switch globale resta disabilitato; il batch automatico viene ricreato con un manifest immutabile distinto e una conferma esplicita.
- Il permesso pilota è unico a livello globale, scade, può essere revocato e viene consumato atomicamente soltanto dopo la validazione del documento esatto; mismatch, riuso, configurazione ordinaria attiva o un secondo permesso lasciano l’invio bloccato.
- Revoca e retry restano fail-closed anche durante un rollback applicativo: la revoca forza anche la scadenza compresa dalla versione precedente e ogni nuovo tentativo pilota richiede una nuova conferma esplicita.
- Il readback Production distingue i permessi revocati da quelli ancora validi e continua a bloccare ogni residuo realmente autorizzante.
- La migrazione e le regressioni PostgreSQL coprono autorizzazione, unicità, scadenza, rinnovo, hash errato, consumo monouso e assenza di permessi ordinari nel percorso pilota.
- Il lockfile aggiorna `nanoid` alla correzione compatibile dell’advisory di disponibilità rilevato dal gate di sicurezza.

## 0.3.38

- La vista Clienti non considera più azionabile un vecchio stato di revisione dell’ordine quando l’ordine è già collegato a una preparazione chiusa o marcata da non trasmettere.
- La regressione copre esplicitamente il caso di un documento storico Aruba già riconciliato con una preparazione terminale.

## 0.3.37

- Il contratto dell’helper Aruba riflette il pannello reale per TD01 e TD04: date italiane, account nella barra superiore, riepilogo batch con `INVIA TUTTE`, cleanup globale con `SVUOTA PAGINA` e limite complessivo di 30 MB.
- La qualifica OCI Email Delivery usa lo stesso adapter SMTP del worker applicativo e resta fail-closed su ambiente, commit, digest e consenso exact-commit, senza scrivere dati sintetici nel database Production.
- La prova diagnostica osserva prima un errore di autenticazione con una credenziale casuale indipendente dal segreto Production e consente poi un solo reinvio sintetico alla casella controllata.
- Il record di readiness collega la qualifica Aruba senza invio, il PDF ufficiale, la copia cifrata Mac e i gate operativi M8 già chiusi; e-mail reale, rollback fresco e autorizzazione Canary restano gate separati.

## 0.3.36

- La vista Clienti segnala soltanto le revisioni anagrafiche ancora collegate a un ordine storico da riconciliare o a una preparazione realmente bloccata.
- La migrazione elimina esclusivamente i profili rimasti senza ordini, preparazioni o record sorgente, preservando ogni anagrafica con storia operativa o fiscale.
- Quando una risincronizzazione cambia la chiave d’identità di un ordine ancora libero, l’import rimuove subito il vecchio profilo se è diventato orfano, impedendo che il contatore torni a crescere.

## 0.3.35

- La modalità globale `Disattivata` impedisce a Hub Fatture di proporre, accodare o reinviare copie e-mail al cliente, mantenendo consultabile lo storico.
- Le richieste di invio manomesse vengono rifiutate lato server e gli eventuali job già accodati vengono soppressi prima del contatto SMTP, con audit dedicato.
- Approvazioni e archivio documenti riflettono la disattivazione senza offrire azioni di invio non più consentite.

## 0.3.34

- Il confronto degli indirizzi usa insieme le due righe ricevute dal marketplace, così il civico separato in `line2` resta verificabile contro l’XML Aruba senza indebolire i controlli su identità, Paese, data, totale, riferimento FPR e unicità.

## 0.3.33

- Il manifest tecnico della release viene pubblicato con il nome canonico `release-manifest.json`; la release precedente resta immutabile e viene superata senza spostarne tag o asset.

## 0.3.32

- L’integrazione Aruba considera ordinario il caricamento senza SMS quando la protezione per singolo upload è disattivata, continuando a fermarsi davanti a challenge OTP, SMS o CAPTCHA inattese.
- Le Impostazioni non espongono più una dichiarazione manuale della protezione Aruba che non influenzava il comportamento dell’helper; la migrazione rimuove la relativa chiave obsoleta dai database esistenti.
- Contratto, procedura manuale, pagina sintetica e test descrivono e verificano insieme il percorso corrente senza 2FA e senza SMS per ogni upload.

## 0.3.31

- Ogni pagina privata espone un titolo descrittivo nel formato `Pagina · Hub Fatture`, con titoli contestuali per ordini e preparazioni fattura e metadati coerenti anche per errori e pagine non trovate.
- L'applicazione espone description, Open Graph, Twitter Card, colore del tema e icona Apple, mentre `robots.txt`, i meta robot e l'header `X-Robots-Tag` impediscono l'indicizzazione e la condivisione di contenuti riservati.
- Un controllo strutturale richiede metadati espliciti a ogni nuova route visuale, evitando che il browser torni a mostrare soltanto l'URL o il nome generico dell'applicazione.

## 0.3.30

- La conservazione tecnica giornaliera redige o elimina soltanto payload sorgente, job, audit operativi, contenuti e-mail e credenziali Aruba scaduti secondo la policy approvata; documenti e audit fiscali restano esclusi, i blocchi sono fail-closed e in Production una ricevuta backup assente o non corrente arresta la transazione.
- I gate del candidato associano allo SHA esatto le prove dell'helper Aruba su macOS/Chrome e Windows/Edge, mantenendo separati workflow fidato, ricevute e classificazione del diff.
- Il readback Production ammette gli storici lasciati intenzionalmente in revisione soltanto quando non hanno riconciliazione, preparazione fattura o documenti e non sono quindi approvabili o trasmissibili.
- L'auto-merge Dependabot classifica gli aggiornamenti dalle sole API fidate di GitHub e resta chiuso per autore, tipo o stato non riconosciuti, senza auto-approvazione né esecuzione privilegiata del codice della PR.

## 0.3.29

- I rimborsi eBay presenti sia nel riepilogo pagamento sia sulle righe vengono importati una sola volta: il record con ID eBay resta autorevole e i duplicati sintetici storici non collegati a documenti vengono rimossi.
- I rimborsi senza importo di ordini già chiusi senza fattura restano nello storico del dettaglio, ma non richiedono più un intervento fiscale impossibile nella vista Attività.
- L’eccezione manuale dello storico riconosce la fattura personale di un cliente UE quando la ragione commerciale ricevuta contiene lo stesso nome e cognome, mantenendo obbligatori indirizzo, data, totale, riferimento FPR e unicità.

## 0.3.28

- Ogni accesso crea una sessione indipendente per dispositivo che resta valida per un anno, anziché scadere dopo otto ore; cambio password, uscita e revoca manuale continuano a invalidare le sessioni interessate.

## 0.3.27

- L’eccezione manuale per lo storico riconosce in modo deterministico la traslitterazione bulgara di nome, indirizzo e civico, mantenendo obbligatori Paese, data, totale, riferimento FPR e unicità del documento Aruba.

## 0.3.26

- La riconciliazione storica riconosce un interno alfanumerico non etichettato dopo il civico, come `14 1A`, senza scambiarlo per un secondo numero civico in conflitto con la fattura Aruba.

## 0.3.25

- Gli ordini eBay già importati vengono riletti una sola volta e la relativa Preparazione fattura viene ricalcolata quando la riconciliazione del pagamento netto rimuove un’anomalia derivata.
- La riconciliazione storica Shopify espone l’eccezione manuale auditata anche per le fatture Aruba senza riferimento ordine, mantenendo obbligatori numero documento, data, totale, identità, indirizzo e unicità.

## 0.3.24

- La colonna Ordini / Documenti della tabella Clienti conserva lo stesso separatore orizzontale delle altre colonne anche quando nome o e-mail aumentano l’altezza della riga; la griglia interna non viene più applicata direttamente alla cella `td`, che torna a partecipare al normale calcolo dell’altezza della tabella.

## 0.3.23

- La directory Clienti usa una tabella ordinabile sull’intero archivio per cliente, e-mail, identificativo fiscale, canale, ultimo ordine, ordini e documenti.
- Le colonne riservano spazio ai contenuti variabili e all’azione Apri dettaglio senza ellissi improprie o overflow, mantenendo il passaggio a schede sui viewport stretti.
- Anche il nuovo confronto degli aggiornamenti ricevuti nella Preparazione fattura è ordinabile dalle intestazioni.

## 0.3.22

- L’eccezione manuale eBay riconosce il CAP estero riportato all’inizio dell’indirizzo quando la fattura Aruba usa il segnaposto FatturaPA `00000`, senza scambiarlo per un secondo civico.
- Paese, civico, identità personale, data, totale, riferimento FPR e unicità del documento restano obbligatori e auditati.

## 0.3.21

- Le preparazioni bloccate da un aggiornamento dell’ordine mostrano il confronto leggibile fra i dati precedenti e quelli correnti e richiedono una conferma esplicita prima di chiudere il controllo.
- La conferma rimuove soltanto il conflitto sorgente, conserva anomalie indipendenti e registra una ricevuta auditata per ogni ordine verificato.
- Le bozze già salvate vengono riconciliate atomicamente con i nuovi importi, preservando le personalizzazioni manuali e impedendo l’approvazione di una proiezione obsoleta.

## 0.3.20

- La riconciliazione storica eBay può registrare un’eccezione manuale esplicita quando l’identificativo fiscale ricevuto dal marketplace è discordante ma identità personale, civico, Paese, data, totale, riferimento FPR e unicità del documento coincidono.
- L’eccezione resta limitata agli ordini eBay di privati, richiede una conferma auditata e continua a rifiutare aziende, riferimenti inesatti, rimborsi ambigui, candidati multipli e XML già usati.
- Il confronto automatico, gli ordini Shopify e il gate fail-closed restano invariati.

## 0.3.19

- Tutte le nove tabelle operative possono essere riordinate dalle intestazioni; colonne, testi variabili, azioni e selettori sono bilanciati in modo uniforme senza ellissi improprie o contenuti che sforano.

## 0.3.18

- La pagina Documenti adotta la gerarchia visiva delle altre superfici operative, con viste rapide, riepilogo, filtri coerenti e un unico archivio per fatture e note di credito.
- L’archivio pagina cinquanta documenti alla volta, carica file ed e-mail soltanto per le righe visibili e mantiene leggibili testi e importi lunghi su desktop e viewport stretti.
- Data, totale e stato conservano una separazione minima verificata anche con importi a sei cifre; file e azioni restano disponibili in pannelli espandibili senza appesantire ogni riga.

## 0.3.17

- La riconciliazione eBay riconosce le varianti strutturate osservate negli indirizzi europei, comprese unità immobiliari alfanumeriche, suffissi civici e connettori linguistici non distintivi.
- Nome completo, civico non conflittuale, data, Paese, totale, profilo fiscale e unicità globale restano obbligatori: nomi parziali, toponimi numerati ambigui e strade soltanto simili vengono rifiutati.
- Gli ordini storici continuano a restare non approvabili finché un XML Aruba ufficiale non produce un collegamento univoco e non riutilizzato oppure l’esito manuale li dichiara non fatturati.

## 0.3.16

- Gli ordini Shopify italiani con `privato` nel campo azienda vengono riconosciuti come privati senza perdere il valore originale nello snapshot sorgente.
- Le aziende italiane richiedono una P.IVA valida: il solo codice fiscale resta acquisito ma porta l'anagrafica in revisione, mentre in presenza di entrambi gli identificativi prevale la P.IVA.
- Dopo il deploy, gli ordini Shopify già importati vengono riletti automaticamente tramite il normale import idempotente; eBay e i documenti già emessi non vengono modificati.

## 0.3.15

- La pagina Ordini adotta la stessa gerarchia visiva delle altre superfici operative, riunendo filtri, conteggio e risultati in pannelli coerenti con destinazioni e azioni sempre riconoscibili.
- Le righe desktop sono più compatte e mantengono leggibili canale, cliente, stato e preparazione anche con cinquanta elementi; sui viewport più stretti diventano schede a due colonne con testi lunghi completi e comandi distanziati dai bordi fino a 320 px.
- Gli stati usano etichette sintetiche con descrizione completa, la pagina 2 conserva densità e allineamenti e le viste implicite non vengono più conteggiate come filtri attivi.

## 0.3.14

- La pagina Impostazioni adotta la stessa gerarchia visiva di Dashboard, Clienti e Attività, con navigazione interna, sezioni leggibili e controlli che restano utilizzabili da desktop a 320 px.
- Profilo, sicurezza, dati fiscali, connessioni e stato di sistema usano griglie e riquadri uniformi; oltre trenta sessioni restano contenute e Shopify ed eBay condividono lo stesso schema anche quando l’importazione iniziale è in stati diversi.
- I menu a tendina riservano spazio all’indicatore, le azioni mantengono distanza dai bordi e collegamenti diretti, tema scuro e zoom 200% non nascondono contenuti o comandi.

## 0.3.13

- Dettaglio ordine e nota di credito TD04 adottano la stessa gerarchia visiva delle pagine operative, con dati principali, contesto e azioni separati.
- Login, prima configurazione, pagina di errore e simulatore Aruba condividono componenti, spaziature e stati coerenti in tema chiaro e scuro fino a 320 px.
- I pannelli Stato dell’ordine e Dati del cliente hanno la stessa altezza sulla griglia desktop; un controllo E2E protegge l’allineamento senza alterare il riflusso sui viewport più stretti.

## 0.3.12

- La riconciliazione storica riconosce la stessa riga di indirizzo quando Aruba separa il civico in un campo strutturato.
- Nome, civico, CAP, città, Paese, data, totale, profilo fiscale e unicità restano obbligatori; i casi non univoci continuano a essere bloccati.

## 0.3.11

- La tabella Clienti mostra l’identificativo fiscale dopo l’e-mail senza distinguerne il tipo e usa uno stato neutro quando il dato non è disponibile.
- La tabella Attività espone lo stesso dato dopo il cliente, ricavandolo dallo snapshot autorevole di ordine, preparazione, fattura o documento anche per rimborsi, job falliti e note di credito.
- Le nuove colonne restano leggibili nei layout desktop e passano alla presentazione a schede sui viewport più stretti.

## 0.3.10

- Le anagrafiche importate e corrette separano lo snapshot sorgente immutabile, il profilo canonico usato per il matching e una forma di presentazione coerente per interfaccia e documenti.
- Nomi personali, città e indirizzi italiani vengono resi leggibili senza reinterpretare ragioni sociali, casing intenzionale o indirizzi esteri ambigui; e-mail, PEC, codici destinatario, Paese, provincia e CAP sono uniformati nei rispettivi formati.
- La suite PostgreSQL limita la concorrenza del runner e i test e-mail rivendicano il job dell'esatta consegna, eliminando contesa e selezioni non deterministiche senza modificare la coda Production.

## 0.3.9

- La riconciliazione storica eBay collega gli XML Aruba privi di riferimento marketplace soltanto quando data, totale e destinatario identificano un candidato univoco nell’intero storico.
- Per destinatari senza identificativo fiscale sono richiesti identità completa e indirizzo coerente; l’ordine dei token resta flessibile soltanto per nome e cognome di persona, mentre ragioni sociali, omonimi e rimborsi ambigui restano prudenzialmente bloccati.
- I metodi di pagamento storici MP01, MP05 e MP08 vengono conservati senza modificare il profilo fiscale attivo; lo stesso documento non può essere riutilizzato su ordini diversi.

## 0.3.8

- Le fatture Aruba storiche conservano la modalità di pagamento effettiva `MP01`, `MP05` o `MP08`, purché usino l'unica condizione ammessa `TP02`.
- Il confronto non confonde più il metodo documentale con il default `MP08` del profilo fiscale e continua a bloccare modalità mancanti, multiple o non supportate.

## 0.3.7

- Gli XML Aruba storici Shopify senza riferimento esplicito possono essere collegati soltanto quando data, destinatario, totale fatturabile, profilo fiscale e unicità individuano lo stesso ordine.
- Riferimenti a ordini diversi, marker marketplace incompatibili, importi lordi in presenza di commissioni Shopify Payments, rimborsi ambigui o documenti già collegati bloccano il confronto.
- Gli ordini Shopify restano in revisione storica e non approvabili finché il confronto con l'XML ufficiale non produce un esito verificato.

## 0.3.6

- Gli ordini eBay recuperano l'identificativo fiscale con il marketplace corretto; Shopify usa come ultimo fallback un unico CF o P.IVA italiana presente nel campo interno dell'indirizzo di fatturazione.
- Dopo il deploy, gli ordini già importati vengono riallineati automaticamente tramite il normale import idempotente, senza duplicati.
- Il nome Hub Fatture resta su una sola riga e accompagna apertura e chiusura della sidebar desktop con una transizione coordinata di larghezza e opacità.
- Corretto il ritorno a capo istantaneo che compariva perché il nome tornava visibile prima che la sidebar avesse recuperato una larghezza sufficiente.
- Il pulsante di ricerca non mostra più il badge della scorciatoia da tastiera; la scorciatoia resta disponibile senza occupare spazio nell'interfaccia.

## 0.3.5

- Pubblicazione proporzionata all'impatto delle modifiche, con classificazione conservativa e verifiche indipendenti eseguite in parallelo.
- Deploy Production escluso per modifiche prive di impatto runtime, vincolato ai check cumulativi non mascherabili da no-op e registrato sul commit realmente installato.
- Immagine Production costruita, analizzata e attestata una sola volta, poi riutilizzata dal deploy senza ricostruzioni divergenti.
- Backup straordinario riservato alle modifiche di schema o storage; negli altri casi il deploy riusa un backup giornaliero ancora valido.
- Rollback deliberato verso un commit precedente distinto dall'avanzamento cumulativo, vincolato al digest attestato e bloccato prima del deploy quando lo schema diverge.

## 0.3.4

- La pagina Attività organizza le verifiche in una tabella compatta per elemento, cliente, canale o tipo, data ordine e ultimo aggiornamento, con riepilogo operativo e cronologia più leggibili.
- Paginazione a 50 righe, celle su una riga e passaggio anticipato a schede mantengono scansionabili decine di attività su desktop, viewport intermedie e mobile; l’azione resta contenuta nella propria colonna con margine stabile dal bordo.
- La vista si concentra su ordini, documenti e operazioni non riuscite: le richieste privacy non compaiono più in Attività, mentre registrazione e gestione tecnica dei webhook Shopify restano invariate.

## 0.3.3

- La nuova sezione Clienti riunisce ricerca, filtri di verifica e riepilogo delle anagrafiche collegate a Shopify ed eBay, senza esporre identificativi fiscali nell’elenco.
- Il dettaglio cliente collega anagrafica corrente, fonti, ordini, preparazioni e documenti; il dato fiscale resta disponibile nella ricerca globale e nel dettaglio.
- Sidebar desktop e navigazione mobile includono Clienti con layout responsivo e controlli di regressione contro colonne vuote o contenuti che sbordano dal pannello.

## 0.3.2

- Le commissioni effettive sono sottratte dal totale fatturabile soltanto per transazioni Shopify Payments riuscite; PayPal, bonifici, metodi manuali ed eBay restano al lordo.
- La regola è modificabile nelle Impostazioni e ricalcola in modo serializzato soltanto ordini e documenti ancora modificabili, mantenendo le fee osservate come dato immutabile.
- Riconciliazione storica, comparatore, rimborsi e TD04 usano il totale coerente con la fattura emessa; gli override manuali rispettano il residuo attribuito a ciascun ordine senza alterare il rimborso lordo del provider.

## 0.3.1

- Manifest della release allegato con il nome canonico `release-manifest.json`, senza modifiche al comportamento applicativo.

## 0.3.0

- Aggiunta la ricerca globale da ogni pagina per ordini, fatture e clienti, con risultati immediati, scorciatoia da tastiera e campi anagrafici e fiscali.
- Introdotto il dettaglio cliente con dati di fatturazione, ordini e fatture recenti collegati alle rispettive superfici operative.
- Completati stati iniziale, caricamento, vuoto ed errore, navigazione da tastiera e layout coerente con la Dashboard su desktop e mobile.
- Stabilizzata una sola richiesta per query e rimossa su mobile l’indicazione `Esc`, mantenendo la chiusura tramite il comando visibile.

## 0.2.5

- Le code operative della Dashboard aprono viste che riflettono gli stessi criteri dei rispettivi conteggi.
- I pagamenti in attesa includono anche gli ordini con un movimento pendente e stato sintetico già aggiornato; le note di credito in bozza sono raggiungibili dalla coda Attività filtrata.

## 0.2.4

- Lo stato operativo non segnala più aggiornamenti Aruba da completare quando il primo readback non è ancora necessario; l’avviso resta vincolato alla presenza di un batch aperto.

## 0.2.3

- Manifest della release allegato con il nome canonico `release-manifest.json`, senza modifiche al comportamento applicativo.

## 0.2.2

- Allowlist GitHub Actions allineata ai repository Docker approvati con pin SHA obbligatorio, evitando che un aggiornamento valido venga rifiutato prima dell’avvio dei job.
- Metadati di release riallineati al commit Production esatto senza modifiche al comportamento applicativo.

## 0.2.1

- Ripristinata la separazione visiva fra l’azione di riconnessione e la conferma dell’import iniziale completato nelle schede Shopify ed eBay.
- Workflow Production aggiornato alle ultime Action Docker su Node 24, mantenendo i riferimenti fissati a SHA completi.

## 0.2.0

- Dashboard riorganizzata come regia operativa: priorità, criticità e collegamenti hanno gerarchie distinte e azioni dirette.
- Stato dei collegamenti reso esplicito anche quando non esistono ancora aggiornamenti o il dato è obsoleto, senza dichiarare esiti positivi non osservati.
- Documenti emessi accompagnati dall’andamento reale degli ultimi sette giorni, con resa coerente anche nello stato vuoto.
- Layout della Dashboard verificato su desktop, mobile, tema chiaro e tema scuro.

## 0.1.1

- Separati rendering, orchestrazione HTTP e persistenza nei flussi Impostazioni e Preparazione fattura, impedendo import runtime dei moduli server nel client.
- Isolati storage documentale e validazione degli identificativi PostgreSQL, eliminando il ciclo fra documenti e comandi ordine.
- Aggiunti il gate automatico sui cicli di import e fixture temporali deterministiche per le note di credito.
- Il backup pre-deploy usa ora il bundle operativo della release installata, evitando incompatibilità con i moduli del candidato prima del passaggio di versione.

## 0.1.0

- Prima release tecnica versionata della Production, con rollback al digest precedente.
- Dashboard completata con tutte le code operative, gli errori provider, gli ultimi aggiornamenti e i documenti emessi.
- Ordini e Attività resi più leggibili su mobile, con viste auto-centrate, filtri espliciti, reset e cronologia più compatta.
- Impostazioni rese navigabili a 320 px, con salvataggi abilitati solo dopo una modifica e dettagli tecnici senza overflow.
- Empty state e pagina non trovata ora offrono una prossima azione coerente.

## In lavorazione

- M6 locale: rimborsi, TD04 cumulative, vincoli PostgreSQL, copia cliente e trasporto sintetico Nodemailer.
- HF-O07 resta aperta: PoC OCI preparato ma non eseguito; nessun trasporto Production è stato ancora approvato.
