# Changelog

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
