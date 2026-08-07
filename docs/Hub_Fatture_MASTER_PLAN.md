# Hub Fatture 1.x

## Piano completo di prodotto, architettura, implementazione e handover

**Stato:** specifica funzionale e operativa consolidata; lo sviluppo procede in sequenza da M0; profilo fiscale, numerazione e automazione Aruba vengono qualificati nelle milestone M4-M5
**Destinatari:** Codex, Claude Code e sviluppatori incaricati
**Lingua dell'interfaccia:** italiano
**Nome breve del prodotto:** HF
**Repository:** GitHub pubblico, codice a sorgente visibile ma senza licenza d'uso implicita

> Questo documento è la fonte di verità per Hub Fatture 1.x. Consolida tutte le decisioni prese durante la progettazione preliminare, comprese motivazioni, semplificazioni deliberate, vincoli, punti rinviati e attività di verifica. La conversazione originaria non sarà disponibile agli agenti che riceveranno questo handover.
>
> Le affermazioni tecniche e fiscali provenienti dalla conversazione precedente sono contesto progettuale non verificato in questa sessione. Prima dell'uso in produzione vanno confermate sulla documentazione ufficiale corrente, nell'ambiente reale e, per le scelte fiscali, con il commercialista. L'XML Aruba già trasmesso e accettato dallo SdI sarà la fonte tecnica primaria per il profilo documento.

---

## 0. Come leggere questa specifica

### 0.1 Stati delle decisioni

Ogni punto appartiene a una delle categorie seguenti:

| Stato | Significato |
|---|---|
| **Confermato** | Decisione esplicita del titolare; va implementata come descritta |
| **Default tecnico** | Scelta di routine affidata all'implementatore; usare l'opzione più semplice compatibile |
| **Confermato con condizione** | Funzione voluta solo se il provider reale la rende semplice e sicura |
| **Rinviato - blocco produzione** | Non impedisce scaffolding e sviluppo con mock, ma impedisce numerazione o invii reali |
| **Ipotesi da verificare** | Informazione tecnica proveniente dalla conversazione, da ricontrollare su documentazione e payload correnti |
| **Superato** | Proposta discussa e poi abbandonata; non va implementata |

Le decisioni fiscali non verificabili dal materiale reale non sono default tecnici. L'implementatore deve fermarsi e chiedere, senza dedurre valori plausibili.

### 0.2 Regole di prevalenza e fonti canoniche

Non esiste una gerarchia unica fra intenzione, implementazione e stato live:

| Domanda | Fonte canonica |
|---|---|
| Cosa deve fare il prodotto | decisione esplicita più recente del titolare, poi questo Master Plan |
| Qual è il profilo fiscale corretto | profilo approvato, XML Aruba accettato e decisioni del commercialista |
| Perché è stata presa una scelta tecnica stabile | ADR approvato |
| Qual è il contratto corrente fra moduli | contratto tecnico e relativi test |
| Cosa fa oggi il software | codice, migrazioni, configurazione validata e test sul commit esatto |
| Come si esegue un'operazione | runbook corrente |
| Cosa è davvero attivo o accaduto fuori da Git | readback dalla fonte autorevole del provider |

Una prova live non modifica da sola il perimetro; rivela invece una divergenza da correggere o una decisione da riaprire. Allo stesso modo, una spunta nel piano non sostituisce il comportamento osservato del codice o del provider.

`AGENTS.md` governa il modo di lavorare, non modifica da solo il perimetro o le decisioni fiscali. README, indici e runbook devono rimandare alla fonte canonica senza duplicare intere sezioni. Se l'implementazione cambia un comportamento previsto, la stessa modifica aggiorna test e documentazione pertinente.

### 0.3 Evidenze e stato di avanzamento

Una casella spuntata o un comando terminato con successo non costituiscono, da soli, prova di completamento. La chiusura di una milestone o di un gate deve collegare evidenze verificabili:

- commit o versione esatti;
- comandi e risultati dei gate applicabili;
- migrazioni eseguite e relativo ambiente;
- smoke, E2E o prova manuale osservata;
- per operazioni remote, account e risorsa target, ID remoto, readback e rollback disponibile;
- rischi residui accettati e condizioni che li riaprono.

Le evidenze vivono in `docs/evidence/`; i contratti tecnici riusabili in `docs/contracts/`; le procedure in `docs/runbooks/`. Non creare un documento di evidenza quando un test automatico o una ricevuta breve nel changelog forniscono già la prova necessaria.

### 0.4 Sequenza e autorizzazioni reali

- M1-M3 non dipendono da Aruba e usano soltanto fixture e dati sintetici.
- M4 comprende audit autenticato read-only, analisi dell'XML accettato, profilo fiscale, numerazione, generatore definitivo e, come ultimo gate, la prova manuale controllata del candidato XML.
- M5 inizia soltanto dopo la chiusura di quel gate M4 e comprende l'integrazione del pannello e dell'helper.
- Modifiche all'account Aruba, upload reali, invii, deploy e release richiedono comunque l'autorizzazione specifica del titolare nel momento in cui vengono eseguiti. Questi consensi proteggono azioni remote, ma non costituiscono una roadmap parallela.

### 0.5 Governo e ciclo di vita della documentazione

La documentazione non ha versioni proprie: la cronologia Git è lo storico. Ogni documento descrive lo stato corrente e, quando diventa superato, viene aggiornato o rimosso invece di essere duplicato con un nuovo suffisso.

Il Master Plan non duplica date di aggiornamento, numeri di versione di runtime, dipendenze, immagini o API. I pin tecnici vivono soltanto negli artefatti dello scaffolding; versioni supportate e fine supporto delle API nei contratti verificabili; timestamp e commit nelle evidenze. Restano nel piano solo le versioni che esprimono semantica di prodotto o compatibilità, come il target della prima release, lo schema dati e le revisioni dei documenti.

| Tipo | Scopo | Non deve contenere |
|---|---|---|
| Master Plan | Perimetro, decisioni, requisiti, gate e Definition of Done | ricevute operative dettagliate o copie dei runbook |
| ADR | Scelte stabili e difficili da invertire, con alternative scartate | decisioni di routine o cronaca di implementazione |
| Contratto tecnico | Comportamento corrente riusato da più moduli o milestone | piani futuri e requisiti duplicati |
| Evidenza | Prova osservata di un gate, deploy, test live o limite | segreti, payload reali o conclusioni non osservate |
| Runbook | Procedura operativa ripetibile, preflight, rollback e criteri di arresto | decisioni di prodotto |
| Audit | Findings correnti sul codice corrente, con stato e prova | difetti storici già corretti presentati come ancora aperti |

`docs/INDEX.md` elenca per ogni documento scopo, stato e fonte canonica. `CLAUDE.md`, se presente, importa `AGENTS.md` e non ne replica le regole. Contratti ed evidenze nascono solo quando esiste comportamento o prova reale: non creare scaffolding documentale speculativo.

Formato minimo di un'evidenza non banale:

- data, ambiente, commit/versione e target esatto;
- preflight e identità provider verificati;
- risultato osservato e matrice dei casi eseguiti;
- gate locali/CI collegati;
- ID remoto, readback e rollback quando esiste una scrittura remota;
- limiti non osservabili, rischio residuo e condizione di chiusura.

I log grezzi restano fuori dal repository quando contengono identificativi, configurazioni o dati fiscali. L'evidenza conserva solo estratti sanitizzati e gli identificatori tecnici strettamente necessari.

---

## 1. Sintesi esecutiva

Hub Fatture 1.x è un'applicazione web privata e single-tenant per l'attività del titolare. Importa ordini da un solo negozio Shopify e da un solo account venditore eBay, genera bozze di fatture elettroniche semplificate nel regime del margine e richiede sempre un'approvazione esplicita. Un helper locale multipiattaforma carica quindi l'XML nel pannello web di Aruba Fatturazione Elettronica usando Chrome o Edge, legge la validazione e, in base all'impostazione scelta, si ferma prima dell'ultimo clic oppure completa l'invio usando un'autorizzazione monouso vincolata ai documenti esatti. Login, password, OTP 2FA e CAPTCHA restano sempre passaggi umani. Stati, notifiche Aruba e risultati SdI vengono riconciliati dal pannello e dai file ufficiali scaricati.

L'app non è un gestionale fiscale completo e non deve sostituire la contabilità Aruba. Il suo compito è automatizzare la raccolta degli ordini, applicare un profilo fiscale preconfigurato e verificato, preparare il documento, consentire correzioni controllate, raccogliere l'approvazione e orchestrare la trasmissione.

Il prodotto sarà:

- usato soltanto dal titolare, con un unico account amministratore;
- installato su una VPS Oracle Cloud Ampere A1 già disponibile e compresa nelle risorse Always Free di un account Pay As You Go;
- raggiungibile tramite hostname gratuito Dynu e HTTPS gestito da Caddy;
- distribuito con Docker Compose;
- sviluppato come monolite modulare TypeScript/Node.js con frontend React e PostgreSQL;
- indipendente dall'Admin Shopify, con pannello autonomo;
- privo di costi ricorrenti obbligatori oltre ai servizi già posseduti;
- compatibile con l'account Aruba Base già posseduto, senza dipendere dai Web Services Premium;
- sviluppato in un repository GitHub pubblico, senza rendere pubblica o installabile l'applicazione;
- limitato agli ordini in euro e ai beni fisici spediti dall'Italia;
- limitato alle vendite soggette al regime del margine;
- privo, nella 1.x, di OSS, multi-tenancy, billing, ruoli, vendite manuali e notifiche e-mail operative.

Nessuna fattura o nota di credito viene mai trasmessa senza un'approvazione esplicita. In modalità `Assistita` il titolare esegue personalmente l'ultimo clic nel pannello Aruba; in modalità `Automatica dopo conferma` l'helper può eseguirlo soltanto dopo una conferma in HF che genera un permesso monouso per batch, revisioni e hash XML esatti. Anche l'azione in blocco deve essere esplicita.

---

## 2. Obiettivi

### 2.1 Obiettivi principali

1. Importare in modo affidabile gli ordini Shopify ed eBay.
2. Acquisire i dati anagrafici e fiscali necessari, preservando il dato originale della piattaforma.
3. Raggruppare automaticamente gli ordini compatibili dello stesso cliente e dello stesso giorno.
4. Creare bozze di fattura semplici, con una riga netta per ordine.
5. Consentire correzioni manuali prima dell'approvazione.
6. Generare XML FatturaPA conforme al profilo Aruba reale.
7. Validare localmente l'XML e leggere la validazione ottenuta caricandolo nel pannello Aruba, senza inviarlo allo SdI.
8. Richiedere l'approvazione esplicita prima di numerazione e trasmissione.
9. Evitare duplicati anche in presenza di webhook, retry o sincronizzazioni ripetute.
10. Riconciliare l'intero esito Aruba/SdI dal pannello e dai file ufficiali scaricati, rendendo evidenti scarti ed errori.
11. Creare automaticamente bozze cumulative di note di credito dopo rimborsi completati.
12. Inviare una copia leggibile al cliente secondo la modalità globale scelta e la decisione presa in approvazione.
13. Conservare localmente XML, PDF, notifiche e audit.
14. Eseguire backup giornalieri cifrati fuori dalla VPS su OCI Object Storage e conservarne copie periodiche sul Mac, senza versionare dati personali.
15. Mostrare prima dell'approvazione la provenienza e le differenze fra ordine sorgente, bozza corrente e proiezione XML finale.

### 2.2 Criterio di successo della 1.x

Il sistema è pronto per l'uso reale quando un ordine di prova per ciascuna piattaforma attraversa senza interventi tecnici il flusso completo:

`importazione -> Scheda -> bozza -> comparatore fiscale -> controlli -> approvazione -> helper locale -> validazione/upload Aruba -> invio autorizzato -> stato SdI -> copia leggibile -> archiviazione`

e quando un rimborso di prova produce correttamente:

`rimborso completato -> bozza TD04 cumulativa -> approvazione -> trasmissione -> collegamento alla fattura originaria`.

### 2.3 Requisiti funzionali tracciabili

| ID | Requisito | Stato |
|---|---|---|
| HF-F01 | Importare subito ordini e aggiornamenti da Shopify ed eBay | Confermato |
| HF-F02 | Generare la bozza al pagamento oppure all'evasione completa, secondo un'impostazione globale unica | Confermato |
| HF-F03 | Permettere la generazione manuale anticipata di una bozza | Confermato |
| HF-F04 | Creare automaticamente Schede giornaliere per cliente usando la data ordine in `Europe/Rome` | Confermato |
| HF-F05 | Evitare l'accorpamento automatico quando l'identità del cliente è ambigua | Confermato |
| HF-F06 | Produrre una riga semplificata netta per ordine, con spedizione e sconti assorbiti | Confermato |
| HF-F07 | Conservare il dettaglio sorgente per riconciliazione senza riprodurlo 1:1 nel documento | Confermato |
| HF-F08 | Permettere modifiche a cliente, descrizioni, quantità, importi, pagamenti, causali e ordini inclusi fino all'approvazione | Confermato |
| HF-F09 | Consentire differenze rispetto al totale sorgente solo con avviso, seconda conferma e motivazione obbligatoria | Confermato |
| HF-F10 | Richiedere sempre approvazione esplicita prima di numerare e preparare l'invio, anche quando l'ultimo clic è delegato all'helper | Confermato |
| HF-F11 | Consentire approvazione massiva soltanto per Schede prive di eccezioni | Confermato |
| HF-F12 | Richiedere una conferma aggiuntiva per documenti con pagamento pendente | Confermato |
| HF-F13 | Conservare bozze `Non trasmettere` con motivazione, senza numerarle o eliminarle | Confermato |
| HF-F14 | Rendere immutabili i documenti approvati e conservare ogni tentativo di invio | Confermato |
| HF-F15 | Riconciliare stati, notifiche e scarti Aruba/SdI dal pannello web e dai file ufficiali scaricati | Confermato |
| HF-F16 | Creare automaticamente una bozza TD04 per rimborsi completati successivi all'emissione | Confermato |
| HF-F17 | Cumulare più rimborsi nella stessa bozza TD04 aperta e crearne una nuova dopo l'emissione | Confermato |
| HF-F18 | Non creare note di credito per fatture scartate o non emesse | Confermato |
| HF-F19 | Inviare il PDF al cliente in modalità globale automatica o manuale, con override prima dell'approvazione | Confermato |
| HF-F20 | Usare l'indirizzo e-mail del negozio tramite il trasporto SMTP canonico scelto e consentire il reinvio | Confermato |
| HF-F21 | Importare in avvio gli ultimi 7 giorni in stato prudenziale e riconciliarli con Aruba | Confermato |
| HF-F22 | Conservare annullati, XML, PDF, notifiche e audit localmente | Confermato |
| HF-F23 | Mostrare nel pannello errori, scarti e code; nessuna notifica operativa e-mail al titolare | Confermato |
| HF-F24 | Offrire export XML e import del readback come fallback manuale completo quando l'helper non è disponibile | Confermato |
| HF-F25 | Propagare opzionalmente a Shopify le sole correzioni cliente supportate dall'API | Confermato con condizione |
| HF-F26 | Mantenere l'interfaccia solo in italiano, centralizzando il testo visibile in un catalogo italiano semplice | Confermato |
| HF-F27 | Bloccare centralmente i permessi ordinari di invio automatico Aruba tramite kill switch Production senza impedire consultazione, export, upload manuale, import, diagnosi o il singolo Canary autorizzato | Default tecnico di sicurezza |
| HF-F28 | Mostrare un comparatore fiscale strutturato fra snapshot sorgente, bozza corrente e proiezione XML prima di ogni approvazione | Confermato |
| HF-F29 | Definire una Brand Foundation leggera e versionata per nome, icona, favicon, palette minima, tipografia di sistema e tono UI | Confermato |
| HF-F30 | Valutare OCI Email Delivery in Development e selezionare un solo trasporto SMTP canonico prima dell'uso Production | Confermato come PoC; adozione OCI condizionata |
| HF-F31 | Eseguire il flusso Aruba ordinario tramite un helper locale unico per Windows e macOS, usando Chrome o Edge; Safari resta supportato solo per il fallback manuale | Confermato |
| HF-F32 | Offrire in Impostazioni le modalità `Assistita` e `Automatica dopo conferma`, con `Assistita` come default | Confermato |

---

## 3. Perimetro confermato

### 3.1 Compreso nella 1.x

- Un solo store Shopify.
- Un solo account venditore eBay.
- Un solo account Aruba.
- Account Aruba Base; nessuna dipendenza dai Web Services Premium.
- Un solo amministratore.
- Ordini Shopify ed eBay, senza inserimento manuale di vendite.
- Beni fisici spediti esclusivamente da un magazzino in Italia.
- Vendite in Italia e negli altri Paesi UE.
- Clienti privati prevalenti, con supporto anche ad aziende e professionisti italiani o UE.
- Unica valuta ammessa: EUR.
- Regime del margine per tutti gli articoli.
- Profilo documentale fisso, derivato dalla configurazione Aruba e da XML reali.
- Fatture e note di credito.
- Raggruppamento automatico giornaliero per cliente.
- Approvazione singola e massiva controllata.
- Pagamenti online e pagamenti differiti, inclusi bonifico, contrassegno e metodi manuali.
- Copia leggibile della fattura via e-mail.
- Comparatore fiscale visuale prima dell'approvazione di fatture e note di credito.
- Sincronizzazione di notifiche ed esiti.
- Helper Aruba locale multipiattaforma per Chrome o Edge, avviato dall'utente sul proprio computer.
- Modalità Aruba `Assistita` e `Automatica dopo conferma`, selezionabili in Impostazioni.
- Export XML e import dei file Aruba come fallback manuale sempre disponibile.
- Pannello operativo e registro attività.
- Brand Foundation leggera con asset minimi versionati, senza sito pubblico o design system separato.
- Import iniziale prudenziale degli ultimi sette giorni.
- Backup giornaliero cifrato su OCI Object Storage privato e copie periodiche cifrate sul Mac.
- Ambienti logici `development` e `production` separati; nessuna credenziale o dato reale nello sviluppo.
- PoC OCI Email Delivery in Development e scelta di un solo trasporto SMTP per Production.

### 3.2 Escluso dalla 1.x

- App pubblica o installabile da altri merchant; la repository GitHub pubblica non cambia questo vincolo di prodotto.
- Shopify App Store, billing e abbonamenti.
- Multi-tenancy, multi-azienda, inviti, ruoli e collaboratori.
- Amazon, POS, negozio fisico o altre sorgenti.
- Schede create senza un ordine Shopify/eBay.
- Prodotti digitali o servizi.
- Multi-valuta e conversioni.
- OSS, aliquote dei Paesi UE, dichiarazioni e rettifiche OSS.
- Monitor della soglia UE di 10.000 euro e motore VIES per decidere il trattamento fiscale.
- Registro del margine, determinazione contabile del margine, liquidazione IVA e dichiarazioni.
- Scelta automatica fra metodo analitico, globale o forfetario.
- Motore fiscale generale o interpretazione autonoma delle eccezioni.
- IVA ordinaria o profili fiscali multipli.
- Gestione di stock o fulfillment esteri.
- Aggiornamento dei dati fiscali eBay.
- Notifiche operative via e-mail al titolare; nella 1.x bastano gli avvisi nel pannello.
- Due trasporti SMTP attivi in parallelo o fallback automatico fra provider e-mail.
- Sito marketing, libreria di componenti proprietaria, webfont o sistema di brand esteso.
- Backup su provider esterni a OCI o replica multi-cloud.
- Web Services Aruba Premium o API Aruba non documentate.
- Automazione Aruba headless o non presidiata sulla VPS.
- Automazione di login, password, OTP 2FA o CAPTCHA.
- Automazione Safari del pannello Aruba; su Safari resta disponibile il flusso manuale.
- Alta disponibilità, cluster, microservizi, Redis e Kubernetes.
- Retrocompatibilità o implementazioni legacy non necessarie.

### 3.3 Possibili evoluzioni, non da predisporre ora

- Dominio proprietario.
- Replica dei backup su un secondo provider indipendente da OCI.
- Più utenti e ruoli.
- Altri marketplace o vendite manuali.
- Multi-valuta.
- Profili fiscali multipli.
- OSS o altri regimi, solo su nuova specifica fiscale.
- Localizzazione dell'interfaccia.

Non creare astrazioni speculative per queste evoluzioni. Il codice deve essere modulare nei confini reali - connettori, generatore XML, storage - ma non generalizzato in anticipo.

---

## 4. Decisioni consolidate e motivazioni

| Area | Decisione | Motivazione |
|---|---|---|
| Modello operativo | Pannello web autonomo | Shopify, eBay e Aruba hanno pari importanza; l'app non deve dipendere dall'Admin Shopify |
| Utenza | Un solo amministratore | È un'app privata per il titolare; niente ruoli o onboarding |
| Hosting | VPS OCI Ampere A1 | È già disponibile, gratuita entro i limiti e compatibile con Node/PostgreSQL |
| Hostname | Dynu | Hostname gratuito stabile senza acquisto di dominio |
| HTTPS | Caddy | Configurazione e rinnovo certificati semplici |
| Distribuzione | Docker Compose | Installazione, aggiornamento e ripristino ripetibili senza orchestratori |
| Artefatto Production | Immagine `linux/arm64` pubblica su GHCR, attestata e distribuita per digest | Build unica e verificabile, deploy riproducibile e rollback senza compilare sulla VPS |
| Ambienti | Development e Production soltanto | Un terzo ambiente senza bisogno osservato duplicherebbe dati, segreti e configurazione |
| Repository | GitHub pubblico, `main` protetto e branch brevi | Il codice è ispezionabile; la visibilità non richiede un secondo branch né rende l'app multi-tenant |
| Licenza | Nessun file `LICENSE` finché il titolare non concede esplicitamente diritti di riuso | Repository pubblica non significa automaticamente open source |
| CI/CD | GitHub Actions come unica corsia; nessun deploy automatico al merge | Evita drift fra sistemi e conserva il gate di autorizzazione Production |
| Review Codex | Required check legato all'HEAD esatto, riusando il gate già collaudato in CF Ready | Impedisce di unire commit non revisionati senza progettare una seconda automazione equivalente |
| Gate deploy | GitHub Environment `Production` protetto e approvato dal titolare | I segreti di deploy diventano accessibili soltanto dopo il gate manuale sul commit ammesso |
| Toolchain runtime | Node.js/npm scelti in 14.3 e versionati soltanto negli artefatti M0 | Applica la decisione esplicita latest-first e allinea Mac, CI e build Docker senza affidarsi alle versioni globali |
| Lint e formato | Oxlint e Oxfmt con pin esatto; niente ESLint/Prettier iniziali | Riusa una toolchain veloce già adottata in CF Ready senza duplicare strumenti equivalenti |
| Test browser dell'app | Playwright con Chromium sulle PR e Chromium+WebKit in M8 | Rende riproducibili i flussi HF e fornisce trace diagnostiche senza estendere indiscriminatamente la matrice browser |
| Integrazione Aruba | Account Base e pannello web ufficiale; nessuna API Premium | Elimina un costo ricorrente sproporzionato per un'app single-user |
| Helper Aruba | Un solo helper locale TypeScript/Playwright per Windows e macOS, con Chrome o Edge installato | La sessione autenticata resta sul computer dell'utente e la stessa implementazione copre entrambi i sistemi operativi |
| Modalità helper | `Assistita` di default e `Automatica dopo conferma` opzionale | Consente di scegliere il livello di automazione senza rimuovere l'approvazione esplicita |
| Comparatore fiscale | Diff strutturato server-side fra sorgente, bozza e proiezione XML | Rende visibili trasformazioni, correzioni e arrotondamenti senza affidarsi a un fragile confronto testuale dell'XML |
| Versionamento | `package.json` + SemVer/tag per le release Production | Collega codice e artefatto senza imporre bump alle modifiche locali o documentali |
| Pubblicazione release | GitHub Release immutabile con note generate e manifest tecnico | Rende leggibile e non riscrivibile il legame fra versione, commit, immagine, schema e rollback |
| Aggiornamenti automatici | Auto-merge soltanto per patch delle dev dependency dirette | Riduce manutenzione ordinaria senza modificare automaticamente runtime, provider, workflow o Production |
| Versioni dipendenze | La matrice 14.3 fissa le scelte; manifest, lockfile, `mise.toml` e digest fissano le versioni | Evita pin duplicati nel piano e impone una sola risoluzione verificata prima del codice |
| Backend | Monolite TypeScript/Node.js secondo lo stack 14.3 | Volume ridotto e integrazioni più semplici in un solo deploy |
| Frontend | React con React Router in modalità framework secondo lo stack 14.3 | Pannello autonomo full-stack nello stack TypeScript, senza dipendere dall'Admin Shopify |
| Analisi React | React Doctor stabile con scansione completa bloccante nel gate locale/CI e Action ufficiale advisory sulle modifiche delle PR | Conserva diagnosi React complete e feedback inline senza delegare l'esito bloccante a un servizio esterno |
| Identità visiva | Brand Foundation leggera, versionata prima della UI definitiva | Evita decisioni visive sparse senza introdurre un design system o un sito non necessari |
| Database | PostgreSQL locale, driver `pg` e SQL versionato secondo 14.3 | Transazioni, vincoli, audit e code senza ORM o migration CLI aggiuntive |
| Coda | Basata su PostgreSQL | Evita Redis e un servizio aggiuntivo; carico di poche centinaia di ordini al mese |
| Storage documenti | Filesystem persistente VPS + metadati DB | XML/PDF/notifiche consultabili senza dipendere da Aruba |
| Dominio funzionale | "Scheda di fatturazione", breve "Scheda" | "Pratica" è stato giudicato fuorviante |
| Generazione | Impostazione globale: pagamento o evasione completa | Un solo comportamento coerente per Shopify ed eBay |
| Approvazione | Sempre esplicita | Nessun invio fiscale senza una conferma riferita ai documenti esatti |
| Canary Aruba | Permesso monouso atomico legato al batch, ai documenti, alle revisioni e agli hash XML, con kill switch globale ancora disabilitato | Un crash non può lasciare aperti gli invii Production né autorizzare documenti diversi dai candidati |
| Fattura | Una riga semplificata per ordine | Non serve replicare il dettaglio commerciale delle piattaforme |
| Sconti/spedizione | Assorbiti nell'importo netto della riga ordine | Il documento deve restare semplice; il dettaglio resta interno |
| Commissioni | Mai in fattura | Sono costi del venditore, non corrispettivo del cliente |
| Raggruppamento | Automatico per cliente e data ordine Europe/Rome | Riduce documenti mantenendo un criterio chiaro e riproducibile |
| Pagamenti pendenti | Consentiti con seconda conferma | L'utente può emettere, ma il rischio deve essere evidente e registrato |
| Differenze importo | Consentite con seconda conferma e motivazione obbligatoria | Sono ammesse correzioni operative senza perdere la tracciabilità |
| Rimborsi | Bozza automatica di nota di credito | Evita lavoro manuale, senza rimuovere l'approvazione |
| Rimborsi multipli | Una bozza TD04 cumulativa aperta | Riduce documenti; dopo l'emissione si apre un nuovo cumulativo |
| Copia cliente | Automatico o manuale, configurazione globale | Il titolare sceglie il modello operativo e può derogare in approvazione |
| E-mail mittente | Indirizzo già usato dal negozio tramite un solo trasporto SMTP canonico | Coerenza per il cliente ed esiti riconciliabili senza duplicare provider o fallback |
| Trasporto e-mail | PoC OCI Email Delivery in Development; adozione solo se dominio, deliverability e limiti sono idonei | Valuta una risorsa OCI inclusa senza sostituire alla cieca l'SMTP esistente |
| Backup | Giornaliero, cifrato client-side e caricato in un bucket OCI privato tramite Instance Principal; copie periodiche e recovery kit locale protetto sul Mac | Usa il servizio nativo già disponibile, non conserva chiavi di decifratura sulla VPS e riduce la perdita massima senza aggiungere provider |
| Monitor infrastruttura | OCI Monitoring e Notifications con quattro allarmi iniziali | Usa funzioni native comprese nelle quote gratuite senza aggiungere un altro servizio |
| Disponibilità esterna | Un monitor HTTP OCI APM ogni 6 minuti | Verifica dall'esterno Dynu, DNS, TLS, Caddy e applicazione senza transazioni o dati reali |
| Evidenze | Preflight, ricevuta, readback e rollback per ogni scrittura remota | Un comando riuscito non dimostra target e stato live corretti |
| Documentazione | Master Plan, indice e fonti canoniche senza duplicazioni | Riduce istruzioni in drift e rende verificabile ogni handover |
| Storico iniziale | Ultimi 7 giorni | Perimetro limitato ma sufficiente alla transizione |
| Lingua | Solo italiano | Requisito 1.x; evitare infrastruttura i18n non richiesta |

### 4.1 Decisioni confermate con condizione

| Funzione | Condizione |
|---|---|
| Propagazione delle correzioni a Shopify | Implementarla solo per i campi cliente realmente scrivibili tramite Admin GraphQL API, senza alterare lo snapshot dell'ordine; resta disattivata di default |
| PDF ufficiale Aruba | Usarlo se il pannello ne consente il download affidabile; altrimenti generare un PDF sobrio e allineato al campione Aruba |
| OCI Email Delivery | Adottarlo come trasporto canonico solo se il dominio mittente è controllato, SPF/DKIM e approved sender sono verificati e il PoC supera consegna, errore e reinvio; altrimenti mantenere l'SMTP esistente |

### 4.2 Decisioni e proposte superate

Queste alternative sono riportate per evitare che un agente futuro le reintroduca:

| Proposta iniziale | Esito finale | Motivo |
|---|---|---|
| Web Services Aruba Premium | Superata | Il costo non è proporzionato all'uso single-user; la 1.x usa l'account Base e il pannello web |
| Bozza modificabile creata nel pannello Aruba via API | Superata | La bozza operativa vive in HF; il pannello riceve l'XML finale |
| Automazione browser sulla VPS | Superata | Login, 2FA, CAPTCHA e sessione autenticata devono restare sul computer presidiato dal titolare |
| Endpoint privati osservati nel browser | Superata | Sono fragili, non documentati e non costituiscono un contratto supportato |
| App incorporata nell'Admin Shopify | Superata | Scelto pannello autonomo, perché Shopify ed eBay hanno pari importanza |
| App pubblica/multi-merchant | Superata per la 1.x | Uso esclusivo dell'attività del titolare |
| Cloudflare Workers/D1/R2/Queues | Valutata e non scelta | La VPS OCI è stata scelta esplicitamente; evita limiti runtime e adattamenti edge |
| Vercel + Supabase o Render Free | Valutate e non scelte | Vincoli dei piani gratuiti e minore aderenza all'uso commerciale continuativo |
| DuckDNS | Sostituito da Dynu | Dynu è stato approvato come hostname di produzione |
| Cloudflare Quick Tunnel/ngrok in produzione | Superata | Ammessi soltanto per sviluppo temporaneo |
| Motore OSS, monitor soglia UE e aliquote estere | Superata | Tutte le vendite 1.x usano il profilo del regime del margine |
| VIES come decisore del trattamento IVA | Superata | Una VAT UE non fa uscire automaticamente l'ordine dal regime del margine |
| Fattura 1:1 con prodotti, sconti e spedizione | Superata | Scelta una riga netta e semplice per ordine |
| Una fattura per ogni ordine | Superata | Scelto accorpamento automatico giornaliero per cliente |
| Termine "Pratica" | Superato | Sostituito da "Scheda di fatturazione" |
| Nessun backup | Evoluto | Scelto backup automatico cifrato su OCI Object Storage con seconda copia periodica sul Mac |

---

## 5. Terminologia e modello concettuale

### 5.1 Scheda di fatturazione

La **Scheda di fatturazione** è il contenitore del ciclo documentale. Collega:

- uno o più ordini Shopify/eBay;
- la bozza e la fattura emessa;
- rimborsi;
- una o più note di credito nel tempo;
- upload e identificativi Aruba;
- notifiche ed esiti SdI;
- copie XML e PDF;
- invii e-mail;
- anomalie, conferme eccezionali e audit.

Esempio:

```text
Scheda HF-000154
├── Ordine Shopify #1001
├── Ordine eBay 12-12345-67890
├── Fattura (TipoDocumento definito dall'audit)
│   ├── XML
│   ├── PDF
│   ├── Upload Aruba
│   └── Notifiche SdI
├── Rimborso eBay
├── Nota di credito TD04
└── Registro attività
```

Nel codice usare un nome tecnico diretto e stabile, per esempio `billing_case`. Evitare gerarchie astratte non necessarie.

### 5.2 Stati principali

Gli stati vanno modellati come enum espliciti e transizioni validate, non come stringhe arbitrarie.

Ordine:

```text
IMPORTED
WAITING_FOR_TRIGGER
ELIGIBLE
GROUPED
CANCELLED_NO_DOCUMENT
REFUNDED_BEFORE_ISSUE
INVOICED
NEEDS_REVIEW
```

Scheda:

```text
DRAFT
NEEDS_REVIEW
READY
DO_NOT_TRANSMIT
APPROVED
SENDING
SENT_TO_ARUBA
SDI_PROCESSING
DELIVERED
NOT_DELIVERED
REJECTED
SEND_FAILED
CLOSED
```

Documento:

```text
DRAFT
VALIDATION_FAILED
VALIDATED
NUMBERED
NUMBERED_VALIDATION_FAILED
UPLOAD_PENDING
UPLOADED
SDI_PROCESSING
DELIVERED
NOT_DELIVERED
REJECTED
RETRY_REQUIRED
ARCHIVED
```

I nomi definitivi possono essere adattati in implementazione, ma il significato e l'irreversibilità dei passaggi fiscali devono restare.

### 5.3 Glossario canonico

Creare `docs/glossario.md` quando nasce il primo testo UI. Deve fissare i termini visibili e il loro significato senza duplicare requisiti o microcopy completa. Per ogni voce indicare termine italiano, eventuale equivalente tecnico inglese, significato e formulazioni da non usare. Copertura minima:

- Scheda di fatturazione e Scheda;
- bozza, approvazione, numerazione, trasmissione, consegna e scarto;
- fattura, nota di credito e rimborso;
- totale sorgente, totale documento e differenza;
- pagamento pendente e `Non trasmettere`;
- Shopify, eBay, Aruba e SdI;
- Development, Production, publish Git, deploy e release.

Il catalogo italiano dei testi resta la fonte del copy applicativo. Il glossario impedisce sinonimi incoerenti fra UI, supporto, runbook ed evidenze.

---

## 6. Profilo fiscale e responsabilità

### 6.1 Decisione fiscale

Tutti gli articoli della 1.x sono venduti nel **regime del margine**, con IVA non esposta. Il profilo atteso usa la Natura **N5**, ma la struttura esatta non va presunta: deve essere copiata e testata a partire dalla configurazione Aruba e da un XML già trasmesso e accettato.

Il campo `RegimeFiscale` del cedente non deve essere dedotto dal solo fatto che la vendita è in regime del margine. In particolare non usare `RF09` come sinonimo di regime del margine. Il valore reale va rilevato dall'XML Aruba o confermato dal commercialista.

### 6.2 Responsabilità di HF

HF:

- importa e normalizza i dati;
- applica un unico profilo fiscale preconfigurato;
- prepara le righe semplificate;
- genera l'XML completo;
- esegue controlli interni e validazione XSD locale;
- prepara batch immutabili e permessi monouso;
- raccoglie l'approvazione;
- numera solo secondo le regole verificate;
- guida l'helper locale nel caricamento e, quando autorizzato, nell'invio;
- riconcilia e archivia gli esiti letti o scaricati dal pannello Aruba.

### 6.3 Responsabilità di Aruba

Aruba, tramite il pannello web dell'account Base:

- riceve l'XML completo;
- effettua controlli formali ed extraschema secondo il servizio disponibile;
- gestisce eventuale firma;
- trasmette allo SdI;
- espone notifiche ed esiti;
- conserva a norma secondo il contratto attivo.

### 6.4 Fuori responsabilità di HF

HF non:

- calcola il margine contabile;
- gestisce registri acquisti/vendite;
- esegue liquidazioni IVA;
- decide autonomamente trattamenti fiscali eccezionali;
- trasforma una VAT UE in una cessione intracomunitaria;
- gestisce OSS o la soglia UE di 10.000 euro.

La precedente ipotesi di monitor OSS/soglia è stata esplicitamente abbandonata perché tutte le vendite comprese nella 1.x ricadono nel profilo del margine.

### 6.5 Destinatari e dati necessari

HF deve distinguere, per completezza anagrafica e recapito del documento:

- privato italiano;
- azienda/professionista italiano;
- cliente UE non stabilito in Italia;
- destinatario da verificare.

Il profilo fiscale della vendita resta quello del margine: questa classificazione non deve attivare OSS, IVA estera o cessione intracomunitaria.

Controlli minimi prima dell'approvazione:

| Destinatario | Dati attesi | Esito se incompleto |
|---|---|---|
| Privato italiano | nome, cognome, Codice Fiscale, indirizzo di fatturazione completo | `NEEDS_REVIEW` |
| Azienda/professionista italiano | denominazione o nome, P.IVA, eventuale Codice Fiscale, indirizzo, codice SdI o PEC se comunicati | `NEEDS_REVIEW` |
| Cliente UE | nome/denominazione, Paese, indirizzo completo, identificativo fiscale quando disponibile | `NEEDS_REVIEW` solo per dati obbligatori mancanti |

I valori convenzionali discussi sono `0000000` per destinatari italiani senza canale comunicato e `XXXXXXX` per destinatari esteri. Sono **ipotesi da verificare** nell'XML Aruba accettato e nella documentazione FatturaPA corrente prima di fissarli nel generatore.

HF può salvare e normalizzare una VAT UE come dato anagrafico e chiave di matching. Non deve introdurre un'integrazione VIES nella 1.x né usarne l'esito per cambiare il trattamento fiscale.

---

## 7. Flussi funzionali

### 7.1 Importazione ordine

1. HF riceve un webhook o esegue una sincronizzazione periodica.
2. Salva l'evento ricevuto in modo idempotente.
3. Recupera il dettaglio completo dell'ordine dalla piattaforma.
4. Conserva il payload originale minimizzato ai dati necessari.
5. Normalizza cliente, indirizzi, identificativi fiscali, righe, totale, sconti, spedizione, pagamento e stato di evasione.
6. Verifica la valuta: solo EUR è ammessa; altro valore porta a errore bloccante.
7. Valuta il trigger globale:
   - ordine interamente pagato; oppure
   - ordine completamente evaso/spedito.
8. Se non idoneo, imposta `WAITING_FOR_TRIGGER`.
9. Se annullato prima del trigger, conserva l'ordine come `CANCELLED_NO_DOCUMENT`.
10. Se idoneo, cerca o crea la Scheda giornaliera compatibile.

La piattaforma resta fonte del dato originario. Una risincronizzazione non deve sovrascrivere modifiche manuali della bozza: registra la differenza e richiede revisione quando è rilevante.

Dati fiscali o anagrafici mancanti non impediscono la creazione della bozza interna: la Scheda nasce in `NEEDS_REVIEW` e resta non approvabile finché i campi obbligatori non sono completati.

### 7.2 Trigger globale di generazione

Impostazione unica per Shopify ed eBay:

- **Alla conferma del pagamento**: la bozza nasce quando l'ordine è interamente pagato.
- **Alla completa evasione/spedizione**: la bozza nasce solo all'evasione completa; spedizioni parziali non bastano.

L'ordine viene comunque importato subito. Il cambio dell'impostazione:

- non modifica o ricrea bozze esistenti;
- rivaluta gli ordini ancora senza bozza;
- si applica operativamente agli ordini idonei non ancora raggruppati;
- lascia disponibile la generazione manuale anticipata per un singolo ordine.

### 7.3 Identità cliente e raggruppamento

HF crea automaticamente una Scheda cumulativa per ordini compatibili dello stesso cliente e della stessa data ordine nel fuso `Europe/Rome`.

Compatibilità minima:

- stesso cliente fiscale;
- stessa valuta EUR;
- stesso profilo fiscale;
- stesso tipo documento;
- stessa data ordine locale;
- ordini non già assegnati ad altro documento;
- nessuna anomalia bloccante.

Priorità per riconoscere l'identità:

1. codice fiscale;
2. partita IVA;
3. altro identificativo fiscale coerente;
4. in assenza, corrispondenza esatta e normalizzata di nome/ragione sociale, indirizzo ed e-mail.

L'e-mail da sola non basta. Nei casi ambigui non accorpare: creare Schede separate e mostrare una possibile corrispondenza.

Ordini Shopify ed eBay possono confluire nella stessa Scheda. Se una Scheda è già approvata e arriva un altro ordine dello stesso giorno, crearne una nuova senza modificare quella emessa.

### 7.4 Bozza di fattura semplificata

La fattura non replica prodotti, coupon o spedizione 1:1.

Per ciascun ordine incluso creare una riga:

```text
Vendita beni usati - Ordine Shopify #1234     120,00 EUR
Vendita beni usati - Ordine eBay #5678         75,00 EUR
```

Regole:

- quantità predefinita `1`;
- importo pari al totale effettivamente addebitato al cliente per quell'ordine;
- sconti già assorbiti;
- spedizione inclusa;
- commissioni marketplace e payment provider escluse;
- Natura e diciture secondo il profilo Aruba verificato;
- totale documento uguale alla somma delle righe, salvo modifica manuale esplicitamente confermata.

Internamente conservare il dettaglio di prodotti, sconti, spedizione, pagamenti e rimborsi per riconciliazione e note di credito. Le commissioni possono essere importate solo se già disponibili e utili al controllo, ma non sono un requisito del documento e non devono rallentare la 1.x.

### 7.5 Modifiche prima dell'approvazione

L'utente può modificare:

- dati fiscali e anagrafici del cliente;
- descrizione delle righe;
- quantità;
- importi;
- ripartizione fra ordini;
- modalità e stato del pagamento;
- causale e note;
- inclusione o esclusione degli ordini.

Ogni modifica registra:

- valore importato;
- valore precedente;
- valore nuovo;
- autore;
- timestamp;
- motivazione, se richiesta.

Se il totale differisce dagli ordini:

- mostra totale originale, totale documento e differenza;
- escludi la Scheda dall'approvazione massiva standard;
- richiedi seconda conferma;
- rendi obbligatoria una motivazione;
- registra l'eccezione nell'audit.

### 7.6 Approvazione e trasmissione

Flusso normale:

1. Controlli bloccanti locali.
2. Anteprima del documento.
3. Proiezione XML e validazione XSD locale.
4. Conferma esplicita: **"Approva, numera e prepara per Aruba"**. In modalità automatica il riepilogo specifica anche che l'helper potrà eseguire l'ultimo clic per quel batch.
5. Assegnazione atomica di numero e data secondo configurazione verificata.
6. Generazione e archiviazione immutabile dell'XML finale.
7. Creazione del manifest del batch con documenti, revisioni e hash SHA-256 esatti. In modalità automatica viene creato anche un permesso monouso a scadenza breve.
8. Avvio volontario dell'helper locale, che verifica hostname Aruba, account atteso, modalità e manifest; se la sessione non è valida mette in pausa il flusso per login, password, OTP 2FA o CAPTCHA umani.
9. Caricamento degli XML tramite l'interfaccia web documentata e lettura dell'esito di validazione. Qualunque errore arresta il batch prima dell'invio.
10. In modalità `Assistita`, arresto prima dell'ultimo clic e invio eseguito dal titolare nel pannello. In modalità `Automatica dopo conferma`, rilettura e consumo atomico del permesso, nuovo confronto del batch e solo allora clic finale dell'helper.
11. Archiviazione dell'esito tecnico sanitizzato e riconciliazione dal pannello e dai file XML, PDF e notifiche scaricati.

Nessuna bozza ottiene numero fiscale definitivo prima dell'approvazione. Una fattura approvata non è più modificabile.

L'ordine esatto fra prenotazione del numero, validazione tramite upload, correzione e riuso del progressivo viene definito e testato in **M4-M5**. Non inventare una politica: deve riflettere Aruba, l'XML reale e la regola fiscale confermata.

L'approvazione massiva:

- include solo Schede `READY`;
- esclude pagamenti pendenti;
- esclude differenze d'importo;
- esclude errori fiscali/anagrafici;
- mostra conteggio e totale;
- richiede una conferma finale unica;
- processa ogni documento separatamente, senza trasformare un errore in duplicato.

### 7.7 Pagamento pendente

Se il trigger è l'evasione completa, una bozza può essere pronta mentre il pagamento è ancora pendente.

Comportamento:

- avviso evidente `Pagamento non ancora acquisito`;
- esclusione dalle approvazioni massive;
- seconda conferma obbligatoria:
  **"Confermo di voler emettere e trasmettere la fattura nonostante il pagamento risulti pendente."**
- motivazione facoltativa;
- audit di stato pagamento e conferma;
- incasso successivo aggiorna la Scheda, non la fattura emessa.

Per contrassegni o metodi non aggiornati automaticamente, consentire la registrazione manuale dell'incasso senza modificare l'ordine sorgente.

### 7.8 Non trasmettere

L'utente può marcare una bozza:

- `DO_NOT_TRANSMIT`;
- con motivazione, per esempio annullato, test, duplicato, già fatturato altrove o altra eccezione.

La bozza:

- non riceve numero fiscale;
- non viene eliminata;
- resta in archivio e nell'audit;
- può essere riattivata finché compatibile con lo stato documentale.

### 7.9 Scarto e retry

Se Aruba o SdI scartano:

- non creare automaticamente una nuova fattura;
- non generare una nota di credito per il documento scartato;
- bloccare modifiche al file inviato ma permettere una nuova revisione/riedizione secondo la procedura verificata;
- conservare ogni tentativo;
- assicurare che il retry tecnico dello stesso XML non generi duplicati;
- distinguere errore di rete, rifiuto Aruba, scarto SdI e stato incerto.

Se l'esito dell'upload o dell'invio è incerto, non ritentare automaticamente. L'helper deve prima cercare il documento nel pannello per numero, data, destinatario e totale e, quando possibile, scaricare l'XML per confrontarne l'hash. Soltanto un esito certo può consentire un nuovo tentativo esplicitamente autorizzato.

### 7.10 Rimborsi prima dell'emissione

- Rimborso totale o annullamento: marcare la bozza `Non trasmettere - ordine annullato/rimborsato`.
- Rimborso parziale: aggiornare l'importo della bozza se la riconciliazione è certa.
- Riconciliazione ambigua: `NEEDS_REVIEW`.
- Nessuna nota di credito, perché non esiste ancora una fattura emessa.

### 7.11 Rimborsi dopo l'emissione e note di credito

Quando un rimborso risulta completato:

1. Identificarlo con chiave unica:
   `platform + account + order_id + refund_id`.
2. Collegarlo alla fattura originaria.
3. Cercare una bozza TD04 ancora aperta per la stessa fattura.
4. Se esiste, aggiornarla cumulativamente.
5. Se non esiste, crearla.
6. Ereditare il cliente e il profilo fiscale dalla fattura originaria.
7. Inserire riferimenti alla fattura originaria nel blocco FatturaPA appropriato.
8. Usare righe semplificate per ordine/importo rimborsato.
9. Richiedere approvazione esplicita.

Vincoli:

- somma note di credito non superiore al totale originario;
- stesso rimborso mai contabilizzato due volte;
- una nota emessa è immutabile;
- rimborsi successivi all'emissione aprono una nuova bozza cumulativa;
- rimborso `pending` non genera nota;
- per eBay, se gli importi disponibili non rappresentano con certezza quanto restituito all'acquirente, bloccare e chiedere verifica.

### 7.12 Annullamenti

Gli ordini annullati prima dell'emissione vengono conservati come Schede/ordini chiusi, nascosti di default dalle code operative ma disponibili in archivio, ricerca e audit.

---

## 8. Connettore Shopify

### 8.1 Principi

- Creare un'app custom destinata al solo store del titolare; nessuna pubblicazione sull'App Store.
- Usare esclusivamente la GraphQL Admin API corrente supportata per la nuova integrazione; non costruire il connettore sulla REST Admin API legacy.
- All'inizio di M3 fissare nel contratto del connettore una versione API stabile supportata, la relativa finestra di supporto e il comando che verifica query e fixture contro lo schema corrente; non usare l'alias `latest` nel runtime.
- Usare OAuth e scope minimi.
- Verificare e richiedere l'accesso ai protected customer data necessario.
- Preferire webhook per gli aggiornamenti, con sincronizzazione periodica di recupero.
- Verificare la versione API e i campi reali nello store prima di congelare le query.

### 8.2 Dati da importare

- ID e numero ordine.
- Date di creazione e aggiornamento.
- Stato pagamento.
- Stato evasione e spedizioni parziali/completa.
- Cliente, e-mail, telefono se necessario.
- Indirizzo di fatturazione e spedizione.
- Totali in EUR.
- Righe, quantità, sconti e spedizione per riconciliazione interna.
- Transazioni e rimborsi.
- Campi fiscali localizzati dell'ordine.
- Eventuale tax ID dell'anagrafica come fallback.

### 8.3 Dati fiscali Shopify

Priorità prevista:

1. campi localizzati dello specifico ordine (`Order.localizedFields` o equivalente corrente);
2. tax ID dell'anagrafica cliente (`Customer.taxSettings.taxId` o equivalente corrente);
3. anagrafica interna HF;
4. inserimento manuale.

Non mappare un campo soltanto dal titolo visualizzato, che può cambiare con lingua/configurazione. Salvare `key`, `countryCode`, `purpose`, `title`, `value` e il payload utile; usare `key` e `purpose` come riferimenti stabili quando la risposta reale li valorizza e configurare il mapping a partire da ordini reali.

Il fallback sull'anagrafica può richiedere scope aggiuntivi come `read_customers` o `read_taxes` e l'approvazione dei protected customer data: verificare i requisiti della versione API corrente e non richiedere scope non utilizzati.

Il dato dell'ordine è una fotografia storica. Una modifica successiva del cliente non deve alterare automaticamente una fattura già generata.

Riferimenti ufficiali da verificare quando si fissa il contratto del connettore:

- [`Order.localizedFields` e `LocalizedField`](https://shopify.dev/docs/api/admin-graphql/latest/objects/LocalizedField) confermano `key`, `countryCode`, `purpose`, `title` e `value`;
- [`Customer.taxSettings`](https://shopify.dev/docs/api/admin-graphql/latest/objects/TaxSettings) conferma `taxId` in sola lettura con scope `read_customers` o `read_taxes`;
- l'accesso resta soggetto ai protected customer data applicabili.

### 8.4 Propagazione correzioni

Impostazione facoltativa, disattivata di default:

**"Propaga le correzioni all'anagrafica cliente Shopify"**

- può aggiornare, quando consentito, nome, contatti e indirizzi del cliente;
- non modifica retroattivamente l'ordine;
- non tenta di scrivere campi fiscali non scrivibili;
- un errore di propagazione non blocca la fattura;
- ogni scrittura è esplicita e registrata.

### 8.5 Webhook minimi da verificare

- creazione/aggiornamento ordine;
- variazione pagamento;
- evasione;
- annullamento;
- rimborso;
- disinstallazione/revoca app;
- eventuali webhook obbligatori privacy.

Non fissare i nomi dei topic senza verifica sulla versione API corrente.

---

## 9. Connettore eBay

### 9.1 Principi

- OAuth 2.0 con ambienti Sandbox e Produzione separati.
- All'inizio di M3 registrare endpoint/versione effettivi, note di deprecazione applicabili e contract test correnti; un cambiamento del provider riapre il contratto prima di modificare il mapper.
- Import incrementale tramite API ordini.
- Recupero del dettaglio di ogni nuovo ordine.
- Polling periodico affidabile; webhook/notifiche solo se disponibili e utili.
- Conservazione del cursore e sovrapposizione temporale per non perdere aggiornamenti.
- Considerare che la Fulfillment API restituisce ordini che hanno completato il checkout: alcuni acquisti con pagamento anticipato ancora pendente possono non comparire in `getOrders` finché non completano quella fase. HF può applicare il flusso `Pagamento pendente` soltanto a ordini effettivamente esposti e importati.

### 9.2 Dati da importare

- ID ordine e riferimento leggibile.
- Date e stato.
- Buyer e indirizzi.
- Totali EUR.
- Righe e costi accessori per riconciliazione.
- Stato pagamento e fulfillment.
- Rimborsi con ID, data, stato e importo.
- Identificativo fiscale del compratore.

### 9.3 Tax identifier

Il piano assume che il dato fiscale sia disponibile nel dettaglio del singolo ordine, non necessariamente nell'elenco. Implementare:

`getOrders -> per ogni nuovo/aggiornato ordine -> getOrder(orderId) -> buyer.taxIdentifier`

Per venditori italiani il valore può rappresentare Codice Fiscale oppure P.IVA. Non dedurne il tipo soltanto dalla presenza: conservare il tipo dichiarato da eBay e validare il formato; i casi incoerenti restano da verificare.

Conservare:

- valore originale;
- tipo dichiarato da eBay;
- valore normalizzato;
- sorgente;
- timestamp importazione.

Verificare la forma reale dell'API e dei payload con l'account del titolare prima di completare il mapper.

La [documentazione ufficiale eBay del tipo `Buyer`](https://developer.ebay.com/api-docs/sell/fulfillment/types/sel%3ABuyer) indica che `taxIdentifier` è disponibile per ordini dei marketplace italiano e spagnolo e viene restituito da `getOrder`, non da `getOrders`. La [Fulfillment API](https://developer.ebay.com/develop/api/sell/fulfillment_api) indica inoltre che `getOrders` include soltanto transazioni che hanno completato il checkout. Entrambe vanno riverificate quando si fissa il contratto.

### 9.4 Rimborsi e prudenza

Alcuni importi eBay possono essere importi netti del venditore invece del totale restituito al compratore. Se non è possibile riconciliare con certezza il rimborso e la fattura originaria, non indovinare: mettere la nota di credito in `NEEDS_REVIEW`.

### 9.5 Correzioni

Nessuna propagazione dei dati cliente verso eBay nella 1.x. Le correzioni restano in HF.

---

## 10. Integrazione Aruba e SdI tramite pannello web

### 10.1 Assunzione di accesso

Il titolare possiede un account Aruba Base. La 1.x non richiede Web Services Premium e non usa endpoint Aruba privati o non documentati.

Vincolo di accettazione: nessuna milestone, requisito o Definition of Done può dipendere dall'abilitazione di API Aruba o da un upgrade Premium. Se una funzione non è realizzabile in modo affidabile tramite pannello web e file ufficiali, resta nel fallback manuale oppure viene esclusa dalla 1.x; non diventa un prerequisito a pagamento.

Sviluppare due ambienti applicativi e un fallback:

- `mock`, con una pagina Aruba sintetica locale per sviluppo, contract test ed E2E;
- `production`, con il pannello web reale soltanto nelle attività autorizzate di M5 e successive;
- `manuale`, esportando gli XML da HF e importando in seguito file ed esiti scaricati da Aruba.

Credenziali, cookie, session storage, codici OTP e seed TOTP non entrano mai in HF, nel repository, nei prompt o nei log. Il profilo browser persistente è creato e posseduto dall'utente sul proprio computer.

### 10.1.1 Ipotesi operative da verificare

La documentazione ufficiale e le osservazioni preliminari non ancora registrate come evidenza indicano:

- caricamento tramite selettore file XML con supporto multiplo;
- limite corrente mostrato dal pannello di 300 documenti, 30 MB complessivi e 4,9 MB per file, da rileggere prima di fissare un batch;
- separazione fra caricamento/validazione e invio finale;
- con 2FA attiva, richiesta del codice a ogni nuova autenticazione ma non di un SMS per ogni upload; senza 2FA il pannello può richiedere autorizzazione SMS per ciascun caricamento;
- ricerca e dettaglio delle fatture inviate, timeline degli stati e download PDF, XML e P7M;
- download massivo supportato dal pannello.

Riferimenti di partenza: [caricamento XML](https://guide.aruba.it/soluzioni-fatturazione-elettronica/fe/fatture-documenti/carica-fatture/come-caricare-fatture-formato-xml-pannello), [accesso e 2FA](https://guide.aruba.it/soluzioni-fatturazione-elettronica/fe/accesso-homepage/accesso-pannello-e-app/come-accedere-pannello-fe) e [download delle fatture inviate](https://guide.aruba.it/soluzioni-fatturazione-elettronica/fe/fatture-inviate-ricevute-bozze/fatture-inviate/come-scaricare-fatture-inviate).

Questi dettagli restano ipotesi fino all'audit M4 registrato in un'evidenza sanitizzata con ambiente, account, data, readback e limiti osservati. Dopo la conferma diventano il contratto operativo verificato dagli smoke sintetici; il DOM del pannello può cambiare senza versionamento.

### 10.2 Helper locale multipiattaforma

L'helper è un comando TypeScript/Playwright della stessa repository, avviato dal titolare sul proprio computer. Usa un'installazione locale stabile di Chrome o Edge e un profilo browser dedicato. La stessa implementazione deve funzionare su Windows e macOS; non introdurre due automazioni native. Safari resta utilizzabile soltanto per il percorso manuale.

Il server HF non ospita un browser Aruba e non riceve la sessione. L'helper riceve da HF un token casuale, revocabile, a scadenza breve e vincolato al solo batch; recupera il manifest via HTTPS e invia a HF soltanto stato, identificativi tecnici e readback sanitizzato. Questa comunicazione usa esclusivamente endpoint interni di Hub Fatture, non API Aruba. Il token non autorizza il clic finale, che richiede il distinto permesso monouso. L'helper non legge né esporta cookie o local storage e non deve tentare di aggirare CAPTCHA o controlli anti-automazione.

Usare soltanto la UI visibile e gli URL ufficiali Aruba, con allowlist stretta dell'hostname e locatori semantici. Non chiamare endpoint interni scoperti tramite DevTools. Prima di ogni azione irreversibile rileggere account, ambiente, documenti e modalità autorizzati.

### 10.3 Modalità selezionabili in Impostazioni

- **Assistita**, default: l'helper apre il pannello, attende l'eventuale autenticazione umana, carica gli XML, legge la validazione e si ferma prima dell'ultimo clic `Invia`. Il titolare controlla ed esegue il clic nel pannello.
- **Automatica dopo conferma**: dopo la stessa validazione, l'helper può eseguire `Invia` soltanto se esiste un permesso monouso non scaduto e non consumato per il manifest esatto. Qualunque mismatch o stato non riconosciuto arresta il flusso.

La scelta è globale ma viene mostrata nel riepilogo di ogni approvazione. Cambiarla non modifica batch già approvati.

### 10.4 Flusso atteso

1. HF genera e valida localmente gli XML definitivi.
2. HF crea il manifest immutabile del batch e, quando applicabile, il permesso monouso.
3. L'utente avvia l'helper dal proprio computer.
4. L'helper apre Chrome o Edge con il profilo dedicato e verifica il pannello Aruba reale.
5. Se necessario, l'utente completa login, password, OTP 2FA o CAPTCHA.
6. L'helper carica gli XML direttamente, senza salvarli come bozze Aruba modificabili.
7. L'helper legge e registra la validazione di ogni documento; un solo errore arresta il batch prima dell'invio.
8. L'helper si ferma oppure invia secondo la modalità autorizzata.
9. L'helper legge il primo esito disponibile e aggiorna HF.
10. Nei passaggi successivi riconcilia la lista e il dettaglio, scaricando i file ufficiali quando richiesto.

Non usare `Salva in bozze`: la guida Aruba avverte che data, numero e campi non gestiti dal pannello possono essere modificati o persi. L'XML approvato da HF deve restare il documento immutabile caricato e inviato.

### 10.5 Idempotenza e stato incerto

Prima del caricamento salvare:

- ID batch e documento interno;
- revisione e hash SHA-256 di ogni XML finale;
- numero e data;
- modalità autorizzata;
- scadenza e stato del permesso, quando presente;
- numero del tentativo.

Una caduta del browser, una navigazione inattesa o un esito ambiguo disabilitano il retry automatico. Cercare prima il documento nel pannello e confrontare metadati e, quando disponibile, XML scaricato. L'utente autorizza un nuovo tentativo soltanto dopo una riconciliazione certa.

### 10.6 Archiviazione e readback

Conservare localmente:

- XML generato e relativo hash;
- XML/P7M effettivamente scaricato da Aruba;
- PDF;
- esiti tecnici sanificati della sessione helper;
- notifiche Aruba/SdI;
- identificativi remoti visibili;
- timestamp dell'ultima riconciliazione e ultimo stato.

La riconciliazione non è un processo headless sulla VPS: avviene quando l'helper è aperto oppure tramite import manuale dei file scaricati. HF deve rendere visibile quanto è vecchio l'ultimo readback.

### 10.7 PDF

Priorità:

1. scaricare il PDF ufficiale dal pannello Aruba e verificarne resa e stabilità;
2. altrimenti generare in HF un PDF visivamente e informativamente allineato al modello Aruba.

Non creare un design personalizzato. L'audit deve verificare fatture italiane, estere e note di credito.

### 10.8 Fallback manuale

Il download XML da HF, il caricamento manuale nel pannello e l'import successivo di XML/PDF/notifiche costituiscono un percorso completo e sempre disponibile. È il fallback ufficiale in caso di modifica del pannello, browser non supportato, CAPTCHA persistente o helper indisponibile.

---

## 11. Qualifica Aruba nelle milestone M4-M5

Questa attività non è una corsia parallela. M4 incorpora le verifiche fiscali e documentali necessarie al generatore; M5 incorpora la prova del pannello e l'automazione. Repository, autenticazione, dominio ordini e connettori vengono completati prima secondo la sequenza delle milestone.

### 11.1 M4 - audit autenticato read-only del pannello Aruba

M4 esegue l'audit autenticato in sola lettura, verifica le ipotesi registrate in 10.1.1 e completa i dati fiscali e operativi mancanti senza modificare configurazioni, attivare 2FA, creare documenti o caricare XML.

#### 11.1.1 Dati da rilevare

- `RegimeFiscale` effettivo del cedente.
- Natura `N5` e struttura del riepilogo.
- `TipoDocumento` delle fatture e delle note.
- Dati del cedente/prestatore e del trasmittente.
- Codice destinatario per privati italiani, aziende italiane ed esteri.
- PEC e regole di priorità, se applicate.
- Dicitura del regime del margine.
- Causali.
- Modalità e condizioni di pagamento.
- Trattamento di spedizione, sconti, arrotondamenti.
- Formato e origine del PDF.
- Campi aggiuntivi impostati da Aruba.
- Meccanismo di ricerca documento nel pannello.
- Identificativi remoti.
- Notifiche e mapping degli stati SdI.
- Download XML/PDF/notifiche.
- Recupero del pacchetto di conservazione e opportunità di archiviarlo localmente o lasciarlo on demand.

### 11.2 M4 - analisi dell'XML Aruba accettato

Il titolare fornirà almeno un XML originale di fattura già trasmessa e accettata dallo SdI. Il PDF da solo non è sufficiente.

L'analisi deve:

1. preservare struttura, codici tecnici e relazioni fra i blocchi;
2. anonimizzare i dati personali per creare una fixture versionabile;
3. confrontare la fixture con lo schema FatturaPA ufficiale corrente;
4. estrarre in modo esplicito `RegimeFiscale`, Natura, riepiloghi, pagamento, causali, destinatario, trasmittente e riferimenti;
5. confrontare l'XML generato da HF con il campione, distinguendo differenze necessarie da differenze accidentali;
6. produrre un golden test che fallisca se il profilo documentale cambia involontariamente.

Se disponibile, ripetere il controllo su una nota di credito accettata. In sua assenza, il TD04 resta da validare con un caricamento controllato nel pannello prima della produzione.

### 11.3 M4 - numerazione e sezionali

Non implementare numerazione reale finché non sono stati verificati:

- numerazione unica o separata fra fatture e note di credito;
- eventuali sezionali;
- formato del numero;
- ultimo progressivo;
- cambio anno;
- data documento;
- ordine corretto fra prenotazione progressivo, validazione tramite upload e invio;
- comportamento dopo scarto;
- riuso o meno del numero;
- eventuali automatismi Aruba.

Durante lo sviluppo precedente a M4 usare una numerazione mock chiaramente non fiscale. L'audit read-only definisce una procedura candidata; M4 non è completata finché la prova controllata prevista in 11.4 non verifica anche l'ordine osservabile soltanto dopo l'upload. Qualunque divergenza aggiorna procedura, generatore e test prima di procedere a M5.

### 11.4 M4 - prova manuale controllata come gate di uscita

L'ultimo passaggio di M4 è una prova autorizzata con dati sintetici o anonimizzati: caricamento manuale di un XML fiscalmente valido prodotto da M4 e destinato esclusivamente alla prova, lettura della validazione e del riepilogo trasmissibile, verifica del controllo finale `Invia`, arresto prima dell'ultimo clic, readback e rimozione sicura dell'upload pendente. La prova chiude la procedura reale di numerazione e fissa il contratto minimo da cui M5 deriva la pagina sintetica e l'helper. Non caricare un XML valido né trasmettere nulla senza autorizzazione specifica; la prova non esegue alcun invio.

La prova registra:

- validazione ottenuta dal caricamento e formato degli errori visibili;
- limiti di upload riletti;
- locatori semantici necessari e schermate di arresto;
- comportamento della sessione persistente e delle pause per login, 2FA e CAPTCHA;
- tempi e limiti del readback assistito;
- download XML/PDF/notifiche;
- percorso manuale completo quando l'helper è indisponibile.

### 11.5 Materiali e output delle milestone

- accesso controllato al pannello Aruba;
- XML originale di una fattura accettata;
- PDF corrispondente;
- se disponibile, XML/PDF di una nota di credito;
- Chrome o Edge installato sul computer che eseguirà l'helper;
- decisione operativa e autorizzazione separata per l'attivazione della 2FA Aruba, consigliata per evitare l'SMS a ogni upload;
- conferma del commercialista per i valori fiscali non deducibili dai documenti.

M4-M5 aggiornano questa specifica o producono un ADR breve con:

- profilo fiscale finale;
- regole numerazione;
- mapping stati;
- esempio XML anonimizzato usato come fixture;
- contratto dei locatori e degli arresti dell'helper su Windows e macOS;
- differenze fra mock, pannello Production e fallback manuale;
- elenco dei dubbi ancora bloccanti.

---

## 12. E-mail al cliente

### 12.1 Configurazione globale

Modalità:

- **Automatica dopo approvazione**: inviare dopo che il pannello/readback Aruba conferma che l'invio è stato acquisito, mai dopo la sola validazione del file.
- **Manuale con approvazione**: nella schermata di approvazione l'utente decide per la singola Scheda.

Anche in modalità automatica, la schermata deve permettere di non inviare per una specifica Scheda prima dell'approvazione.

### 12.2 Mittente e trasporto

- Usare l'indirizzo e-mail già utilizzato dal negozio come `From` e, quando il trasporto lo espone, come envelope sender coerente.
- Usare un solo trasporto SMTP canonico in Production: provider esistente oppure OCI Email Delivery dopo il PoC previsto in §12.5.
- Non introdurre invio duplicato, bilanciamento o fallback automatico fra provider: un fallimento resta visibile e consente il reinvio manuale.
- Non aggiungere provider a pagamento.
- Configurare host, porta, TLS, username e password come segreti; il nome del trasporto scelto è configurazione non sensibile e visibile nella pagina Connessioni.

### 12.3 Contenuto e stato

Mostrare prima dell'invio:

- destinatario;
- oggetto;
- corpo;
- allegato;
- scelta invio/non invio.

Registrare:

- stato `pending/sent/failed`;
- data/ora;
- destinatario;
- Message-ID se disponibile;
- errore sanificato;
- tentativi.

Consentire reinvio manuale. Un errore e-mail non modifica lo stato fiscale del documento.

### 12.4 Momento esatto

La decisione confermata è inviare dopo che Aruba ha acquisito l'invio, non dopo il semplice caricamento/validazione e senza attendere necessariamente la consegna SdI. Rendere questo comportamento visibile, perché uno scarto successivo deve generare un avviso nel pannello.

Uno scarto successivo non deve inviare automaticamente nuove e-mail al cliente né cancellare l'invio già registrato: richiede gestione manuale secondo la procedura di scarto verificata.

### 12.5 PoC OCI Email Delivery e scelta del trasporto

Eseguire il PoC soltanto in Development, con documento sintetico e destinatario controllato dal titolare:

1. verificare disponibilità, endpoint, quote e regione OCI correnti senza abilitare uso a pagamento;
2. usare un dominio posseduto e controllato dal titolare, configurare SPF/DKIM e registrare l'indirizzo del negozio come approved sender nella regione scelta;
3. creare credenziali SMTP dedicate e conservarle esclusivamente nel secret store;
4. provare consegna in inbox, Message-ID, errore, hard bounce, suppression e reinvio senza dati cliente;
5. confrontare con l'SMTP esistente almeno per autenticazione, deliverability osservata, limiti, diagnosi e semplicità operativa;
6. scegliere un solo trasporto canonico e registrare decisione, regione, sender verificato e risultato nel contratto e-mail e nel record di readiness.

OCI Email Delivery diventa il trasporto Production solo se supera questi criteri e resta entro la quota senza costo verificata nel preflight. In caso contrario HF mantiene l'SMTP esistente e non conserva risorse OCI inutilizzate. Riferimenti: [OCI Always Free](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm), [Approved Senders](https://docs.oracle.com/en-us/iaas/Content/Email/Tasks/managingapprovedsenders.htm) e [Suppression List](https://docs.oracle.com/en-us/iaas/Content/Email/Tasks/managingsuppressionlist.htm).

---

## 13. Interfaccia utente

Interfaccia esclusivamente italiana. Codice, API, tabelle e nomi tecnici restano in inglese. Centralizzare tutti i testi visibili in uno o pochi file di catalogo italiano, evitando stringhe duplicate nei componenti. Non introdurre un framework multilingua o traduzioni aggiuntive nella 1.x.

### 13.1 Navigazione

1. Dashboard
2. Ordini
3. Schede
4. Fatture
5. Note di credito
6. Documenti trasmessi
7. Clienti
8. Errori e verifiche
9. Connessioni
10. Impostazioni
11. Registro attività

Le sezioni possono essere accorpate se il prototipo dimostra che una lista filtrabile è più semplice.

### 13.2 Dashboard

Mostrare:

- Schede pronte;
- da verificare;
- pagamenti pendenti;
- note di credito da approvare;
- upload falliti;
- scarti SdI;
- errori di sincronizzazione;
- ultimo sync Shopify/eBay e ultimo readback Aruba, con indicazione di eventuale stato obsoleto;
- documenti emessi oggi/mese.

Nessuna e-mail operativa nella 1.x: gli avvisi critici devono essere evidenti qui.

### 13.3 Ordini

- Filtri per piattaforma, stato, data, trigger, pagamento.
- Ricerca per ID ordine, cliente, e-mail, codice fiscale/P.IVA.
- Vista del dato originale e normalizzato.
- Collegamento alla Scheda.
- Forzatura manuale della generazione bozza.
- Archivio annullati.

### 13.4 Schede

- Elenco con stato, cliente, data, ordini, totale, anomalie.
- Dettaglio con timeline e audit.
- Aggiunta/rimozione di ordini compatibili prima dell'approvazione.
- Separazione di un ordine.
- `Non trasmettere` con motivo.
- Anteprima fattura.

### 13.5 Approvazione

Mostrare in una sola pagina:

- cliente e dati fiscali;
- ordini inclusi;
- righe semplificate;
- totale importato, totale documento e differenza;
- pagamento;
- esito controlli;
- risultato della validazione XSD e, dopo l'esecuzione dell'helper, della validazione Aruba;
- modalità Aruba attiva e conseguenza dell'ultima conferma;
- scelta invio e-mail;
- conferme eccezionali.

Il comparatore fiscale visuale occupa la stessa pagina e presenta tre livelli derivati server-side:

1. snapshot immutabile dell'ordine o rimborso sorgente;
2. bozza corrente, comprese normalizzazioni e modifiche manuali;
3. proiezione strutturata dell'XML che il generatore corrente produrrebbe per Aruba.

Raggruppare le differenze per anagrafica fiscale, ordini/righe, importi, pagamento, causale e dati tecnici. Per ogni valore cambiato mostrare origine, valore precedente, valore finale e motivo disponibile; gli elementi invariati restano comprimibili. Colore e posizione non sono mai gli unici indicatori. Il raw XML è soltanto una vista tecnica espandibile o scaricabile, mai un editor e mai la base di un diff testuale.

Il comparatore usa lo stesso generatore e la stessa versione della bozza impiegati dall'endpoint di approvazione. Dopo qualunque modifica diventa stale e viene ricalcolato; al submit il server rigenera la proiezione e rifiuta l'approvazione se revisione o hash non coincidono. Un errore di generazione o una differenza non classificabile blocca l'approvazione e indica l'azione correttiva. Lo stesso contratto vale per TD04.

Azioni:

- salva bozza;
- valida;
- approva, numera e prepara per Aruba;
- non trasmettere.

### 13.6 Note di credito

- Fattura originaria.
- Rimborsi inclusi.
- Residuo accreditabile.
- Righe e totale.
- Anomalie di riconciliazione.
- Anteprima e approvazione separata.

### 13.7 Connessioni

Per Shopify, eBay e il trasporto SMTP canonico:

- ambiente;
- stato;
- ultimo controllo;
- ultimo sync;
- riconnetti;
- verifica credenziali;
- dettagli errore sanificati.

Per Aruba non mostrare `riconnetti` o `verifica credenziali`: HF non possiede credenziali Aruba. Mostrare soltanto stato e ultima versione dell'helper, browser rilevato, ultimo readback, modalità configurata ed eventuale errore sanitizzato. `Connesso` significa soltanto che l'helper ha contattato HF di recente: non implica che la sessione Aruba sia autenticata, informazione che resta nel browser locale.

Non mostrare mai segreti.

### 13.8 Impostazioni

- Trigger globale bozza: pagamento/evasione completa.
- Modalità invio copia: automatica/manuale.
- Propagazione correzioni Shopify: off di default.
- Fuso orario: Europe/Rome, non modificabile nella 1.x salvo reale necessità.
- Profilo fiscale: sola lettura dopo audit, con versione.
- Numerazione/sezionale: protetta e configurata dopo audit.
- Modalità Aruba: `Assistita` come default oppure `Automatica dopo conferma`.
- Stato helper e istruzioni minime per avviarlo su Windows o macOS con Chrome/Edge.
- 2FA Aruba: raccomandazione e stato dichiarato dall'utente, senza memorizzare seed o codici.
- Trasporto SMTP scelto e stato, senza mostrare credenziali.

### 13.9 Fondazione UI, identità leggera e contenuti

HF è uno strumento operativo privato: non serve un sistema di brand esteso. Prima della UI definitiva serve però una Brand Foundation leggera e vincolante, composta soltanto da:

- nome `Hub Fatture` e abbreviazione `HF`;
- un marchio/icona SVG canonico, favicon e sole varianti raster effettivamente richieste dall'app e da GitHub;
- palette minima e token CSS essenziali, senza sostituire i colori semantici di stato;
- tipografia di sistema, nessun webfont;
- tono e principi di microcopy;
- regole minime di contrasto, spaziatura e uso del marchio.

La fonte è `docs/brand/brand-foundation.md`; gli asset sorgente vivono in `docs/brand/assets/`. Non creare brand board, libreria di componenti proprietaria, sito pubblico, set di illustrazioni o varianti speculative. La direzione visiva viene approvata dal titolare in M1 e poi riusata da UI, favicon, README e social preview della repository.

La fondazione UI applicativa deve inoltre:

- mostrare prima il fatto osservato, poi la conseguenza e infine l'azione disponibile;
- tono preciso e calmo, senza claim di conformità, certificazione o successo non dimostrati;
- stato effettivo prima della configurazione desiderata: «trasmessa» o «consegnata» solo dopo conferma autorevole;
- nessun colore come unico indicatore; ogni stato ha testo esplicito;
- nessun contenitore vuoto per funzioni future;
- componenti nativi/accessibili dello stack e CSS minimo;
- layout progettato sul contenitore, verificato a viewport stretto, zoom 200% e navigazione da tastiera;
- errori associati al campo o all'azione, con istruzione concreta per correggere;
- caricamento e stato pendente specifici per l'azione; un successo precedente viene nascosto appena parte un nuovo tentativo.

Le azioni ad alto impatto richiedono una conferma che descriva la conseguenza specifica, non un generico «Sei sicuro?». Per `Approva, numera e prepara per Aruba` la conferma riepiloga almeno documento, destinatario, totale, profilo fiscale, stato del pagamento, modalità helper e irreversibilità della numerazione. In modalità automatica dichiara esplicitamente che il permesso consentirà all'helper di eseguire l'ultimo clic per il batch indicato. La protezione è sempre server-side: nascondere o disabilitare un pulsante non autorizza né impedisce una transizione.

Le bozze modificabili usano una revisione ottimistica. Se due schede browser partono dalla stessa versione, la seconda scrittura riceve un conflitto e deve rileggere prima di salvare; non sovrascrive silenziosamente la prima.

---

## 14. Architettura

### 14.1 Forma

Monolite modulare con due processi server dello stesso codice:

- `web`: UI, API, OAuth e webhook;
- `worker`: job asincroni e schedulati.

Servizi Compose:

```text
caddy
app-web
app-worker
postgres
```

Nessun Redis. Nessun microservizio. Il worker usa PostgreSQL per lock, scheduling e retry.

Fuori da Compose esiste un solo componente operativo locale:

- `aruba-helper`: comando TypeScript/Playwright avviato dal titolare su Windows o macOS, collegato a HF via HTTPS con un token breve vincolato al batch e a Chrome/Edge tramite un profilo dedicato. Non è un servizio remoto, non gira sulla VPS, non conserva credenziali Aruba e non chiama API Aruba.

Gli ambienti sono separati logicamente:

- `development`: database, token, storage e hostname propri; solo fixture o pagina Aruba sintetica locale;
- `production`: dati reali e credenziali Shopify/eBay/SMTP/infrastruttura sulla VPS; nessuna credenziale Aruba;
- nessun ambiente staging permanente nella 1.x, salvo necessità emersa durante l'integrazione Aruba.

Per esporre temporaneamente lo sviluppo locale sono ammessi Cloudflare Quick Tunnel o ngrok. Non usarli come URL di produzione.

### 14.2 Moduli suggeriti

```text
src/
  auth/
  settings/
  customers/
  orders/
  billing-cases/
  documents/
  refunds/
  integrations/
    shopify/
    ebay/
    aruba/
    smtp/
  aruba-helper/
  jobs/
  audit/
  storage/
  web/
```

Usare le convenzioni del framework scelto, senza imporre questa struttura se produce duplicazione.

### 14.3 Stack e dipendenze accettate

La matrice seguente fissa le scelte di stack, non le loro versioni. In M0 risolvere una sola combinazione stabile e compatibile, verificarla e fissarla in `mise.toml`, `package.json`, `package-lock.json` e nei digest Compose. Da quel momento questi file sono le sole fonti canoniche dei pin; il Master Plan cambia soltanto se cambia una scelta architetturale.

| Livello | Scelta accettata | Regola |
|---|---|---|
| Host | Ubuntu LTS ARM64 corrente supportata dalla VPS | una sola VPS OCI Ampere A1 |
| Runtime | Node.js stabile corrente + npm compatibile | fonti canoniche in `mise.toml`, `engines` e `packageManager` |
| Linguaggio | TypeScript stabile, modalità strict | niente runtime TypeScript in Production |
| Web | React, React DOM e React Router | modalità framework con adapter Node e `@react-router/serve` |
| Database | PostgreSQL, `pg`, SQL parametrizzato e migrazioni SQL versionate | un solo livello dati; nessun ORM o migration CLI |
| Container app | immagine ufficiale Node slim fissata per digest | multi-arch verificata per `linux/arm64` |
| Container DB | immagine ufficiale PostgreSQL fissata per digest | volume persistente e health check |
| Reverse proxy | immagine ufficiale Caddy fissata per digest | multi-arch verificata per `linux/arm64` |
| Cifratura backup e segreti versionati | `age` stabile | cifratura client-side prima della persistenza o dell'upload |
| Validazione XSD | `xmllint` da `libxml2-utils` | tool di sistema nell'immagine app; niente binding XSD npm nativo |

Dipendenze runtime dirette iniziali:

| Pacchetto | Uso ammesso |
|---|---|
| `react`, `react-dom` | UI |
| `react-router`, `@react-router/node`, `@react-router/serve` | routing, form/action, sessioni e server Production |
| `pg` | driver PostgreSQL |
| `zod` | configurazione e confini esterni, non modelli duplicati interni |
| `otpauth` | TOTP standard |
| `nodemailer` | unico adapter SMTP, indipendente dal provider scelto in HF-O07 |
| `xmlbuilder2` | costruzione e parsing XML; il profilo definitivo viene qualificato in M4 |
| `@shopify/shopify-api` | OAuth, webhook e API Shopify ufficiali |

Dipendenze di sviluppo dirette iniziali:

| Pacchetto | Uso ammesso |
|---|---|
| `@react-router/dev` | build e route type-safe |
| `vite` | build del framework |
| `typescript` | typecheck e compilazione worker |
| `@playwright/test` | E2E, smoke browser e helper Aruba locale; non installato nell'immagine server Production |
| `oxlint`, `oxfmt` | uniche toolchain lint/formato |
| `react-doctor` | scansione React completa nel comando locale/CI canonico e configurazione condivisa con l'Action advisory |
| `@types/node`, `@types/react`, `@types/react-dom` | tipi piattaforma allineati al runtime |
| `@types/pg`, `@types/nodemailer` | tipi driver e SMTP |

`pdfkit` e i relativi tipi sono l'unica dipendenza condizionale già selezionata: non installarli finché HF-O03 non dimostra che Aruba non restituisce un PDF ufficiale utilizzabile. Se servono, usare font incorporati e non aggiungere Chromium al runtime per renderizzare PDF.

Scelte native deliberate:

- `node:crypto` (`scrypt`, `randomBytes`, `randomUUID`, SHA-256 e HMAC) per password, recovery code, identificativi e hash; nessun wrapper crypto;
- `fetch` nativo per eBay, Dynu e comunicazione HTTPS helper-HF; niente Axios o secondo client HTTP;
- `Intl.DateTimeFormat` e `timestamptz` PostgreSQL per Europe/Rome; niente libreria date;
- importi monetari in centesimi di euro interi, validati con `Number.isSafeInteger`; niente libreria decimale;
- `node:test` come unico runner unitario e d'integrazione; Playwright resta il solo runner browser;
- type stripping nativo del runtime scelto per script e CLI TypeScript locali, solo dopo uno smoke della sintassi supportata; niente esecutore TypeScript aggiuntivo;
- logger locale minimo: un oggetto JSON per riga su stdout/stderr, campi tipizzati e allowlist; niente libreria di logging;
- form/action e sessioni server-side di React Router persistite in PostgreSQL; niente form library o auth framework;
- coda PostgreSQL con tabella, lease e `FOR UPDATE SKIP LOCKED`; niente Redis, broker o libreria di coda;
- HTML semantico, CSS e componenti locali; niente design system, Tailwind, Storybook o libreria UI;
- query SQL parametrizzate, vincoli, lock e transazioni in PostgreSQL confinati in `src/db`; nessun repository pattern o interfaccia con una sola implementazione.

Le migrazioni sono file SQL append-only ordinati e sottoposti a review. Un piccolo runner compilato con l'app usa `pg`, advisory lock, transazione, tabella `schema_migrations` e checksum per rifiutare file già applicati ma modificati; non esiste un comando `push` Production. Tutti gli importi monetari sono colonne PostgreSQL `integer` espresse in centesimi e valori TypeScript `number` interi sicuri; le stringhe decimali esterne vengono convertite da un parser stretto che rifiuta cifre decimali non nulle oltre i centesimi. Percentuali o coefficienti fiscali non monetari che richiedono precisione restano stringhe validate fino alla serializzazione XML. Il worker e il runner migrazioni vengono compilati con `tsconfig` dedicati; soltanto script e CLI locali possono eseguire `.ts` direttamente quando il runtime fissato ne supera lo smoke, con sola sintassi cancellabile, import espliciti e senza alias `paths`. L'uso SMTP resta limitato a `createTransport`/`sendMail` e ha un typecheck mirato. M0 verifica installazione pulita, peer dependency, audit, test nativi, import smoke, React Doctor e typecheck prima di rendere canonici manifest, lockfile e digest.

Riferimenti da riverificare quando si crea il lockfile: [release Node.js](https://nodejs.org/en/about/previous-releases), [React Router Framework Mode](https://reactrouter.com/start/modes), [documentazione PostgreSQL](https://www.postgresql.org/docs/), [release age](https://github.com/FiloSottile/age/releases).

Non introdurre due ORM, un framework API separato o una dipendenza già sostituita da Node, PostgreSQL o React Router.

### 14.4 Transazioni critiche

Usare transazioni DB per:

- assegnazione ordine a Scheda;
- approvazione e numerazione;
- creazione/aggiornamento nota cumulativa;
- registrazione di un rimborso;
- acquisizione univoca di webhook;
- passaggio job da pending a running;
- chiusura di un documento.

### 14.5 Lock e concorrenza

Vincoli DB e lock transazionali devono impedire:

- due Schede per la stessa chiave quando una è ancora aperta;
- ordine in più fatture;
- due note per lo stesso rimborso;
- doppia numerazione;
- due worker sullo stesso job.

Lock e vincoli proteggono lo stato letto, non soltanto la scrittura finale: configurazione, documento, residuo rimborsabile e prossimo numero fiscale vanno riletti dentro la stessa transazione o lease che autorizza la mutazione.

### 14.6 Fonti autorevoli

| Informazione | Fonte autorevole | Ruolo di HF |
|---|---|---|
| Ordine, pagamento, evasione, annullamento e rimborso sorgente | Shopify o eBay | snapshot storico e stato normalizzato riconciliabile |
| Identità normalizzata, raggruppamento, bozza, override e approvazione | PostgreSQL HF + audit | fonte primaria applicativa |
| Profilo fiscale approvato | versione HF derivata da XML Aruba accettato e decisioni approvate | snapshot immutabile nel documento |
| XML/PDF/notifica archiviati | file immutabile + hash e metadati DB | fonte del contenuto conservato |
| Ricezione Aruba e stato SdI corrente | pannello Aruba e file ufficiali scaricati | cache operativa con data dell'ultimo readback e cronologia dei tentativi |
| Invio e-mail | esito del trasporto SMTP canonico e `message_id` | stato locale riconciliabile |
| Release | tag/commit Git e digest immagine | `/version` e ricevuta di deploy confermano lo stato live |
| Backup | archivio OCI cifrato, copia cifrata sul Mac, manifest e checksum | il DB conserva solo l'ultimo esito operativo |

Un webhook segnala che qualcosa può essere cambiato: non sostituisce la rilettura dello stato corrente quando il provider offre un readback. Gli esiti Aruba sono aggiornati soltanto da osservazioni dell'helper o import manuali; eventi fuori ordine non devono far regredire uno stato autorevole.

### 14.7 Semantica delle scritture fra sistemi

- Le decisioni di cui HF è fonte — correzione, approvazione, snapshot e inserimento del job — vengono salvate atomicamente con il relativo audit.
- Uno stato derivato da un provider viene aggiornato soltanto dopo risposta valida o readback; in caso di timeout resta `UNKNOWN`/`RECONCILIATION_REQUIRED`, mai falsamente riuscito.
- Dopo una scrittura remota, il readback verifica l'oggetto canonico completo o il suo hash, non un sottoinsieme scelto dal client.
- La configurazione autenticata e lo stato server prevalgono sempre su query string, campi hidden o identificativi inviati dal browser.
- Importi, destinatario, documento e azione ammessa vengono ricalcolati lato server dalla risorsa effettivamente selezionata.
- Una scrittura locale che rappresenta la stessa azione remota avviene solo dopo conferma; l'eccezione è lo snapshot di approvazione HF, che precede l'invio e resta tracciato anche se il provider fallisce.

---

## 15. Schema dati proposto

È uno schema logico iniziale, non un ordine di creare tutte le tabelle nel primo commit. Aggiungere ogni tabella nella milestone che la usa, mantenendo i vincoli indicati. Se due tabelle possono essere unite senza perdere immutabilità, idempotenza o audit, scegliere la forma più semplice.

Per convenzione, ogni colonna `*_amount` è un `integer` in centesimi di euro; valuta e unità restano esplicite. Scritture e somme rifiutano valori non interi, non sicuri in JavaScript o fuori dal dominio `integer` PostgreSQL, mentre la serializzazione fiscale converte in stringa decimale soltanto al confine XML.

### 15.1 Tabelle principali

#### `users`

- `id`
- `email`
- `password_hash`
- `totp_secret_encrypted`
- `totp_enabled_at`
- `created_at`
- `last_login_at`

Una sola riga ammessa operativamente.

#### `sessions`

- `id`
- `user_id`
- `expires_at`
- `created_at`
- `last_seen_at`
- `ip_hash` opzionale
- `user_agent` opzionale

#### `settings`

- `key`
- `value_json`
- `version`
- `updated_at`

Usare chiavi esplicite; evitare un sistema di configurazione generico per valori immutabili. Le modifiche usano confronto ottimistico sulla versione e rileggono il valore dentro il lock applicabile.

#### `aruba_send_permits`

- `id`
- `batch_id`
- `manifest_sha256`
- `document_count`
- `mode`
- `scope` (`CANARY`, `ORDINARY`)
- `authorized_by`
- `authorized_at`
- `expires_at`
- `consumed_at`

Il manifest immutabile referenzia documenti, revisioni e hash XML esatti. Un permesso viene creato soltanto dopo l'autorizzazione esplicita in modalità automatica e consumato atomicamente quando il server ricontrolla manifest, scadenza, modalità, scope e kill switch. Lo scope `CANARY` è l'unica eccezione ammessa con `ARUBA_SUBMISSION_ENABLED=false` e richiede l'autorizzazione separata prevista in M9; `ORDINARY` richiede il flag attivo. Il permesso non può autorizzare un secondo tentativo, un batch diverso o file modificati. Durante il Canary può esistere al massimo un permesso valido; nell'uso ordinario ogni batch mantiene comunque il proprio permesso indipendente e monouso.

#### `fiscal_profiles`

- `id`
- `version`
- `status` (`MOCK`, `AUDITED`, `RETIRED`)
- `profile_json`
- `source_xml_sha256`
- `audited_at`
- `created_at`

Una sola versione attiva. Il profilo mock non può essere usato in produzione. Ogni documento conserva anche lo snapshot effettivo usato, così una modifica futura non altera documenti già creati.

#### `connections`

- `id`
- `provider`
- `environment`
- `account_reference`
- `encrypted_credentials`
- `status`
- `last_checked_at`
- `last_synced_at`
- `last_error_code`
- `last_error_message_sanitized`

Per la riga Aruba `encrypted_credentials` resta `NULL`: stato e riferimento descrivono soltanto helper e account atteso, mentre credenziali e sessione rimangono nel profilo browser locale.

#### `sync_cursors`

- `provider`
- `stream`
- `cursor`
- `overlap_from`
- `updated_at`

#### `webhook_events`

- `id`
- `provider`
- `external_event_id`
- `topic`
- `payload_sha256`
- `received_at`
- `claimed_at`
- `lease_expires_at`
- `processed_at`
- `attempt_count`
- `status` (`PROCESSING`, `PROCESSED`, `FAILED`)
- `error_code`

Unicità su provider + ID esterno; se manca un ID affidabile, usare un hash deterministico dei soli byte ricevuti come chiave di deduplicazione. Non conservare il payload completo nella ricevuta. Solo `FAILED` o `PROCESSING` con lease scaduta possono essere riacquisiti; un crash non deve lasciare l'evento bloccato per sempre. Il solo vincitore dell'acquisizione produce job e audit collegati.

#### `customers`

- `id`
- `kind`
- `display_name`
- `first_name`
- `last_name`
- `company_name`
- `email`
- `phone`
- `tax_id_type`
- `tax_id_normalized`
- `vat_country`
- `billing_address_json`
- `source_confidence`
- `created_at`
- `updated_at`

I dati corretti in HF non sovrascrivono i valori storici degli ordini.

#### `customer_source_records`

- `id`
- `customer_id`
- `provider`
- `external_customer_id`
- `raw_snapshot_json`
- `imported_at`

#### `orders`

- `id`
- `provider`
- `external_account_id`
- `external_order_id`
- `display_number`
- `created_at_source`
- `updated_at_source`
- `local_order_date`
- `currency`
- `gross_amount`
- `payment_status`
- `fulfillment_status`
- `trigger_status`
- `customer_id`
- `billing_case_id`
- `raw_snapshot_json`
- `normalized_snapshot_json`
- `imported_at`
- `last_synced_at`
- `cancelled_at`

Unicità su provider + account + external_order_id.

#### `order_lines`

- `id`
- `order_id`
- `external_line_id`
- `description`
- `quantity`
- `gross_amount`
- `discount_amount`
- `raw_json`

Servono alla riconciliazione, non alla fattura 1:1.

#### `order_tax_identifiers`

- `id`
- `order_id`
- `type`
- `raw_value`
- `normalized_value`
- `source_field`
- `imported_at`

#### `payments`

- `id`
- `order_id`
- `external_payment_id`
- `method`
- `status`
- `amount`
- `paid_at`
- `recorded_manually`
- `raw_json`

#### `billing_cases`

- `id`
- `public_number` (es. HF-000154, non fiscale)
- `customer_id`
- `local_order_date`
- `currency`
- `fiscal_profile_version`
- `status`
- `do_not_transmit_reason`
- `created_at`
- `updated_at`
- `closed_at`

#### `documents`

- `id`
- `billing_case_id`
- `kind` (`INVOICE`, `CREDIT_NOTE`)
- `status`
- `document_type`
- `fiscal_number`
- `document_date`
- `fiscal_profile_version`
- `currency`
- `total_amount`
- `source_total_amount`
- `difference_amount`
- `difference_reason`
- `draft_version`
- `pending_payment_confirmed_at`
- `amount_difference_confirmed_at`
- `approved_at`
- `xml_sha256`
- `immutable_snapshot_json`
- `fiscal_profile_snapshot_json`
- `created_at`

#### `document_orders`

- `document_id`
- `order_id`
- `amount`

Vincolo: un ordine non può appartenere a due fatture emesse; può comparire nella nota solo tramite rimborso tracciato.

#### `document_lines`

- `id`
- `document_id`
- `order_id`
- `line_number`
- `description`
- `quantity`
- `unit_amount`
- `total_amount`
- `tax_nature`

#### `refunds`

- `id`
- `provider`
- `external_account_id`
- `external_order_id`
- `external_refund_id`
- `order_id`
- `status`
- `amount`
- `completed_at`
- `raw_json`
- `credit_document_id`
- `created_at`

Unicità su provider + account + order + refund.

#### `document_links`

- `document_id`
- `related_document_id`
- `relation_type`

Per nota di credito -> fattura originaria.

#### `aruba_submissions`

- `id`
- `batch_id`
- `document_id`
- `attempt_number`
- `environment`
- `mode`
- `manifest_sha256`
- `xml_sha256`
- `remote_id`
- `status`
- `helper_version`
- `browser_name`
- `validation_metadata_json`
- `readback_metadata_json`
- `submitted_at`
- `last_checked_at`
- `error_code`
- `error_message_sanitized`

#### `sdi_notifications`

- `id`
- `submission_id`
- `remote_notification_id`
- `type`
- `status`
- `received_at`
- `storage_object_id`
- `metadata_json`

#### `storage_objects`

- `id`
- `kind`
- `relative_path`
- `sha256`
- `size_bytes`
- `content_type`
- `created_at`

Percorsi relativi e root configurabile. Mai path forniti dall'utente senza validazione.

#### `email_deliveries`

- `id`
- `document_id`
- `transport`
- `sender`
- `recipient`
- `subject`
- `status`
- `message_id`
- `attempt_count`
- `sent_at`
- `last_error_sanitized`

#### `jobs`

- `id`
- `type`
- `payload_json`
- `status`
- `run_at`
- `attempts`
- `max_attempts`
- `locked_at`
- `lease_expires_at`
- `locked_by`
- `completed_at`
- `last_error_code`
- `created_at`

Un worker può recuperare un job `running` soltanto dopo la scadenza della lease. Il job trasporta identificativi e parametri minimi validati, non copie integrali di webhook, XML o credenziali.

#### `audit_events`

- `id`
- `actor_type`
- `actor_id`
- `action`
- `event_class` (`CRITICAL`, `OPERATIONAL`)
- `entity_type`
- `entity_id`
- `before_json`
- `after_json`
- `reason`
- `request_id`
- `created_at`

Gli eventi `CRITICAL` — approvazione, numerazione, override importi, `Non trasmettere`, collegamento rimborso/nota, upload e transizioni fiscali — sono scritti nella stessa transazione dello stato che attestano e non sono best-effort. Gli eventi `OPERATIONAL` possono essere best-effort, ma usano nomi e metadata allowlisted. Correzioni dell'audit si rappresentano con un nuovo evento; non si riscrivono eventi precedenti.

### 15.2 Vincoli fondamentali

- EUR come unica valuta ammessa nella 1.x.
- Unicità eventi esterni.
- Unicità ordini esterni.
- Unicità rimborsi esterni.
- Hash XML finale immutabile dopo approvazione.
- Documento emesso non modificabile.
- Totale delle note non superiore alla fattura.
- Numero fiscale univoco nel relativo sezionale/anno, dopo audit.
- Ogni permesso Aruba è consumabile una sola volta e non sopravvive a mismatch di batch/manifest/documento/revisione/hash o scadenza; durante il Canary ne esiste al massimo uno valido.
- Nessun segreto in tabelle di log/audit.
- Nessuna transizione fiscale basata su un valore fornito soltanto dal browser.
- Stati provider monotoni salvo riconciliazione esplicita e motivata.
- `before_json`, `after_json` e metadata audit contengono solo campi allowlisted o riferimenti a snapshot immutabili; niente token o duplicazioni integrali di XML/PDF.

### 15.3 Migrazioni e compatibilità di rilascio

- File numerati, append-only e immutabili dopo l'applicazione in qualunque ambiente condiviso.
- Ogni correzione usa una nuova migrazione; nessun rollback ordinario elimina righe della tabella migrazioni o modifica file già applicati.
- CI prova sia l'installazione su database vuoto sia l'upgrade da uno snapshot rappresentativo della versione Production precedente.
- Lo snapshot di upgrade include almeno documenti in bozza, documento approvato, submission incerta, job in retry e audit; i dati sono sintetici.
- Preferire migrazioni expand/contract compatibili con la versione applicativa precedente per tutta la finestra di deploy.
- Prima di Production registrare backup, versione schema, conteggi/invarianti rilevanti e piano forward-fix.
- Restore/PITR è riservato a perdita o corruzione dati e richiede autorizzazione; non sostituisce il rollback applicativo.

---

## 16. Job asincroni e sincronizzazione

### 16.1 Tipi di job

- `shopify_sync_orders`
- `shopify_process_webhook`
- `ebay_sync_orders`
- `prepare_aruba_batch`
- `expire_aruba_send_permit`
- `process_refund`
- `send_customer_email`
- `cleanup_expired_sessions`

### 16.2 Retry

- Backoff esponenziale con jitter per errori transitori.
- Limite tentativi.
- Nessun retry automatico per errori di validazione o autorizzazione.
- Dead-letter rappresentata da stato `failed`, visibile nel pannello.
- Retry manuale dopo correzione.
- Lease con scadenza per webhook e job acquisiti; il recupero dopo crash è automatico e idempotente.
- Nessun retry server automatico per azioni del pannello Aruba. Dopo uno stato incerto l'helper o l'utente devono riconciliare il documento prima di creare un nuovo tentativo.

### 16.3 Schedulazione iniziale

Valori di routine da calibrare:

- Shopify recovery sync: ogni 10-15 minuti.
- eBay sync: ogni 10-15 minuti.
- Pulizia sessioni: giornaliera.

Rispettare rate limit reali e usare cursori/sovrapposizione per Shopify ed eBay. Per Aruba non simulare un polling headless: mostrare l'età dell'ultimo readback e proporre l'avvio dell'helper quando esistono documenti non conclusi.

### 16.4 Registro errori e riconciliazione

Definire un registro chiuso di codici stabili, raggruppato almeno per `AUTH`, `VALIDATION`, `CONFLICT`, `PROVIDER`, `NETWORK`, `PARSING`, `STORAGE`, `MIGRATION` e `UNKNOWN_REMOTE_STATE`. Ogni codice specifica:

- se l'errore è transitorio, permanente o richiede decisione umana;
- se il retry può essere automatico;
- messaggio UI sanificato e dato operativo consentito;
- evento/audit necessario;
- azione di riconciliazione.

Timeout, errori di trasporto, risposta non JSON/XML, schema inatteso e `5xx` devono essere catturati e tradotti in codici stabili: non propagare stack trace o messaggi del provider all'utente. L'errore originale può essere conservato solo in forma sanitizzata e con retention breve.

---

## 17. Sicurezza e privacy

### 17.1 Autenticazione

- Un solo account amministratore.
- Password con hash moderno fornito da una libreria consolidata.
- TOTP obbligatorio prima dell'uso in produzione.
- Codici di recupero monouso cifrati o hashati.
- Session cookie `HttpOnly`, `Secure`, `SameSite`.
- Scadenza sessione e revoca.
- Rate limiting login.
- CSRF per azioni mutative se il framework non lo copre.

### 17.2 Segreti

- Variabili d'ambiente o file secret non versionato.
- Permessi filesystem minimi.
- Token OAuth rinnovabili e TOTP secret cifrati con AEAD usando una chiave master conservata fuori dal database.
- Credenziali mai in prompt, log, screenshot o fixture.
- Rotazione documentata.
- Separazione development/production.
- Nessuna credenziale, sessione browser, cookie, password, OTP o seed TOTP Aruba viene salvato o trasmesso a HF; il profilo dedicato resta sul computer dell'utente.
- I segreti necessari al deploy remoto vivono nel GitHub Environment `Production`, non nei workflow ordinari, e diventano disponibili al job soltanto dopo l'approvazione richiesta.
- La chiave master AEAD e il materiale minimo per ricostruire l'accesso non dipendono dalla sola VPS: conservarne una copia nel recovery kit locale del titolare sul Mac, fuori dal repository e dagli archivi dati, con permessi riservati e disco protetto da FileVault.
- L'unico segreto archiviato nel repository è la key SSH VPS cifrata con `age` in `ops/secrets/`; il plaintext e l'identità privata di decifratura restano sempre fuori da Git. La presenza del blob pubblico non autorizza a decifrarlo o usarlo senza approvazione.

Mantenere `docs/runbooks/secret-inventory.md` con soli nomi logici, ambiente, destinazione, owner operativo, stato e data dell'ultima verifica: mai valori, prefissi, fingerprint riutilizzabili o comandi che li stampano. Per ogni classe di segreto documentare rotazione, readback sicuro, rollback/revoca e componenti da ridistribuire. Il restore drill verifica anche che il recovery kit consenta di decifrare le credenziali ripristinate senza usare file rimasti sulla VPS originaria.

### 17.3 Protezione rete

- Solo porte 80/443 pubbliche.
- PostgreSQL non esposto.
- SSH con chiavi, niente password.
- Firewall OCI e host.
- Caddy come unico ingresso.
- Limite globale conservativo del body in Caddy e limiti applicativi più stretti per form, webhook, richieste helper, XML e PDF, applicati prima del buffering o della decodifica; gli sforamenti restituiscono `413` senza includere il payload nei log.
- Timeout espliciti e limiti di byte anche sulle risposte dei provider; `fetch` non resta mai privo di deadline e una risposta eccessiva viene trattata come errore stabile, non caricata integralmente in memoria.
- Aggiornamenti di sicurezza del sistema operativo.
- Token helper casuali, revocabili, a scadenza breve e vincolati al batch, mai in query string o log; hostname HF e Aruba verificati contro allowlist esatte. Il distinto permesso per l'ultimo clic resta monouso.

### 17.4 Dati personali

- Conservare solo dati necessari al processo e all'audit.
- Non usare dati reali nei test.
- Fixture anonimizzate.
- Log sanificati.
- Nessun XML/PDF reale nel repository; sono ammesse soltanto fixture XML anonimizzate e sintetiche sotto `tests/fixtures/` quando richieste da contract o golden test.
- Accesso ai protected customer data Shopify approvato e documentato.
- Un hash deterministico di dominio, e-mail, IP o identificativo fiscale è pseudonimizzazione, non anonimizzazione, quando resta collegabile al soggetto; applicargli gli stessi controlli e la retention pertinente.
- `ip_hash` nelle sessioni resta omesso finché non serve a una misura antiabuso osservata; non raccoglierlo “per sicurezza”.

### 17.5 Audit

Registrare almeno:

- login e modifica 2FA;
- connessione/disconnessione provider;
- correzioni cliente/documento;
- raggruppamento o separazione ordini;
- `Non trasmettere`;
- approvazioni;
- conferma pagamento pendente;
- conferma differenza importo;
- numerazione;
- upload e retry;
- invio/reinvio e-mail;
- import/ripristino configurazioni.

Non registrare password, token, TOTP secret o contenuto completo non necessario.

### 17.6 Confini di fiducia e minacce principali

Confini da trattare come non fidati:

- browser e input dell'amministratore;
- webhook Shopify/eBay, DOM Aruba e file importati;
- helper locale, profilo browser e canale HTTPS helper-HF;
- file XML/PDF e percorsi di storage;
- SMTP e risposte dei provider;
- variabili d'ambiente, secret store e pipeline di deploy;
- backup trasferiti fra VPS e Mac.

Le minacce prioritarie della 1.x sono: invio o numerazione senza approvazione, helper su account o batch errato, furto della sessione browser, duplicazione di fatture/note, perdita o alterazione di documenti, stato remoto incerto, esposizione di dati fiscali nei log e deploy verso il target sbagliato. I controlli minimi sono validazione ai confini, transazioni e vincoli DB, manifest/hash immutabili, permessi monouso, allowlist degli host, profilo browser locale, redazione dei log, preflight del target e readback remoto.

XML, PDF e risposte remote vengono accettati soltanto entro limiti espliciti di dimensione e tempo. Il parser XML rifiuta `DOCTYPE`, entità esterne e strutture oltre i limiti di profondità/numero elementi definiti dal contratto; la validazione XSD non sostituisce questi controlli. I byte firmati di un webhook vengono verificati prima del parsing e nessun parser o decoder riceve input non limitato.

L'autorizzazione viene rivalutata sul server per ogni mutazione usando sessione autenticata, stato DB e transizione ammessa. Parametri di route/query, campi hidden, stato React e schermate nascoste sono input non fidati. Identificativi di provider e account vengono risolti dalla connessione server selezionata, non accettati direttamente dal browser.

Subito prima del clic Aruba irreversibile l'helper rilegge il manifest da HF, verifica che il permesso sia ancora valido, confronta il riepilogo visibile con documenti e importi attesi e consuma il permesso sul server. Se il DOM non è riconosciuto, compare un documento inatteso o il server non conferma il consumo, l'helper si arresta senza cliccare.

Poiché la repository è pubblica:

- PR, commenti, fixture e screenshot vietano espressamente dati cliente, XML/PDF reali, hostname privati, token e configurazioni sensibili;
- Issues, Discussions e Projects rivolti alla community restano disabilitati; le vulnerabilità si segnalano tramite GitHub Private Vulnerability Reporting e `SECURITY.md`;
- workflow su PR da fork non ricevono segreti e non eseguono codice non fidato con privilegi elevati;
- il primo contributo esterno richiede approvazione manuale del workflow;
- Secret Scanning, Push Protection, CodeQL e Dependency Review sono abilitati quando disponibili;
- prima del primo push pubblico si controllano albero e intera cronologia; qualunque segreto già tracciato viene revocato/ruotato, non soltanto rimosso dal commit corrente.

### 17.7 Retention e cancellazione

HF conserva documenti fiscali, notifiche e audit secondo gli obblighi applicabili e la politica approvata con il commercialista. Prima di tale conferma non introdurre cancellazioni automatiche di documenti, XML, PDF, notifiche o audit fiscali.

Per dati tecnici non fiscali applicare il minimo necessario:

- sessioni scadute eliminate giornalmente;
- payload webhook completi non persistiti nelle ricevute; gli eventuali dati di dominio necessari vengono normalizzati nelle tabelle proprie con retention e audit pertinenti;
- log applicativi ruotati con retention breve definita nel runbook;
- file temporanei e tentativi falliti privi di valore probatorio eliminati in modo sicuro;
- nessun dato reale in PR, fixture o documentazione.

La retention definitiva, con durata, fonte normativa e procedura di cancellazione, è un gate di go-live e va registrata nel record di readiness.

---

## 18. Repository, ambienti, versionamento e CI/CD

### 18.1 Struttura documentale minima

```text
Hub-Fatture/
├── .github/
│   ├── workflows/
│   └── pull_request_template.md
├── src/
├── migrations/
├── tests/
├── scripts/
│   ├── backup.sh
│   └── restore.sh
├── ops/
│   └── secrets/
│       ├── README.md
│       └── oci-vps-access.key.age
├── docs/
│   ├── INDEX.md
│   ├── Hub_Fatture_MASTER_PLAN.md
│   ├── glossario.md
│   ├── brand/
│   │   ├── brand-foundation.md
│   │   └── assets/
│   ├── plans/
│   ├── audits/
│   ├── contracts/
│   ├── evidence/
│   └── runbooks/
├── AGENTS.md
├── CLAUDE.md
├── README.md
├── CONTRIBUTING.md
├── SECURITY.md
├── CHANGELOG.md
├── compose.yaml
├── Dockerfile
├── vite.config.ts
├── .oxlintrc.json
├── playwright.config.ts
├── mise.toml
├── package.json
└── package-lock.json
```

La directory locale canonica è `/Users/Matteo/Progetti/Hub-Fatture` e contiene `ssh-key-ampere-a1.key`, chiave operativa del titolare per la VPS. Fino allo scaffolding resta al suo posto e invariata. Prima del primo commit:

1. aggiungere `*.key` e ogni formato privato in chiaro a `.gitignore`;
2. cifrare la key verso un destinatario pubblico `age` controllato dal titolare e salvare soltanto il blob come `ops/secrets/oci-vps-access.key.age`;
3. verificare localmente che la copia decifrata produca la stessa chiave pubblica dell'originale, senza stampare materiale sensibile nei log;
4. documentare in `ops/secrets/README.md` uso, rotazione e recovery senza includere identità privata o passphrase;
5. aggiungere un gate CI/pre-commit che rifiuta chiavi private in chiaro e consente esclusivamente file cifrati `.age` nella directory dedicata.

L'identità privata `age` resta fuori dal repository nel recovery kit del titolare. Le operazioni dal Mac che richiedono SSH usano un `ssh-agent` effimero alimentato dallo stream decifrato, senza creare una copia plaintext persistente. Il file originale `ssh-key-ampere-a1.key` non viene spostato o eliminato senza una richiesta esplicita successiva e non entra mai nell'indice o nella cronologia.

Creare cartelle e documenti soltanto quando hanno contenuto reale. `docs/INDEX.md` diventa il catalogo canonico; `docs/brand/brand-foundation.md` è l'unica fonte dell'identità leggera; `README.md` descrive setup e comandi correnti; `AGENTS.md` contiene soltanto regole operative stabili; `CLAUDE.md` contiene solo `@AGENTS.md`; `CONTRIBUTING.md` spiega il flusso pubblico senza concedere diritti di riuso; `SECURITY.md` indica come segnalare privatamente vulnerabilità senza dati reali. Non mantenere copie parallele del Master Plan.

La repository resta **pubblica ma non open source** finché il titolare non approva una licenza e aggiunge `LICENSE`. README e CONTRIBUTING devono dichiarare che la sola visibilità del codice non concede automaticamente permessi di uso, modifica o distribuzione.

### 18.2 Ambienti

Due soli ambienti:

| Ambiente | Uso | Dati e provider |
|---|---|---|
| Development (`dev`) | sviluppo, integrazione e collaudo | fixture, Shopify dev, eBay Sandbox, pagina Aruba sintetica locale, SMTP di test e PoC OCI Email Delivery con destinatario controllato |
| Production (`prod`) | uso reale del titolare | database, storage e credenziali Shopify/eBay/SMTP/infrastruttura sulla VPS; sessione Aruba soltanto nel browser locale |

Non creare uno staging permanente finché un bisogno osservato non giustifica il costo di un terzo database, storage e set di segreti. Development e Production devono avere configurazioni, credenziali dei provider applicabili, database e storage separati; Aruba fa eccezione perché HF non ne conserva credenziali o sessione. Il codice distribuito deriva dallo stesso commit verificato.

Il GitHub Environment denominato `Production` è un gate di deploy, non un terzo ambiente applicativo. Deve:

- consentire deploy soltanto da `main` e dai tag `v*` derivati da `main`;
- richiedere l'approvazione manuale del titolare prima di esporre i secret al job;
- mantenere disattivato `prevent self-review`, perché il repository ha un solo owner operativo;
- impedire che un merge avvii automaticamente un deploy;
- registrare nella ricevuta l'approvazione, lo SHA e il target OCI effettivo.

### 18.3 Branch e pubblicazione Git

Per il repository pubblico e single-owner usare il flusso minimo:

- `main` è l'unico branch permanente e rappresenta codice verificato e rilasciabile, non necessariamente già deployato;
- lavoro ordinario su branch brevi con PR verso `main` e squash merge;
- niente push diretti intenzionali su `main`;
- branch protection, base aggiornata, conversazioni risolte e gate richiesti applicati anche all'amministratore;
- cancellazione esplicita dei soli branch temporanei dopo il merge;
- deploy Production e release restano avviati dal titolare e separati dal merge.

Un branch `develop` si aggiunge soltanto se compare un ambiente remoto intermedio stabile o più collaboratori rendono insufficiente `main` protetto. La repository pubblica e l'uso da parte di un solo titolare non sono, da soli, motivi per aggiungerlo.

### 18.4 Versionamento e changelog

- `package.json#version` è la fonte canonica della versione applicativa e coincide con il lockfile.
- Durante lo sviluppo locale non serve un bump per ogni PR.
- Ogni release Production usa SemVer, tag `vX.Y.Z`, voce in `CHANGELOG.md`, commit esatto e piano di rollback.
- Ogni voce di changelog descrive il cambiamento osservabile e, per i fix, la causa condivisa corretta; non elenca soltanto file o ticket.
- Modifiche solo documentali non richiedono bump, tag o release.
- Migrazioni applicate sono immutabili; una correzione usa una nuova migrazione.
- Il numero di versione non prova che il deploy sia avvenuto: la ricevuta remota resta separata.

Ogni release Production approvata è pubblicata anche come GitHub Release immutabile:

1. preparare una draft release sul commit e tag candidati già passati dal canary;
2. generare le note dalle PR tramite `.github/release.yml`, poi confrontarle con `CHANGELOG.md` e rimuovere voci non pertinenti;
3. allegare un solo `release-manifest.json` privo di segreti e dati reali, con versione, commit, digest GHCR, versione schema, riferimento all'attestazione e digest di rollback;
4. pubblicare la release soltanto dopo l'autorizzazione esplicita; pubblicazione della GitHub Release, deploy e uso Production ordinario restano gate distinti;
5. con l'immutabilità attiva, non spostare né riutilizzare tag e non sostituire asset: una correzione produce una nuova patch release.

Non allegare copie dell'immagine Docker o altri archivi già forniti da GHCR/GitHub. La GitHub Release non concede diritti di uso ulteriori: repository e release restano pubbliche ma non open source finché manca una licenza approvata.

Riferimenti da riverificare allo scaffold: [note di release generate automaticamente](https://docs.github.com/en/repositories/releasing-projects-on-github/automatically-generated-release-notes) e [release immutabili](https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases).

### 18.5 CI e gate per tipo di modifica

GitHub Actions è l'unico sistema CI/CD. Un comando locale canonico deve poter eseguire i controlli applicabili senza introdurre un classificatore complesso.

| Corsia | Quando | Gate minimo |
|---|---|---|
| `docs` | documentazione o governance senza runtime | link/anchor e comandi citati, formato, `git diff --check` |
| `standard` | TypeScript, UI, config o test ordinari | docs gate, lint, typecheck, test mirati, build |
| `security/data` | auth, webhook, segreti, storage, migrazioni, manifest o lockfile | standard, audit dipendenze, test di regressione e migrazione su DB effimero |
| `provider` | contratti Shopify/eBay/Aruba/SMTP | security/data quando applicabile, fixture/contract test e verifica su ambiente non produttivo |
| `deploy` | migrazioni, immagine o modifiche remote | gate completo, scansione immagine quando applicabile, preflight, backup quando necessario, smoke, readback e rollback |

La CI non esegue deploy automatici su merge. Action di terze parti vanno vincolate a commit completi, con permessi minimi, timeout e `concurrency` appropriata. I workflow di verifica possono cancellare run obsoleti; un deploy Production già avviato non viene cancellato da un nuovo push. Dependabot apre PR verso `main`; major, minor, dipendenze runtime/provider, Docker e GitHub Actions restano sempre deliberati manualmente.

Il required check `codex-review` riusa il contratto già collaudato in CF Ready invece di introdurre un secondo protocollo:

- ogni apertura/passaggio a ready e ogni nuovo commit richiedono una sola review per l'HEAD corrente;
- il gate accetta soltanto un segnale positivo del reviewer Codex legato allo stesso SHA o un verdetto pulito che dichiari esplicitamente il commit revisionato;
- finding inline sull'HEAD corrente, evidenze di commit precedenti, reaction anteriori alla richiesta, `eyes`, silenzio o commenti generici non sbloccano il merge;
- uno status riuscito è riusabile soltanto per lo stesso SHA; se l'HEAD cambia il gate torna pending;
- il workflow non crea commenti di richiesta: osserva i segnali della review Codex già avviata, pubblica lo status necessario e non esegue codice della PR;
- se usa `pull_request_target`, legge metadati con permessi minimi e può fare checkout soltanto del branch predefinito fidato; non fa checkout, build, installazione, download di artifact o esecuzione di contenuto della PR.

Lo script e il suo test minimo vengono adattati dall'implementazione CF Ready mantenendo il marker per SHA, non riscritti da zero.

L'auto-merge Dependabot è ammesso soltanto quando tutte le condizioni seguenti sono vere:

- autore verificato `dependabot[bot]` e repository head uguale alla repository corrente;
- metadata `dependency-type == direct:development` e `update-type == version-update:semver-patch`;
- tutti i required check della stessa head SHA sono verdi;
- merge squash richiesto con verifica della head corrente; nessuna approvazione automatica;
- Action `dependabot/fetch-metadata` fissata a commit completo;
- l'eventuale `pull_request_target` non esegue checkout, script, build o contenuto della PR e dispone soltanto dei permessi necessari ad abilitare l'auto-merge.

Qualsiasi condizione non riconosciuta lascia la PR aperta per decisione manuale. Il merge su `main` non abilita deploy o release. Riferimento da riverificare allo scaffold: [automazione Dependabot con GitHub Actions](https://docs.github.com/en/code-security/tutorials/secure-your-dependencies/automate-dependabot-with-actions).

Toolchain locale e CI:

- `mise.toml` fissa Node.js e npm risolti in M0 ed è la fonte canonica usata sul Mac e da GitHub Actions; la build Docker usa la stessa patch Node fissata nell'immagine per digest;
- un'eventuale Action Mise è fissata a commit completo; non usare Mise per task, segreti o configurazioni di ambiente che appartengono già a npm e al runtime applicativo;
- `oxlint` e `oxfmt` sono dev dependency a versione esatta e sostituiscono, non affiancano, ESLint e Prettier;
- `npm run lint`, `npm run format` e `npm run format:check` usano rispettivamente `oxlint .`, `oxfmt --write` e `oxfmt --check`; `format:check` fa parte del gate standard;
- `npm test` usa `node --test`; lo stesso runner esegue i test d'integrazione contro PostgreSQL reale quando la corsia lo richiede;
- `npm run check` compone i gate locali standard senza introdurre runner o workflow paralleli;
- partire con le regole native ad alto segnale e senza type-aware linting: `tsc --noEmit` resta la verifica canonica dei tipi; abilitare type-aware solo se copre un difetto reale non intercettato;
- mantenere `doctor.config.json` minimale: blocco locale/CI dai warning in su, controllo supply-chain esterno disabilitato e soli ignore effettivamente necessari.

Riferimenti da riverificare allo scaffold: [Oxlint](https://oxc.rs/docs/guide/usage/linter.html), [Oxfmt](https://oxc.rs/docs/guide/usage/formatter.html) e [Mise per Node/npm](https://mise.jdx.dev/lang/node.html).

React Doctor usa due superfici con responsabilità distinte: `npm run doctor` esegue la scansione completa e blocca `npm run check` dai warning in su; l'Action ufficiale analizza in modalità advisory le modifiche delle PR, senza commento riepilogativo e con soli finding inline. Il pin npm è esatto, l'Action è fissata a commit completo e il controllo supply-chain esterno resta disabilitato perché già coperto dai gate dipendenze. Lo score è informativo e non decide l'esito.

Riferimento da riverificare allo scaffold: [configurazione React Doctor](https://www.react.doctor/docs/configuration).

L'artefatto Production segue una sola corsia:

- GitHub Actions costruisce una sola immagine `linux/arm64` dal commit candidato e la pubblica nel package GHCR pubblico collegato alla repository;
- tag SemVer e SHA sono riferimenti leggibili, ma il digest `sha256` è l'identità canonica usata da deploy, ricevuta e rollback;
- l'immagine riceve un'attestazione GitHub di provenienza legata al digest; il deploy la verifica prima del pull;
- nessun segreto o dato reale entra nell'immagine, nei build argument, nei layer o nei metadati;
- l'immagine applicativa finale esegue come utente non-root, contiene soltanto runtime e file necessari e viene sottoposta a scansione delle vulnerabilità prima del canary; finding critici/alti raggiungibili bloccano il candidato, gli altri richiedono motivazione e condizione di riapertura;
- Action di build, push e attestazione sono fissate a commit completi e ricevono soltanto i permessi necessari;
- la VPS non compila l'applicazione: esegue il pull del digest già verificato e avvia `web` e `worker` dallo stesso artefatto.

Riferimenti da riverificare allo scaffold: [pubblicazione di immagini Docker con GitHub Actions](https://docs.github.com/en/actions/tutorials/publish-packages/publish-docker-images), [artifact attestations](https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/use-artifact-attestations) e [GitHub Environments](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments).

Baseline GitHub pubblica:

- template PR con impatto su dati/provider, gate eseguiti, deploy/release e rollback;
- Issues, Discussions e Projects rivolti alla community disabilitati;
- `SECURITY.md` e Private Vulnerability Reporting attivo;
- Secret Scanning, Push Protection, CodeQL, Dependency Review, vulnerability alert e security update;
- required checks per documentazione, verifica completa e dependency review quando applicabile;
- `codex-review` required e non aggirabile, con evidenza positiva riferita all'HEAD esatto;
- `CI` come required check, incluso React Doctor completo tramite `npm run check`; il workflow separato `React Doctor` resta advisory;
- GitHub Environment `Production` protetto, secret scoped, reviewer unico e restrizione a `main`/tag di release;
- package GHCR pubblico collegato alla repository, attestazioni abilitate e nessuna cancellazione automatica dei digest usati in Production o come rollback;
- release immutabili abilitate, `.github/release.yml` minimale e pubblicazione consentita soltanto nel flusso release autorizzato;
- auto-merge Dependabot limitato alle patch delle dev dependency dirette, senza checkout o esecuzione della PR nel workflow privilegiato;
- workflow da fork senza secret, permessi read-only e nessun checkout di codice esterno sotto `pull_request_target`;
- titoli PR e commit di merge in formato Conventional Commit;
- nessun `LICENSE` finché il titolare non sceglie esplicitamente di concedere diritti.

### 18.6 Preflight provider e ricevute

Prima di qualsiasi scrittura remota:

1. identificare ambiente, account, risorsa e hostname target;
2. leggere lo stato remoto corrente;
3. verificare solo la presenza delle credenziali per i provider che le affidano a HF, senza stamparle; per Aruba verificare disponibilità dell'helper e del profilo browser locale senza ispezionare credenziali, cookie o sessione;
4. confermare autorizzazione applicabile, backup e rollback;
5. interrompere se identità o target non coincidono.

Dopo ogni deploy o scrittura remota, registrare in `docs/evidence/` o nella release:

- ambiente, commit, versione e ID remoto;
- migrazioni applicate;
- smoke e readback dalla fonte autorevole;
- versione o procedura di rollback;
- differenza fra stato GitHub, artefatto distribuito e stato live.

La ricevuta registra anche digest dell'immagine, versione schema, configurazione effettiva riletta e commit comune a `web` e `worker`. Se una superficie non è disponibile nell'ambiente di prova, viene indicata come limite residuo: non conta come esito verde.

Un exit code `0` non è prova sufficiente del risultato remoto.

Il runbook operativo mantiene una sola verifica periodica, almeno mensile e prima di ogni release, per versioni/supporto delle API Shopify/eBay, struttura del pannello Aruba, advisory runtime/container, dipendenze e impostazioni GitHub/provider. Una variazione osservata aggiorna contratto e test del solo connettore coinvolto; non crea un nuovo servizio o una nuova milestone. Le verifiche trimestrali Shopify vengono anticipate rispetto alla fine supporto della versione fissata.

---

## 19. Deployment OCI, Dynu e Caddy

### 19.1 Infrastruttura

- VPS Oracle Cloud Ampere A1 ARM64.
- Account OCI Pay As You Go con sole risorse comprese nell'Always Free.
- Ubuntu LTS ARM64 corrente già supportata dalla VPS, salvo incompatibilità verificata prima del provisioning.
- IP pubblico stabile, preferibilmente riservato se disponibile senza costo.
- Hostname Dynu, per esempio `hubfatture.dynu.net`.
- Nessun dominio a pagamento nella 1.x; `APP_BASE_URL` resta configurabile per una migrazione futura.
- Caddy per TLS.
- Docker Engine + Compose.
- Bucket OCI Object Storage privato per backup cifrati, accessibile dalla VPS soltanto tramite Instance Principal con policy minima.

Verificare live quote, forma dell'istanza, volume e limiti Always Free: i valori discussi in precedenza possono cambiare.

### 19.2 Layout server

```text
/opt/hub-fatture/
  compose.yaml
  .env
  data/
    postgres/
    documents/
  releases/ o repository deploy
```

Usare permessi stretti e proprietario dedicato.

### 19.3 Configurazione Dynu

- Record A verso IP OCI.
- Aggiornamento automatico solo se l'IP non è riservato.
- Credenziale Dynu come segreto.
- TTL ragionevole.
- Monitor manuale del certificato e della risoluzione.

### 19.4 Caddy

- Redirect HTTP -> HTTPS.
- Reverse proxy all'app.
- Header di sicurezza essenziali.
- Limite dimensioni upload.
- Access log con retention breve e senza query sensibili.

### 19.5 Deploy

Il deploy è un'azione separata e richiede autorizzazione esplicita del titolare.

Procedura prevista:

1. Workflow manuale e serializzato sul commit/tag candidato già presente in `main`, soggetto all'approvazione del GitHub Environment `Production`; un secondo deploy non cancella quello in corso.
2. Gate locali e CI verdi sullo stesso SHA.
3. Preflight di account, VPS, hostname, versione, configurazione proprietaria del target, backup e rollback.
4. Build dell'immagine `linux/arm64` una volta sola in GitHub Actions, pubblicazione su GHCR, attestazione di provenienza e registrazione del digest; `web` e `worker` usano lo stesso artefatto.
5. Migrazione DB soltanto se compatibile con versione precedente e successiva; altrimenti finestra di manutenzione e autorizzazione specifica.
6. Verifica dell'attestazione, pull da GHCR e avvio dei nuovi container dal digest esatto; nessuna build sulla VPS.
7. Verifica della baseline Compose: app non-root, nessun container privilegiato, capability eliminate salvo necessità documentata, PostgreSQL su rete interna non pubblicata, filesystem applicativo read-only salvo volumi espliciti e limiti CPU/memoria coerenti con la VPS.
8. Health check.
9. Verifica login, webhook, connessioni e percorso critico applicabile.
10. Readback completo di commit/versione, digest, schema, kill switch e configurazione non segreta effettiva.
11. Registrazione della ricevuta; rollback applicativo compatibile o forward-fix se il check fallisce.

Le migrazioni distruttive richiedono un backup off-host recente verificato, un restore drill valido e autorizzazione. Non alterare o cancellare migrazioni già applicate per rendere possibile un rollback.

### 19.6 Incidenti e kill switch

Classificazione minima:

- **P0:** invio fiscale non autorizzato o duplicato, perdita/corruzione dati, esposizione di segreti o impossibilità di determinare se Aruba ha ricevuto un documento;
- **P1:** import/sync/approvazione indisponibile senza perdita dati o con workaround manuale sicuro;
- **P2:** difetto non bloccante o degradazione minore.

La Production deve avere un kill switch semplice `ARUBA_SUBMISSION_ENABLED=false`: blocca la creazione di permessi per il clic automatico e forza i nuovi batch al percorso assistito/manuale, ma lascia disponibili numerazione autorizzata, export XML, caricamento manuale, consultazione, import e diagnosi. Il valore iniziale resta `false` finché M4-M5, Canary e autorizzazione all'uso ordinario non sono completati. Nessun kill switch separato per ogni funzione finché non emerge un bisogno reale.

Il Canary non imposta temporaneamente il flag globale a `true`. Usa invece un permesso monouso persistito in PostgreSQL e vincolato al batch, al manifest, ai documenti, alle revisioni e agli hash XML esatti, con scadenza breve. L'helper lo consuma atomicamente subito prima dell'ultimo clic, dopo aver riletto stato e autorizzazione; mismatch, scadenza, riuso o crash prima del consumo bloccano l'invio. Dopo il Canary il readback verifica che non resti alcun permesso valido. `ARUBA_SUBMISSION_ENABLED=true` viene configurato soltanto dopo la separata autorizzazione all'uso Production ordinario.

Runbook P0:

1. far attivare il kill switch al titolare o ottenere la sua autorizzazione esplicita, senza alterare documenti già registrati;
2. preservare DB, file, log sanitizzati, hash e identificativi remoti;
3. identificare commit, versione, ultimo deploy e documenti coinvolti;
4. verificare Aruba prima di ogni retry in stato incerto;
5. riprodurre in Development con fixture anonimizzate;
6. correggere la causa condivisa e aggiungere il test minimo che falliva;
7. ottenere autorizzazione prima di rollback/deploy Production o azioni fiscali correttive;
8. chiudere con readback e postmortem breve.

### 19.7 Rollback

- Conservare su GHCR almeno il digest Production corrente e quello precedente identificati nelle ricevute; nessuna regola di pulizia può cancellarli finché sono target di deploy o rollback.
- Preferire rollback applicativo compatibile con lo schema corrente; non eseguire down migration distruttive automatiche.
- Se lo schema non è retrocompatibile con la versione precedente, fermare gli invii e applicare una correzione in avanti oppure un restore esplicitamente autorizzato.
- Dopo il rollback verificare versione, schema, login, worker, connessioni, coda e kill switch.
- Un rollback è concluso solo dopo readback e smoke, non alla fine del comando.

### 19.8 OCI Monitoring e Notifications

Usare le funzioni native OCI, senza introdurre un secondo stack di monitoraggio:

- abilitare e verificare il plugin Compute Instance Monitoring sulla VPS;
- creare un solo Notifications Topic con sottoscrizione e-mail del titolare;
- configurare inizialmente quattro allarmi: indisponibilità o assenza prolungata delle metriche dell'istanza, CPU oltre l'80% per 15 minuti, memoria oltre l'85% per 15 minuti e load average anomalo per 15 minuti;
- lasciare lo spazio disco nel monitor locale; il timer backup pubblica l'errore sullo stesso Notifications Topic e il pannello segnala una ricevuta giornaliera mancante;
- verificare consegna, risoluzione e assenza di notifiche ripetute prima del canary;
- ritarare le soglie soltanto usando dati osservati, registrando la modifica nel runbook.

Le notifiche OCI sono allarmi infrastrutturali per il titolare e non sostituiscono né modificano le e-mail applicative ai clienti. Prima dell'attivazione verificare quote e condizioni correnti dell'account, senza abilitare servizi a pagamento. Riferimenti: [metriche Compute](https://docs.oracle.com/en-us/iaas/Content/Compute/References/computemetrics.htm) e [risorse Always Free](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm).

### 19.9 OCI Availability Monitoring

Creare un solo dominio APM Always Free e un solo monitor HTTP esterno:

- richiesta `GET https://<hostname>/health` con cadenza configurata entro la quota senza costo verificata;
- risposta `200` con corpo generico e stabile; il payload pubblico non espone versione, database, schema, code, provider o configurazione;
- allarme dopo due esecuzioni consecutive fallite e notifica tramite il Notifications Topic già previsto;
- prova controllata di errore e ripristino prima del canary, senza chiamare provider né usare credenziali o dati reali;
- nessun browser monitor, Real User Monitoring, tracing distribuito o script sintetico finché un bisogno osservato non lo richiede.

Questo controllo è outside-in: copre Dynu, DNS, TLS, Caddy e processo applicativo, mentre le metriche Compute coprono la VPS dall'interno. Verificare live quote e condizioni prima di M7. Riferimenti: [OCI Application Performance Monitoring](https://docs.oracle.com/en-us/iaas/application-performance-monitoring/doc/application-performance-monitoring.html) e [risorse Always Free](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm).

---

## 20. Backup off-host, copia locale e ripristino

### 20.1 Decisione

HF esegue un backup giornaliero automatico cifrato su un bucket OCI Object Storage privato e mantiene una seconda copia periodica sul Mac. Non introduce un altro provider: usa Object Storage nativo entro le quote senza costo verificate nel preflight e interrompe l'attivazione se richiede spesa.

Il repository contiene solo script:

```text
scripts/backup.sh
scripts/restore.sh
```

`scripts/backup.sh` viene eseguito sulla VPS da un timer `systemd`: produce uno snapshot coerente, lo cifra in streaming con il solo destinatario pubblico `age`, carica l'archivio cifrato tramite OCI CLI e Instance Principal limitato al bucket e verifica oggetto, checksum e dimensione tramite readback. Nessun plaintext viene scritto su disco e nessuna credenziale Object Storage statica vive sulla VPS.

Il Mac scarica periodicamente una copia già cifrata fuori dal checkout, per esempio in `~/HubFatture-Backups/`, usando una procedura breve nel runbook. Il repository non contiene backup, dump, XML o PDF reali.

Cadenza operativa iniziale:

- backup OCI giornaliero e backup aggiuntivo obbligatorio prima di ogni deploy Production con migrazioni o modifica dello storage;
- retention OCI breve tramite nomi immutabili e lifecycle del bucket; sul Mac si conserva una sola copia cifrata corrente, aggiornata dal runbook prima di deploy con migrazioni, modifiche distruttive o restore drill;
- ricevuta con timestamp, versione applicativa, versione schema DB, checksum e dimensione;
- allarme se il backup giornaliero manca, il readback fallisce o l'uso del bucket supera la soglia prudenziale definita nel runbook;
- prova che la policy lifecycle non può eliminare l'ultimo backup valido.

Il record di readiness dichiara l'RPO effettivamente osservato dal timer e dal monitor, non un intervallo promesso sulla carta.

### 20.2 Contenuto

- dump PostgreSQL consistente;
- XML;
- PDF;
- notifiche;
- manifest con versione applicazione e checksum;
- configurazione non segreta necessaria;
- segreti esclusi o inclusi solo se cifrati separatamente e richiesto;
- riferimento al recovery kit separato necessario a decifrare i valori protetti; mai la chiave in chiaro nell'archivio.

### 20.3 Sicurezza

- Archivio cifrato in streaming con il tool `age` risolto e fissato dagli artefatti dello scaffolding prima di persistenza o upload; nessuna copia temporanea in chiaro.
- Identità o passphrase `age` mai nel repository.
- Recovery kit locale sul Mac, fuori dal repository, con directory e file accessibili soltanto al titolare e volume protetto da FileVault; contiene la chiave master AEAD e le sole istruzioni/materiali indispensabili a ricostruire l'accesso, con inventario senza valori nel runbook.
- Bucket privato, accesso Instance Principal con privilegi minimi, nessun URL pubblico o pre-auth permanente e nessun permesso di cancellazione per il processo di backup quando OCI consente di separarlo dalla creazione.
- Oggetti con nome univoco, checksum e cifratura client-side; la cifratura OCI at-rest è difesa aggiuntiva, non sostituisce `age`.
- `.gitignore` per `backups/`, dump, XML, PDF, archivi e file temporanei di restore.

### 20.4 Restore

Lo script:

- richiede target esplicito;
- scarica dall'oggetto OCI o usa la copia cifrata sul Mac;
- verifica checksum;
- rifiuta di sovrascrivere un ambiente attivo senza conferma;
- ripristina DB e storage coerenti;
- esegue health check;
- produce un log senza dati sensibili.

Il restore deve essere collaudato almeno una volta in ambiente non produttivo prima del go-live.

Il collaudo parte da una macchina/ambiente che non possiede i segreti della VPS originaria, usa il recovery kit del titolare e dimostra almeno login, decifratura di una credenziale sintetica, connessioni riconfigurabili e integrità di DB/documenti. Non registrare valori o output sensibili nell'evidenza.

Ripetere il restore drill almeno ogni tre mesi e prima di una modifica distruttiva rilevante. La prova è conclusa solo quando DB, documenti, login e health check risultano coerenti; la sola estrazione dell'archivio non basta.

---

## 21. Requisiti non funzionali

### 21.1 Affidabilità

- Elaborazione idempotente.
- Nessun doppio invio.
- Transazioni per passaggi critici.
- Recupero dopo riavvio worker.
- Health check per app e DB.
- Stati incerti visibili e risolvibili.
- Nessun successo locale per una mutazione provider non confermata.
- Webhook/job `processing` recuperabili dopo scadenza della lease.
- Audit critico atomico con la transizione attestata.

### 21.2 Prestazioni

Il volume atteso è di circa 300-400 fatture mensili e qualche centinaio di ordini in più. Obiettivi:

- liste comuni sotto 2 secondi sulla LAN/Internet ordinaria;
- webhook accettati rapidamente e lavorati in background;
- operazioni massive paginate e asincrone;
- indici sulle chiavi esterne, stati, date, identificativi e ricerca cliente.

### 21.3 Manutenibilità

- Monolite, moduli netti.
- Niente astrazioni con una sola implementazione salvo confini esterni reali.
- Tipi e validazione ai confini API.
- Migrazioni versionate.
- Logger nativo JSON tipizzato, senza dipendenze dedicate.
- README operativo.
- Dipendenze ridotte e aggiornabili.

### 21.4 Accessibilità

- Navigazione tastiera.
- Etichette form.
- Focus visibile.
- Errori associati ai campi.
- Contrasto adeguato.
- Dialoghi di conferma accessibili.
- Nessuna informazione comunicata solo tramite colore.
- Focus restituito correttamente dopo dialoghi e operazioni asincrone.
- Zoom 200% senza perdita di funzione e layout utilizzabile a 320 px CSS dove applicabile.

### 21.5 Osservabilità

- Request ID.
- Job ID.
- Log JSON strutturati con livelli, un oggetto per riga su stdout/stderr e sole chiavi allowlist.
- Stato connessioni e ultimo sync nel pannello.
- Nessun servizio SaaS obbligatorio.
- Rotazione log locale.
- Niente payload completi, query string sensibili, token, identificativi fiscali o contenuto XML/PDF nei log ordinari.
- Debug dettagliato attivabile solo per una finestra breve in Development con dati sintetici, poi disattivato e verificato.
- Query operative salvate per job falliti, upload incerti, scarti, ritardi di sync, spazio disco e backup scaduto.
- OCI Monitoring raccoglie le metriche host native; OCI Notifications invia soltanto i quattro allarmi infrastrutturali iniziali al titolare.
- OCI Availability Monitoring esegue un solo controllo HTTP esterno con cadenza entro quota e usa lo stesso Notifications Topic dopo due fallimenti consecutivi.
- Il backup espone soltanto timestamp, checksum, dimensione e stato sanitizzato dell'ultima ricevuta; il fallimento del timer pubblica sul topic esistente e diventa visibile nel pannello.
- Se scelto dopo il PoC, OCI Email Delivery espone nel pannello soltanto stato del trasporto, ultimo invio e codice errore sanificato; contenuto, destinatari e credenziali non entrano nei log OCI.
- La prova operativa di ogni allarme comprende evento controllato o test supportato, notifica ricevuta, risoluzione e assenza di loop.

Stop point per rivalutare capacità o architettura, non trigger di migrazione automatica:

- volume ordini o documenti oltre 10 volte la previsione per due mesi;
- filesystem o volume PostgreSQL oltre il 70% per sette giorni;
- ritardo di sincronizzazione superiore a 30 minuti in condizioni normali;
- code non recuperate entro un'ora o retry che richiedono interventi ricorrenti;
- restore completo oltre quattro ore;
- impossibilità di diagnosticare un incidente grave con i log sanitizzati disponibili.

### 21.6 Costi e dipendenze esterne

- Nessun servizio ricorrente a pagamento introdotto da HF.
- Usare le risorse OCI Always Free già disponibili, Dynu, Caddy, PostgreSQL e software open source.
- Usare GHCR pubblico e artifact attestations finché restano inclusi nel piano GitHub applicabile; verificare quote e condizioni prima di M7.
- Usare un solo dominio APM Always Free e un solo monitor HTTP; non abilitare funzioni APM aggiuntive senza un bisogno osservato.
- Usare un solo bucket Object Storage privato per i backup cifrati, con lifecycle e soglia prudenziale; il preflight blocca configurazioni che escono dalla quota senza costo.
- Il PoC OCI Email Delivery resta entro la quota senza costo verificata, usa soltanto messaggi sintetici e non abilita costi; quota e condizioni vanno riverificate prima di M6.
- Shopify Partner/Dev, Codex/Claude Code, account Aruba Base e Chrome o Edge sul computer operativo sono prerequisiti posseduti o gestiti separatamente dal titolare; HF non richiede un add-on Aruba a pagamento.
- Se un limite gratuito o una condizione contrattuale cambia, fermarsi e proporre l'alternativa prima di attivare costi.

### 21.7 Politica delle dipendenze

- La matrice in 14.3 è l'elenco iniziale accettato: nessuna scelta di tool o dipendenza resta aperta allo scaffolding, mentre i pin nascono soltanto nel manifest e nel lockfile.
- Pin esatto delle dipendenze dirette e lockfile committato; le versioni transitive sono determinate dal lockfile.
- Node.js e npm risolti in M0 sono fissati in `mise.toml` e riusati in locale, CI e build Docker.
- Installazione riproducibile con `npm ci`.
- Nessuna beta/RC/canary salvo eccezione esplicita e temporanea documentata.
- Dipendenze nuove solo quando piattaforma, standard library o stack già installato non coprono il bisogno in modo semplice.
- `pdfkit` resta assente dal manifest finché HF-O03 non attiva il fallback già selezionato; non valutare una seconda libreria PDF.
- `react-doctor` ha pin esatto e viene aggiornato deliberatamente insieme alla configurazione e allo smoke; l'Action ufficiale resta advisory e fissata a commit completo.
- Oxlint e Oxfmt con pin esatto, aggiornati insieme e senza tool equivalenti mantenuti in parallelo.
- Dependabot settimanale; auto-merge solo per patch delle dev dependency dirette dopo i required check, tutto il resto deliberato manualmente.
- Audit obbligatorio quando cambiano manifest o lockfile e prima di ogni release.
- Un advisory senza percorso vulnerabile attivo può essere accettato soltanto con motivazione verificabile e condizione di riapertura.

---

## 22. Strategia di test

### 22.1 Test unitari mirati

Usare `node:test` del runtime fissato come unico runner unitario e d'integrazione TypeScript. I test `.ts` rispettano gli stessi vincoli di type stripping degli script locali; non introdurre Vitest, Jest o un secondo runner.

- normalizzazione Codice Fiscale/P.IVA senza inventare il tipo;
- data ordine in Europe/Rome;
- chiave di raggruppamento;
- conversione stretta delle stringhe decimali esterne in centesimi, inclusi segno, zeri, cifre eccedenti e limiti del dominio DB;
- calcolo riga semplificata;
- differenze importo;
- residuo accreditabile;
- esclusione della nota di credito quando la fattura originaria è scartata;
- cambio trigger senza ricreare bozze esistenti;
- mapping stati esterni;
- generazione XML a partire dalla fixture Aruba.
- classificazione strutturata delle differenze fra sorgente, bozza e proiezione XML.

### 22.2 Test di integrazione

- PostgreSQL reale in container.
- Vincoli idempotenza webhook.
- Due ordini concorrenti nello stesso gruppo.
- Doppio rimborso.
- Numerazione concorrente.
- Job retry.
- Readback Aruba ripetuto o importato fuori ordine senza regressione dello stato.
- Webhook/job rimasto `processing` dopo crash e riacquisito soltanto a lease scaduta.
- storage e checksum.
- sessioni e TOTP.
- impossibilità di preparare o autorizzare un invio senza approvazione e snapshot immutabile.
- import storico non approvabile prima della riconciliazione Aruba.
- due browser modificano la stessa bozza/configurazione: la seconda scrittura riceve conflitto.
- comparatore e approvazione usano la stessa revisione e lo stesso hash; una proiezione stale viene rifiutata.
- errore remoto dopo approvazione: snapshot/audit restano coerenti, stato provider non diventa riuscito.
- evento fuori ordine non fa regredire uno stato provider già riconciliato.
- audit critico assente provoca rollback della transazione, non una transizione priva di prova.
- permesso Aruba valido consumato una sola volta; batch, manifest, documento, revisione o hash diversi, permesso scaduto/consumato e crash prima del consumo non autorizzano l'ultimo clic.
- migrazione da database vuoto e da snapshot della release precedente con dati sintetici rappresentativi.

### 22.3 Contract test

Fixture sanificate per:

- Shopify ordine italiano privato;
- Shopify azienda;
- Shopify pagamento pendente;
- Shopify rimborso parziale;
- eBay ordine con Codice Fiscale;
- eBay ordine con P.IVA;
- eBay rimborso ambiguo;
- pagina Aruba sintetica: validazione positiva/negativa, login richiesto e DOM inatteso;
- pagina Aruba sintetica: arresto assistito, invio automatico autorizzato e stato incerto;
- file XML/PDF/P7M e notifiche SdI scaricati, sanitizzati e importabili.

Ogni connettore copre anche timeout, risposta oltre il limite, risposta non parsabile, schema inatteso, autenticazione scaduta e rate limit, verificando la traduzione nel codice errore stabile. L'helper copre inoltre hostname inatteso, sessione scaduta, richiesta 2FA/CAPTCHA, locatore assente, documento estraneo e permesso non valido. Le fixture rappresentano il payload o DOM minimo realmente osservato, ma sono sanificate e non vengono trattate come prova dello stato live.

### 22.4 End-to-end

1. Login + TOTP.
2. Import ordine.
3. Correzione cliente.
4. Raggruppamento di due ordini.
5. Comparazione sorgente/bozza/proiezione XML.
6. Validazione.
7. Approvazione.
8. Helper Aruba assistito e automatico contro la pagina sintetica locale.
9. Stato Aruba/SdI tramite readback.
10. E-mail tramite il trasporto canonico scelto.
11. Rimborso.
12. Comparazione e nota di credito.

Il percorso critico verifica anche refresh durante un'azione, doppio click/submit, caricamento specifico, conflitto fra due schede e conseguenza dichiarata nella conferma finale. Lo stato mostrato dopo ogni passaggio proviene dalla fonte autorevole o da un'esplicita condizione di riconciliazione.

Playwright è il runner E2E canonico:

- sulle PR esegue Chromium soltanto su quattro flussi sintetici: login/TOTP, import fixture, creazione/raggruppamento Scheda e approvazione contro Aruba mock;
- in M8 esegue gli stessi flussi HF con Chromium e WebKit sul candidato; contro la pagina Aruba sintetica verifica inoltre l'helper con Chrome o Edge su runner macOS e Windows e aggiunge i percorsi completi di stato SdI, e-mail e nota di credito;
- usa locator accessibili e dati sintetici deterministici; nessuna credenziale o informazione reale entra in test, report o trace;
- registra la trace soltanto al primo retry fallito, con retention CI breve di 7 giorni; niente video continui o snapshot visuali finché non esiste una regressione visiva concreta;
- non traccia né automatizza il Canary Production e non aggiunge Firefox finché non emerge un bisogno reale.

Riferimenti da riverificare allo scaffold: [Playwright Trace Viewer](https://playwright.dev/docs/trace-viewer) e [best practice Playwright](https://playwright.dev/docs/best-practices).

### 22.5 Test di sicurezza

- CSRF.
- session fixation.
- rate limit login.
- webhook signature.
- token helper breve e vincolato al batch, allowlist hostname e consumo atomico del distinto permesso Aruba monouso.
- OAuth state/PKCE dove applicabile.
- path traversal nello storage.
- log redaction.
- segreti assenti dal bundle frontend.
- `413` prima del parsing per form, webhook, richieste helper, XML e PDF oltre soglia, inclusi endpoint autenticati.
- timeout e limite byte sulle risposte remote.
- rifiuto di XML con `DOCTYPE`, entità esterne, profondità o numero elementi oltre soglia.

### 22.6 Test di recovery

- chiusura del browser durante caricamento e subito prima/dopo l'ultimo clic;
- stato Aruba incerto dopo invio;
- riconciliazione dal pannello o da file ufficiale prima di un nuovo tentativo;
- riavvio DB/app;
- webhook duplicato;
- restore completo da backup OCI o dalla copia cifrata sul Mac usando il recovery kit fuori dalla VPS originaria.
- deploy della versione applicativa precedente sullo schema espanso corrente;
- readback con target volutamente errato in ambiente non produttivo, che deve bloccare il preflight;
- verifica che un rollback non suggerisca down migration o cancellazione della cronologia applicata.

### 22.7 Test manuali prima del go-live

- Ordine reale di importo minimo per Shopify.
- Ordine reale o sandbox eBay.
- caricamento controllato di XML sintetico/anonimizzato nel pannello Aruba, con arresto prima dell'invio salvo autorizzazione separata.
- helper provato contro la pagina sintetica locale su Windows e macOS con Chrome o Edge.
- Nessun invio produzione finché il titolare non autorizza.
- Confronto XML generato con XML Aruba accettato.
- Verifica PDF.
- Verifica e-mail reale tramite il trasporto canonico scelto; se OCI Email Delivery è stato adottato, verificare anche sender, regione e assenza del destinatario nella suppression list.

Per ogni prova manuale annotare ipotesi testata, risultato osservato, ipotesi escluse e limiti dell'ambiente. Una superficie non disponibile o non esercitata resta un rischio residuo con trigger di chiusura, non un test superato.

### 22.8 Gate di diagnosi e correzione

Quando una prova live espone un difetto:

1. riprodurre il caso minimo e identificare la fonte autorevole;
2. verificare tutti i chiamanti del punto condiviso prima di modificare;
3. correggere la causa comune, non la singola schermata o route;
4. aggiungere il più piccolo test che falliva prima;
5. rileggere il contratto o la milestone completa per rimuovere copy, chiavi e rami ormai morti;
6. ripetere il gate live che aveva trovato il difetto.

---

## 23. Milestone

Le milestone applicative sono sequenziali. M1-M3 costruiscono l'app senza dipendere da Aruba; M4 incorpora qualifica fiscale, documenti, approvazione e prova manuale controllata; M5 integra il pannello e l'helper soltanto dopo quel gate. Non esiste una corsia Aruba parallela e l'helper non è un progetto iniziale autonomo.

Brand Foundation leggera, comparatore fiscale e PoC/decisione OCI Email Delivery entrano nelle milestone che già possiedono i relativi contratti. Non nasce una milestone intermedia e non si aggiungono un design system, una libreria di diff XML o due trasporti SMTP paralleli.

Le scelte di tool e dipendenze chiuse nella matrice 14.3 non generano una milestone aggiuntiva: M0 ne verifica compatibilità e lockfile, M1 le usa per le fondazioni, le milestone successive installano soltanto ciò che raggiunge un caso d'uso reale.

Stati ammessi: `non iniziata`, `in corso`, `bloccata`, `completata`. Una milestone è `completata` solo quando deliverable e criteri di uscita hanno evidenze fresche in `docs/evidence/` o in output automatici collegabili. Il riepilogo di chiusura registra commit, versione eventuale, prove, difetti corretti, rischi residui e milestone successiva; non riscrive il contenuto della milestone.

### M0 - Ricognizione e scaffolding readiness

Output:

- repository GitHub pubblica creata da un albero e una cronologia verificati, senza segreti plaintext o dati reali; unica eccezione il blob key `age` previsto;
- `ssh-key-ampere-a1.key` rimasta invariata e fuori da Git; copia `age` verificata archiviata in `ops/secrets/oci-vps-access.key.age`, con gate che rifiuta chiavi private plaintext;
- assenza di `LICENSE` e natura non open-source dichiarate in README/CONTRIBUTING;
- istruzioni agentiche ispezionate; `CLAUDE.md` importa `AGENTS.md` senza duplicazioni;
- matrice 14.3 verificata con risoluzione peer, lockfile iniziale, audit e compatibilità `linux/arm64` delle immagini;
- `mise.toml` con le versioni Node.js/npm risolte in M0, verificato sul Mac e riusato dalla CI;
- Oxlint/Oxfmt configurati come unica toolchain lint/formato e inclusi nel comando canonico;
- stack definitivo annotato senza alternative tecniche ancora da scegliere;
- fixture mock prive di dati reali;
- `AGENTS.md`, `README.md` e `docs/INDEX.md` allineati allo stato reale;
- branch protection su `main`, template PR, Dependabot e baseline sicurezza GitHub pubblica configurati; Issues, Discussions e Projects rivolti alla community disabilitati;
- gate `codex-review` adattato da CF Ready, required e verificato su HEAD stabile, nuovo commit e finding corrente senza eseguire codice PR in contesto privilegiato;
- auto-merge Dependabot configurato fail-closed, senza auto-approvazione né esecuzione del codice PR nel contesto privilegiato; la prova end-to-end è differita a M8 e non blocca M1-M7;
- release immutabili abilitate e categorie minime di `.github/release.yml` definite senza creare una release anticipata;
- React Doctor completo bloccante nel gate locale/CI e Action ufficiale advisory sulle modifiche delle PR;
- Playwright configurato con Chromium, smoke sintetico e trace solo al primo retry;
- comando locale canonico e CI essenziale verificati;
- preflight provider disponibile prima della prima scrittura remota;
- nessun accesso di produzione richiesto in chat.

### M1 - Fondazioni locali

Output:

- repository;
- monolite React Router su Node.js secondo la matrice 14.3;
- PostgreSQL con `pg` e SQL parametrizzato secondo la matrice 14.3;
- migrazioni SQL append-only applicate dal runner compilato con advisory lock e checksum;
- test installazione vuota e upgrade da snapshot rappresentativo;
- Docker Compose locale;
- autenticazione amministratore + TOTP;
- limiti di body e timeout comuni applicati prima di parsing/buffering, con errori stabili e test minimi;
- Brand Foundation leggera approvata, con fonte unica e asset minimi versionati;
- registro errori stabile e inventario segreti senza valori;
- CI essenziale.

### M2 - Dominio ordini e Schede

Output:

- schema ordine/cliente/Scheda;
- import fixture;
- trigger globale;
- raggruppamento giornaliero;
- UI ordini e Schede;
- audit.
- contratto tecnico corrente per fonti autorevoli, transazioni e concorrenza riusato dalle milestone successive.

### M3 - Connettori Shopify ed eBay

Output:

- OAuth;
- versioni/endpoint API supportati fissati nei contratti con finestra di supporto e verifica periodica;
- webhook/sync;
- tax ID;
- pagamenti/evasioni;
- rimborsi;
- anteprima dell'import storico di 7 giorni in modalità prudenziale; esecuzione reale rimandata al go-live.

### M4 - Documenti e approvazione

Output:

- audit autenticato read-only del pannello Aruba completato;
- XML accettato analizzato e anonimizzato come fixture;
- profilo fiscale e regole di numerazione definiti e approvati;
- righe semplificate;
- modifica controllata;
- conferme eccezionali;
- approvazione singola e massiva;
- generatore XML definitivo per fattura e TD04, con golden test e numerazione mock disponibile nei test;
- comparatore fiscale sorgente/bozza/proiezione XML basato sullo stesso generatore e protetto da revisione/hash;
- storage immutabile;
- XML candidato verificato nella prova manuale controllata, con riepilogo e controllo finale osservati, arresto prima dell'ultimo clic e upload pendente rimosso senza invio.

### M5 - Integrazione Aruba e helper locale

Prerequisito: M4 completata, inclusa la prova controllata. Nessuna attività di implementazione dell'helper anticipa questo prerequisito.

Output:

- mapping stati, limiti di upload, locatori minimi e percorso manuale verificati sul pannello reale;
- pagina Aruba sintetica locale per test deterministici;
- helper TypeScript/Playwright unico per Windows e macOS con Chrome o Edge;
- pause sicure per login, 2FA e CAPTCHA;
- upload e validazione visibile tramite UI;
- modalità `Assistita` e `Automatica dopo conferma`;
- manifest e permesso monouso verificati prima dell'ultimo clic;
- readback/import di stati, notifiche, XML, P7M e PDF;
- fallback manuale completo;
- recovery senza retry cieco dopo stato incerto;
- parser XML/PDF e output del pannello limitati e testati contro input ostili o eccessivi.

### M6 - Note di credito ed e-mail

Output:

- cumulazione rimborsi;
- TD04;
- TD04 instradato nello stesso manifest, nelle stesse due modalità helper e nello stesso fallback manuale delle fatture;
- PoC OCI Email Delivery con dati sintetici, confronto con il provider esistente e decisione documentata;
- un solo trasporto SMTP canonico configurato;
- modalità automatica/manuale;
- reinvio.

### M7 - Produzione su OCI

Output:

- Dynu;
- Caddy;
- hardening;
- Compose produzione;
- monitor locale;
- immagine `linux/arm64` pubblicata su GHCR, attestata e consumata per digest senza build sulla VPS;
- immagine applicativa non-root, scansione vulnerabilità e baseline Compose senza privilegi verificati;
- GitHub Environment `Production` protetto, approvazione single-owner e secret scoped verificati;
- plugin OCI Compute Instance Monitoring, Notifications Topic e quattro allarmi iniziali collaudati;
- dominio APM Always Free e singolo monitor HTTP esterno collaudati con errore/ripristino controllati;
- bucket OCI Object Storage privato, Instance Principal minimo, lifecycle, timer backup e allarme di mancato backup collaudati senza costi attivati;
- se OCI Email Delivery è stato scelto, dominio/sender, SPF/DKIM, credenziali SMTP dedicate, regione e suppression list verificati senza dati cliente;
- kill switch Aruba verificato con creazione dei permessi ordinari per il clic automatico bloccata e percorso assistito/manuale invariato;
- procedura di installazione/avvio dell'helper verificata su Windows e macOS senza installarlo sulla VPS;
- backup/restore collaudato da un ambiente privo dei segreti originari usando il recovery kit locale protetto sul Mac;
- runbook incidenti e rollback;
- formato della ricevuta deploy/readback verificato;
- workflow Production manuale e serializzato, stesso digest per web/worker e readback completo verificato.

Richiede autorizzazione esplicita prima del deploy.

### M8 - Collaudo e release candidate

Output:

- deploy del candidato sullo stesso SHA e digest destinati alla `1.0.0`, con creazione dei permessi ordinari per il clic automatico bloccata (`ARUBA_SUBMISSION_ENABLED=false`);
- readback operativo che conferma l'assenza di documenti approvati o trasmissibili e di upload Aruba pendenti;
- import reale degli ultimi 7 giorni e riconciliazione con Aruba senza numerare o trasmettere;
- test end-to-end HF completi su Chromium e WebKit e test helper contro la pagina Aruba sintetica su Windows/macOS con Chrome o Edge, oltre a recovery, sicurezza e migrazioni;
- comparatore fiscale verificato su fattura e TD04, inclusi proiezione stale, modifiche manuali e arrotondamenti;
- trasporto SMTP canonico verificato end-to-end con ricevuta e reinvio;
- audit trasversale del codice corrente in `docs/audits/release-candidate-review.md`, concentrato su transazioni/concorrenza, duplicazioni, webhook/job interrotti, stato locale/provider, migrazioni/rollback, autorizzazioni server-side, dati fiscali e azioni irreversibili;
- runbook operativo;
- `docs/runbooks/release-readiness.md` compilato come record candidato corrente con prove fresche e rischi residui;
- attestazione del digest verificata, gate `Production` osservato, allarmi OCI e monitor HTTP esterno in stato sano;
- scansione dell'immagine candidata senza finding critici/alti raggiungibili aperti;
- backup OCI giornaliero osservato, copia cifrata sul Mac e RPO effettivo registrato;
- auto-merge Dependabot verificato end-to-end sulla prima patch reale idonea di una dev dependency diretta oppure, se non si presenta, su una patch sintetica verso un branch base temporaneo protetto dagli stessi required check e abilitato esplicitamente nei workflow; in ogni caso prima della release Production e senza alterare i pin di `main`;
- approvazione del titolare per accedere al canary.

Gate:

- nessun P0/P1 o decisione bloccante aperta;
- ogni finding dell'audit ha prova, severità e stato corrente; P2/P3 residui hanno accettazione e condizione di riapertura;
- nessun ordine storico approvabile senza riconciliazione;
- commit, digest, schema, backup, rollback e kill switch verificati;
- nessun documento approvato o trasmissibile e nessun upload Aruba pendente;
- prova end-to-end dell'auto-merge Dependabot chiusa senza auto-approvazione né esecuzione privilegiata del codice PR; qualsiasi esito non riconosciuto ha lasciato la PR aperta e gli eventuali branch, regole e trigger temporanei sono stati rimossi dopo la prova;
- nessun invio Aruba reale eseguito in questa milestone.

### M9 - Canary Production

Output:

- backup verificato immediatamente prima della prova;
- scelta di una sola fattura reale controllata, di importo minimo ragionevole, senza altri documenti approvati o upload pendenti;
- autorizzazione esplicita del titolare per quel singolo invio;
- creazione di un batch di una sola fattura e di un permesso monouso a scadenza breve legato al manifest, al documento, alla revisione e all'hash XML esatti, lasciando `ARUBA_SUBMISSION_ENABLED=false`;
- consumo atomico del permesso da parte dell'helper subito prima dell'ultimo clic per la sola fattura selezionata;
- readback completo di Aruba/SdI, PDF, e-mail, archiviazione, hash e audit;
- ricevuta canary con commit, digest, ID tecnico interno del documento senza dati cliente, identificativi remoti sanitizzati, esiti, permesso consumato e stato finale del kill switch.

Gate:

- nessun altro documento trasmesso nella finestra;
- `ARUBA_SUBMISSION_ENABLED=false` rimasto invariato e nessun permesso canary ancora valido, confermati tramite readback anche se la prova fallisce;
- nessun P0/P1 e nessuno stato remoto incerto irrisolto;
- catena end-to-end osservata e record di readiness aggiornato.

Se il canary richiede una modifica di codice, immagine, schema o configurazione operativa, il candidato cambia e va ripetuta almeno la parte del canary interessata. La sola correzione documentale della ricevuta non lo invalida.

### M10 - Go-live e `1.0.0`

Output:

- approvazione finale del titolare sulla ricevuta canary e sui rischi residui;
- runbook operativo;
- `docs/runbooks/release-readiness.md` finalizzato con prove fresche e rischi accettati;
- draft GitHub Release completata con note verificate e `release-manifest.json` sanitizzato;
- tag e GitHub Release immutabile `v1.0.0` pubblicati sullo stesso commit e digest superati dal canary;
- abilitazione dell'uso Production ordinario;
- monitoraggio rafforzato della prima giornata operativa.

Richiede autorizzazioni esplicite e separate per release e uso Production ordinario. Il canary non le implica.

---

## 24. Backlog di implementazione sequenziale

Ogni task deve lasciare un check eseguibile. Evitare scaffolding non usato.

### Fondazioni

1. Creare repository GitHub pubblica, `AGENTS.md`, `CLAUDE.md` minimale, README, CONTRIBUTING, `SECURITY.md` e `docs/INDEX.md` iniziali senza duplicare il Master Plan e senza aggiungere `LICENSE`.
2. Creare il monolite con React e React Router scelti in 14.3, risolvendo in M0 una combinazione stabile in modalità framework con adapter Node e server Production accettati.
3. Creare `mise.toml` con Node.js e npm risolti in M0, riusarlo in CI/build Docker e configurare TypeScript strict, Oxlint e Oxfmt senza ESLint/Prettier paralleli.
4. Aggiungere Docker Compose locale con immagini app/PostgreSQL/Caddy fissate per digest nei file Compose.
5. Aggiungere il livello dati `pg`, il runner compilato e migrazioni SQL append-only con advisory lock e checksum; testare database vuoto, file applicato modificato e snapshot della versione precedente.
6. Aggiungere configurazione Zod validata all'avvio, revisione ottimistica e readback completo.
7. Aggiungere health check app e DB.
8. Aggiungere i test `node:test`, Playwright con Chromium, uno smoke sintetico, trace al primo retry e il comando locale canonico dei gate.
9. Aggiungere CI per documentazione, `oxlint`, `oxfmt --check`, typecheck, test, Playwright e build; eseguire React Doctor completo nel gate locale/CI e mantenere l'Action ufficiale advisory sulle modifiche delle PR; adattare da CF Ready il required check `codex-review` exact-HEAD con il suo test minimo; configurare protezione `main`, template PR, Dependabot con auto-merge limitato alle patch delle dev dependency dirette, Secret Scanning, Push Protection, CodeQL, Dependency Review e vulnerabilità private; lasciare disabilitati Issues, Discussions e Projects rivolti alla community.
10. Definire e far approvare la Brand Foundation leggera in `docs/brand/`, creando soltanto marchio SVG, favicon, asset raster richiesti e token minimi.
11. Configurare `.gitignore` per env, `*.key`, backup, dump, XML, PDF e storage; cifrare e verificare la key VPS in `ops/secrets/oci-vps-access.key.age`, mantenere il plaintext fuori da staged tree e cronologia e aggiungere il gate anti-key-plaintext; verificare link/comandi documentati.

### Autenticazione

12. Implementare bootstrap del singolo amministratore.
13. Implementare password hash e login con `node:crypto.scrypt` e confronto constant-time.
14. Implementare sessioni React Router sicure persistite in PostgreSQL.
15. Implementare TOTP con OTPAuth e recovery code generati e hashati con `node:crypto`.
16. Aggiungere rate limiting e audit login.
17. Proteggere tutte le route applicative e applicare prima del buffering/parsing limiti condivisi di body, timeout e dimensione risposta, con errori stabili e test `413`/timeout.

### Modello dati

18. Creare tabelle connessioni, cursori e ricevute webhook senza payload, con lease e recupero dopo crash.
19. Creare clienti e record sorgente.
20. Creare ordini, righe, tax ID e pagamenti.
21. Creare Schede e relazione ordini.
22. Creare documenti, righe e collegamenti.
23. Creare rimborsi e vincoli univoci.
24. Creare submission Aruba e notifiche.
25. Creare storage objects.
26. Creare job queue PostgreSQL con lease, retry e recupero idempotente.
27. Creare audit events distinguendo audit critico atomico e telemetria operativa allowlisted.

### Dominio ordini

28. Implementare normalizzatore comune minimo.
29. Implementare validazione EUR.
30. Implementare trigger pagamento/evasione completa.
31. Implementare chiave giornaliera Europe/Rome.
32. Implementare matching cliente prudente.
33. Implementare raggruppamento atomico.
34. Implementare annullamento senza documento.
35. Implementare righe fattura semplificate.
36. Implementare riconciliazione totale interno.

### UI operativa

37. Creare catalogo italiano, glossario con termini vietati, fondazione UI operativa, layout e navigazione coerenti con la Brand Foundation.
38. Creare Dashboard.
39. Creare lista e dettaglio ordini.
40. Creare lista e dettaglio Schede.
41. Creare editor cliente e righe.
42. Creare flusso `Non trasmettere`.
43. Creare pagina approvazione con riepilogo della conseguenza, controllo revisione e conferma specifica.
44. Implementare il comparatore fiscale strutturato sorgente/bozza/proiezione XML, con classificazione delle differenze e blocco delle revisioni stale.
45. Creare conferma pagamento pendente.
46. Creare conferma differenza importo con motivazione.
47. Creare approvazione massiva con esclusioni.
48. Creare registro attività.
49. Creare pannello errori e retry.
50. Verificare accessibilità delle azioni critiche e del comparatore.

### Shopify

51. Registrare/configurare app custom per un solo store e fissare nel contratto la versione GraphQL supportata, la fine supporto e il check dello schema.
52. Implementare OAuth e storage token.
53. Verificare scope e protected customer data.
54. Implementare query ordine completa.
55. Implementare mapping localized fields su ordine reale.
56. Implementare fallback tax ID cliente.
57. Implementare verifica firma webhook sui byte originali e codici errore stabili.
58. Implementare ingest idempotente, lease e riconciliazione dalla fonte Shopify.
59. Implementare sync periodico di recupero.
60. Implementare annullamenti e rimborsi.
61. Se l'API corrente lo consente in modo semplice e sicuro, implementare la propagazione facoltativa dell'anagrafica cliente; altrimenti documentare il rinvio senza bloccare la 1.x.

### eBay

62. Configurare Sandbox e Production, registrando endpoint/versione effettivi e deprecazioni applicabili nel contratto.
63. Implementare OAuth e refresh token.
64. Implementare `getOrders` incrementale.
65. Implementare dettaglio `getOrder`.
66. Mappare `buyer.taxIdentifier` da payload reale.
67. Implementare pagamenti e fulfillment.
68. Implementare rimborsi e controllo ambiguità.
69. Implementare polling con cursore e overlap.

### Documenti e approvazione - M4

70. Completare audit Aruba read-only e fixture anonimizzata.
71. Definire profilo fiscale e numerazione versionati.
72. Implementare con `xmlbuilder2` il generatore XML per fattura.
73. Implementare con lo stesso builder e profilo il generatore XML TD04.
74. Validare XML con `xmllint` contro lo schema ufficiale corrente e rifiutare prima del parsing `DOCTYPE`, entità esterne e input oltre i limiti di byte/struttura.
75. Implementare numerazione atomica dopo audit.
76. Implementare snapshot immutabile e hash.
77. Eseguire la prova manuale controllata e autorizzata del candidato XML valido prodotto da M4, osservare riepilogo e controllo finale, arrestarsi prima dell'ultimo clic, rimuovere l'upload pendente e registrarne il readback sanitizzato.

### Integrazione Aruba e helper - M5

78. Implementare pagina Aruba sintetica locale, registro errori e contratto minimo dei locatori semantici derivati dalla prova.
79. Implementare helper TypeScript/Playwright unico per Windows e macOS, usando Chrome o Edge e un profilo locale dedicato.
80. Implementare pause umane per login/2FA/CAPTCHA, allowlist hostname e divieto di endpoint privati.
81. Implementare upload, lettura della validazione e arresto assistito prima dell'ultimo clic.
82. Implementare manifest e permesso monouso per la modalità automatica, con consumo atomico subito prima del clic finale.
83. Implementare stato incerto fail-closed, readback/import dei file ufficiali e download PDF dal pannello oppure, solo se HF-O03 lo richiede, attivare il fallback PDFKit già scelto.
84. Implementare export XML e procedura manuale completa.

### Note di credito

85. Implementare ingest rimborso completato.
86. Implementare bozza TD04 cumulativa.
87. Implementare residuo accreditabile.
88. Implementare nuova bozza dopo nota già emessa.
89. Bloccare nota per fattura scartata.
90. Creare UI note di credito.

### E-mail

91. Eseguire il PoC OCI Email Delivery in Development, confrontarlo con il provider esistente e registrare la scelta di un solo trasporto canonico.
92. Implementare con Nodemailer l'unica configurazione SMTP del trasporto scelto.
93. Implementare template italiano semplice.
94. Implementare modalità automatica/manuale.
95. Implementare invio post-accettazione Aruba.
96. Implementare stato, errore e reinvio.

### Produzione e continuità

97. Preparare Compose produzione con `web` e `worker` vincolati allo stesso digest GHCR e PostgreSQL/Caddy ai digest accettati; eseguire l'app come non-root, eliminare privilegi/capability non necessari, isolare PostgreSQL e rendere read-only il filesystem applicativo salvo volumi espliciti.
98. Preparare Caddyfile.
99. Configurare Dynu e IP OCI.
100. Applicare firewall e hardening SSH.
101. Configurare il GitHub Environment `Production`, reviewer single-owner, restrizioni `main`/tag e secret scoped.
102. Creare il workflow che costruisce una sola immagine `linux/arm64`, la pubblica su GHCR, genera l'attestazione, esegue la scansione vulnerabilità e restituisce il digest.
103. Verificare pull per digest e attestazione sulla VPS senza build remota; preservare i digest corrente e precedente.
104. Abilitare il plugin OCI Compute Instance Monitoring e configurare Notifications Topic e sottoscrizione e-mail.
105. Configurare e collaudare i quattro allarmi OCI iniziali senza loop o servizi a pagamento.
106. Creare il dominio APM Always Free e il singolo monitor HTTP esterno ogni 6 minuti, collegandolo al topic esistente.
107. Implementare rotazione log.
108. Implementare `scripts/backup.sh` eseguito dal timer sulla VPS, con cifratura streaming `age`, upload OCI tramite Instance Principal, readback e allarme; predisporre il recovery kit locale protetto e la copia periodica sul Mac.
109. Implementare `scripts/restore.sh` con checksum, target esplicito, conferma distruttiva e divieto di usare il restore come normale rollback schema.
110. Collaudare restore in ambiente non produttivo senza riusare i segreti della VPS originaria e verificare timer, readback, lifecycle, allarme e copia periodica sul Mac.
111. Preparare runbook di deploy manuale serializzato, preflight, ricevuta/readback, incidenti e rollback/forward-fix, includendo la verifica mensile di API Shopify/eBay, pannello Aruba, dipendenze, immagini e impostazioni GitHub.
112. Configurare `.github/release.yml`, immutabilità delle release e workflow di draft con `release-manifest.json`, senza pubblicazione automatica.
113. Eseguire import iniziale degli ultimi 7 giorni con permessi automatici bloccati, senza documenti approvati o trasmissibili né upload Aruba pendenti.
114. Confrontare storico con Aruba e marcare già fatturati.
115. Eseguire il collaudo HF su Chromium/WebKit e dell'helper sintetico su Windows/macOS con Chrome o Edge, quindi compilare il record candidato di readiness 1.0 con prove fresche.
116. Eseguire l'audit trasversale della release candidate sul codice corrente, registrando soltanto findings attuali con prova, severità e stato.
117. Correggere tutti i P0/P1 alla causa condivisa, aggiungere i test minimi e aggiornare l'audit; accettare esplicitamente gli eventuali P2/P3 residui.
118. Eseguire il Canary Production su una sola fattura autorizzata tramite permesso monouso atomico, mantenere il kill switch globale disabilitato e registrarne la ricevuta completa.
119. Finalizzare il record di readiness dopo il canary.
120. Chiedere autorizzazioni separate prima del deploy, del singolo invio canary, della pubblicazione della GitHub Release e dell'uso Production ordinario.

---

## 25. Import storico e anti-duplicazione

### 25.1 Import iniziale

Al primo collegamento, proporre come default gli ultimi sette giorni calcolati rispetto all'attivazione del connettore, con possibilità di modificare la data prima dell'avvio.

Importare ordini creati o aggiornati nel periodo, inclusi annullamenti e rimborsi collegati.

### 25.2 Stato prudenziale

Poiché l'app precedente non ha scritto tag, note o numeri nelle piattaforme, gli ordini storici devono partire in:

`VERIFICA_FATTURAZIONE_PREGRESSA`

Non renderli approvabili finché non sono confrontati con l'elenco documenti Aruba.

### 25.3 Strategia di confronto

Dopo l'audit Aruba, usare i dati disponibili:

- riferimento ordine in descrizione/causale;
- data;
- cliente;
- totale;
- numero documento;
- eventuale metadata.

Se il matching non è univoco, richiedere conferma manuale. Non considerare il solo totale una prova.

---

## 26. Decisioni di routine affidate all'implementatore

Codex/Claude Code può decidere autonomamente:

- nomi tecnici definitivi;
- formattazione;
- dettagli dei componenti UI locali entro HTML semantico e CSS;
- forma delle query SQL parametrizzate entro `pg` e il solo livello dati;
- intervalli iniziali di polling entro limiti API;
- layout di dettaglio;
- messaggi d'errore;
- struttura delle cartelle.

Deve scegliere l'alternativa più semplice già supportata dalla matrice 14.3, senza sostituirne framework, ORM, runner, adapter o toolchain. Annotare in brevi ADR soltanto decisioni nuove difficili da invertire.

Deve fermarsi e chiedere prima di:

- deploy;
- release;
- invii Aruba reali;
- migrazioni distruttive;
- eliminazione dati;
- modifiche fiscali non deducibili dai materiali;
- scelte che cambiano materialmente il perimetro.

---

## 27. Rischi residui

| Rischio | Impatto | Mitigazione |
|---|---|---|
| DOM del pannello Aruba cambia senza preavviso | Helper bloccato o azione sul controllo sbagliato | Locatori semantici, allowlist, smoke sintetico, arresto fail-closed e fallback manuale completo |
| Sessione Aruba scaduta, 2FA o CAPTCHA | Intervento umano durante il batch | Profilo browser locale persistente, pausa esplicita e nessun tentativo di bypass |
| Differenze Chrome/Edge fra Windows e macOS | Flusso non universale | Un solo helper Playwright e matrice sintetica sui due sistemi operativi prima della release |
| Profilo fiscale non verificato | Documento errato | Audit Aruba + XML accettato + eventuale commercialista |
| Numerazione sconosciuta | Rischio fiscale grave | Nessuna numerazione reale prima dell'audit |
| Dati fiscali Shopify/eBay mancanti | Bozza incompleta | Fallback interno e correzione manuale |
| Accesso protected data Shopify | Import incompleto | Richiedere approvazione/scope minimi |
| Rimborso eBay ambiguo | Nota errata | Blocco manuale |
| Hostname gratuito Dynu | Dipendenza da servizio gratuito | `APP_BASE_URL` configurabile; dominio futuro |
| Singola VPS | Single point of failure | Backup giornaliero cifrato su OCI Object Storage, copia periodica sul Mac e runbook restore |
| Backup automatico non eseguito o bucket pieno | RPO reale peggiore di quello dichiarato | Timer, readback, allarme, lifecycle, soglia quota e prova restore |
| Perdita o guasto del Mac | Recovery kit e identità `age` locali indisponibili | FileVault e permessi stretti proteggono l'accesso ma non la perdita del dispositivo; il rischio residuo è accettato dal titolare |
| E-mail SMTP negozio o OCI Email Delivery | Deliverability, limiti o sender non accettato | PoC comparativo, un solo trasporto canonico, stato invio e reinvio manuale |
| Sender OCI o destinatario in suppression list | Copia cliente non consegnata | Dominio/SPF/DKIM e approved sender verificati, errore esplicito e controllo suppression nel PoC |
| Comparatore non allineato alla bozza approvata | L'utente vede una proiezione diversa dal documento trasmesso | Stesso generatore server-side, revisione/hash e rigenerazione atomica al submit |
| Brand Foundation cresce in un design system | Ritardo e manutenzione senza valore operativo | Un documento, un SVG canonico e soli asset richiesti; niente sito, webfont o libreria proprietaria |
| Stato upload/invio incerto | Doppio invio | Manifest/hash, ricerca nel pannello, confronto del file scaricato e nessun retry automatico |
| Canary lascia aperti gli invii | Trasmissione fiscale non autorizzata | Kill switch globale sempre `false` e permesso monouso atomico legato a batch/manifest/documenti/revisioni/hash |
| Target provider o VPS errato | Scrittura o deploy sull'ambiente sbagliato | Preflight con identità, account, risorsa e readback obbligatori |
| Documentazione o runbook in drift | Operazioni eseguite con istruzioni obsolete | Fonte canonica, controllo link/comandi e aggiornamento nella stessa PR |
| Backup presente ma non ripristinabile | Perdita dati prolungata | Checksum, manifest, restore drill trimestrale e prima dei cambi distruttivi |
| Dipendenza vulnerabile o non riproducibile | Compromissione o build divergenti | Pin, lockfile, audit, CI e aggiornamenti deliberati |
| Review Codex riferita a un commit precedente | Merge di codice non revisionato | Required check che accetta soltanto evidenze dell'HEAD esatto e torna pending a ogni nuovo commit |
| Log di diagnosi espongono dati fiscali | Violazione privacy | Eventi sanitizzati, debug solo Development con dati sintetici e retention breve |
| Repository pubblica espone dati, segreti o configurazioni | Compromissione e violazione privacy | Scansione albero+storia prima del primo push, rotazione, template, Push Protection e workflow fork senza secret |
| Key VPS adiacente al futuro repository | Accesso VPS esposto per commit accidentale | Ignorare il plaintext, archiviare soltanto la copia `age`, verificare equivalenza e bloccare chiavi private in staged tree/cronologia |
| Payload o risposta remota senza limite | Esaurimento memoria, parsing ostile o indisponibilità | Limiti prima del buffering, timeout, `413`, parser XML senza DTD/entità esterne e test mirati |
| Visibilità pubblica interpretata come licenza | Riuso non autorizzato o ambiguità legale | Nessun `LICENSE`, dichiarazione esplicita in README/CONTRIBUTING, decisione owner separata |
| Webhook/job resta `processing` dopo crash | Sincronizzazione bloccata o documento ignorato | Lease con scadenza, riacquisizione idempotente e test recovery |
| Due schede browser sovrascrivono una bozza | Perdita di correzioni o approvazione su dati vecchi | Revisione ottimistica, conflitto esplicito e rilettura dentro lock |
| Rollback applica down migration o altera lo storico | Corruzione o schema non riproducibile | Migrazioni append-only, expand/contract, forward-fix e restore solo per corruzione autorizzata |
| Conversazione non verificata | Contratti Shopify/eBay o struttura del pannello Aruba obsoleti/inesatti | Verifica documentazione ufficiale e ambiente corrente prima del codice finale |

---

## 28. Checklist di handover

### Sequenza operativa per il nuovo agente

1. Leggere integralmente questo documento, `AGENTS.md` e le istruzioni del repository.
2. Ispezionare lo stato reale del checkout senza sovrascrivere modifiche esistenti.
3. Avviare M0-M1 localmente con fixture e mock; non attendere Aruba.
4. Chiedere accessi solo nel momento in cui servono e far inserire nel secret store soltanto quelli gestiti da HF; l'accesso Aruba resta nel browser locale del titolare.
5. Completare M4 prima di qualunque prova reale o implementazione dell'helper Aruba.
6. Eseguire test, typecheck e build dopo ogni milestone.
7. Fermarsi per autorizzazione prima di deploy, release, invii reali o migrazioni distruttive.

Decisioni di naming, formattazione, struttura interna delle cartelle e dettagli d'implementazione entro la matrice 14.3 spettano all'implementatore. ORM, runner, builder XML, client SMTP, rappresentazione del denaro, logger, toolchain e immagini base non sono più scelte aperte. Se incontra due volte lo stesso problema, deve correggerne la causa condivisa e aggiungere il più piccolo test di regressione.

### Materiali che arriveranno dal titolare

- accesso Computer Use al pannello Aruba;
- computer Windows o macOS con Chrome o Edge per il collaudo dell'helper;
- XML e PDF di una fattura Aruba già accettata;
- se disponibile, XML/PDF di una nota di credito;
- accesso allo store Shopify e a un ordine reale con campo fiscale;
- credenziali eBay Sandbox e payload di esempio;
- dettagli SMTP dell'indirizzo del negozio;
- controllo del dominio e accesso DNS del mittente, necessari soltanto per il PoC OCI Email Delivery;
- accesso OCI, hostname Dynu e credenziali inseriti fuori dalla chat;
- eventuale conferma del commercialista sui soli valori fiscali non ricavabili dai documenti.

### Prima dello scaffolding

- [ ] Confermare `/Users/Matteo/Progetti/Hub-Fatture` come directory locale e decidere se inizializzare qui il repository o in una sottodirectory, senza cambiare il perimetro della key.
- [ ] Confermare che non esista codice precedente da preservare.
- [ ] Lasciare inizialmente `ssh-key-ampere-a1.key` al suo posto e invariata, aggiungere `*.key` a `.gitignore`, creare/verificare `ops/secrets/oci-vps-access.key.age` e confermare che soltanto il blob cifrato entri nell'indice.
- [ ] Risolvere Node.js, npm e Docker stabili per lo stack 14.3 su ARM64; fissare Node/npm esatti in `mise.toml`, `engines` e `packageManager`.
- [ ] Tradurre l'elenco dipendenze 14.3 nel manifest senza sostituzioni, generare il lockfile, verificare peer dependency e audit con `npm ci`.
- [ ] Verificare i digest ARM64 di Node, PostgreSQL e Caddy e installare `xmllint`; verificare il tool `age` fissato dagli artefatti prima di cifrare backup o key.
- [ ] Configurare Oxlint e Oxfmt come unica toolchain lint/formato e provarli nel comando canonico.
- [ ] Creare/verificare repository GitHub pubblica e `main` come unico branch permanente.
- [ ] Scansionare albero e intera cronologia prima del primo push pubblico; ruotare qualsiasi segreto già tracciato.
- [ ] Creare `AGENTS.md`, `CLAUDE.md` minimale, README, CONTRIBUTING, `SECURITY.md` e `docs/INDEX.md` coerenti.
- [ ] Pianificare la Brand Foundation leggera in M1 senza design system, sito o asset speculativi.
- [ ] Dichiarare repository pubblica ma non open source; non aggiungere `LICENSE` senza decisione esplicita.
- [ ] Configurare protezione `main`, template PR, vulnerabilità private, Dependabot e auto-merge delle sole patch dev dirette senza auto-approvazione; lasciare disabilitati Issues, Discussions e Projects rivolti alla community; adattare da CF Ready `codex-review` exact-HEAD e verificarlo su un nuovo commit.
- [ ] Configurare Playwright con Chromium, smoke sintetico e trace soltanto al primo retry fallito.
- [ ] Abilitare release immutabili e predisporre `.github/release.yml` senza pubblicare release.
- [ ] Raccogliere documentazione ufficiale corrente Shopify/eBay e guide del pannello Aruba.
- [ ] Non richiedere credenziali in chat.

### Prima di completare i connettori

- [ ] App Shopify custom creata.
- [ ] Versione GraphQL Shopify supportata, fine supporto e contract check fissati senza alias runtime `latest`.
- [ ] Scope e protected customer data approvati.
- [ ] Ordine Shopify reale con campo fiscale disponibile.
- [ ] Credenziali eBay Sandbox.
- [ ] Endpoint/versione eBay e deprecazioni applicabili registrati nel contratto.
- [ ] Ordine eBay di esempio con tax identifier.

### Prima di completare M4

- [ ] Audit autenticato read-only del pannello Aruba completato.
- [ ] XML fattura accettata analizzato.
- [ ] Profilo fiscale approvato.
- [ ] Sezionali e progressivi verificati.
- [ ] Procedura scarto verificata.
- [ ] Prova manuale controllata autorizzata con XML valido dedicato, riepilogo e controllo finale osservati, arrestata prima dell'ultimo clic e ripulita senza invio.

### Prima di completare M5

- [ ] M4 completata con XML candidato immutabile.
- [ ] Pagina Aruba sintetica e fixture dei file ufficiali derivate dalla prova, senza dati reali.
- [ ] Percorso assistito, automatico e manuale verificato; 2FA Aruba attivata dal titolare oppure costo operativo dell'SMS per upload esplicitamente accettato.

### Prima del deploy

- [ ] Autorizzazione esplicita del titolare.
- [ ] Test verdi.
- [ ] Nessun segreto plaintext nel repository; unico blob sensibile ammesso la key VPS cifrata e verificata in `ops/secrets/`.
- [ ] Commit, versione, account OCI e risorsa target identificati dal preflight.
- [ ] Stato GitHub e checkout locale coerenti; nessuna modifica concorrente sovrascritta.
- [ ] Immagine `linux/arm64` pubblicata su GHCR, attestazione verificata e digest registrato; nessuna build prevista sulla VPS.
- [ ] Immagine applicativa non-root e scansione vulnerabilità senza finding critici/alti raggiungibili aperti; Compose senza privilegi, DB non pubblicato e filesystem read-only salvo volumi espliciti.
- [ ] GitHub Environment `Production` limita il job a `main`/tag, richiede l'approvazione del titolare e non espone secret prima del gate.
- [ ] Firewall configurato.
- [ ] Dynu e TLS verificati.
- [ ] Backup recente verificato e rollback identificato.
- [ ] Restore collaudato da un ambiente privo dei segreti originari usando il recovery kit locale protetto sul Mac.
- [ ] Migrazioni provate su database effimero e ricevuta deploy pronta.
- [ ] Upgrade provato da snapshot rappresentativo della release Production precedente.
- [ ] Workflow manuale serializzato sullo SHA/tag candidato; stesso digest previsto per `web` e `worker`.
- [ ] Plugin OCI Compute Instance Monitoring attivo; topic, sottoscrizione e quattro allarmi iniziali collaudati.
- [ ] Monitor HTTP OCI esterno attivo ogni 6 minuti; fallimento e ripristino controllati notificati senza dati reali.
- [ ] Trasporto SMTP canonico deciso; se è OCI Email Delivery, regione, dominio, SPF/DKIM, approved sender, credenziali dedicate e suppression list sono verificati.
- [ ] Backup OCI giornaliero, Instance Principal minimo, lifecycle, soglia quota e allarme verificati; copia cifrata periodica presente sul Mac.

### Prima del Canary Production

- [ ] Import storico di 7 giorni riconciliato con Aruba.
- [ ] Nessun ordine storico approvabile senza verifica.
- [ ] Fattura sintetica validata sulla pagina locale e caricamento controllato sul pannello reale completato.
- [ ] Nota di credito sintetica validata sulla pagina locale e, se disponibile, sul pannello reale senza invio.
- [ ] Pagamento pendente e differenza importo testati.
- [ ] Comparatore fiscale verificato su fattura e TD04; modifica successiva e hash/revisione stale bloccano l'approvazione.
- [ ] E-mail test ricevuta.
- [ ] Upload/invio incerto, arresto fail-closed e riconciliazione prima di un nuovo tentativo testati.
- [ ] Limiti body/risposta, `413`, timeout e rifiuto di XML con DTD/entità esterne o struttura eccessiva testati sul candidato.
- [ ] Webhook/job stale riacquisiti dopo lease e readback Aruba fuori ordine riconciliati.
- [ ] Conflitto fra due schede browser e doppio submit verificati.
- [ ] Playwright verde per HF su Chromium/WebKit e per l'helper sintetico su Windows/macOS con Chrome o Edge; eventuali trace esaminate e nessun artefatto con dati reali conservato.
- [ ] Audit critici verificati atomici con le transizioni fiscali.
- [ ] Audit trasversale M8 completato sul commit candidato e collegato al record di readiness.
- [ ] Nessun P0/P1 aperto; eventuali P2/P3 accettati con condizione di riapertura.
- [ ] Retention fiscale e tecnica approvata.
- [ ] Record corrente `docs/runbooks/release-readiness.md` completo con prove fresche.
- [ ] Runbook P0, rollback e restore drill verificati.
- [ ] Candidato canary identificato da commit e digest, con `ARUBA_SUBMISSION_ENABLED=false` verificato e contratto del permesso monouso testato contro mismatch, scadenza, riuso e crash.

### Canary Production

- [ ] Una sola fattura reale controllata e di importo minimo ragionevole selezionata.
- [ ] Nessun altro documento approvato o upload Aruba pendente.
- [ ] Backup immediatamente precedente verificato.
- [ ] Autorizzazione esplicita limitata al singolo invio ottenuta.
- [ ] Permesso monouso creato per batch, manifest, documento, revisione e hash XML esatti, con `ARUBA_SUBMISSION_ENABLED=false` invariato.
- [ ] Permesso consumato atomicamente oppure scaduto/revocato; nessun permesso valido residuo anche in caso di errore.
- [ ] Aruba/SdI, PDF, e-mail, archiviazione, hash e audit riletti end-to-end.
- [ ] Ricevuta canary collegata al record di readiness.
- [ ] Nessun P0/P1 o stato remoto incerto irrisolto.

### Prima del go-live

- [ ] Il commit e il digest candidati non sono cambiati dopo il canary; altrimenti la prova interessata è stata ripetuta.
- [ ] Record di readiness finalizzato con esito canary e rischi residui.
- [ ] Draft GitHub Release collegata al tag candidato, note confrontate con `CHANGELOG.md` e `release-manifest.json` sanitizzato allegato.
- [ ] Immutabilità delle release confermata; nessun tag o asset pubblicato prima dell'autorizzazione.
- [ ] Autorizzazione esplicita alla release `v1.0.0`.
- [ ] Autorizzazione separata all'uso Production ordinario.

### Record di readiness 1.0

Prima del Canary Production creare `docs/runbooks/release-readiness.md` e finalizzarlo dopo il canary. Non duplica le checklist: è il record corrente e collega prove fresche per ogni gate bloccante, registrando almeno:

- commit, tag e versione candidati;
- stato delle decisioni `HF-O01`-`HF-O09`;
- profilo fiscale e hash delle fixture XML approvate;
- configurazioni e versioni API Shopify/eBay effettivamente verificate;
- finestre di supporto Shopify/eBay e data dell'ultima verifica periodica del pannello Aruba;
- risultati CI, migrazioni, contract test, E2E, security audit e smoke;
- matrice Playwright HF Chromium/WebKit e helper Windows/macOS con Chrome/Edge, trace degli eventuali retry e conferma dell'uso esclusivo di dati sintetici;
- audit trasversale della release candidate con commit revisionato, findings correnti e stato delle correzioni;
- ambiente/account/risorsa di ogni provider e relativo readback;
- backup OCI giornaliero e relativo RPO osservato, copia sul Mac, recovery kit verificato, restore drill, immagine di rollback e kill switch;
- digest GHCR, attestazione di provenienza, approvazione del GitHub Environment `Production` e digest precedente preservato;
- stato del plugin OCI, allarmi configurati e prova di consegna/risoluzione delle notifiche;
- stato del monitor HTTP esterno, cadenza, prova di fallimento/ripristino e quota APM verificata;
- trasporto SMTP scelto e prova di deliverability; se OCI, regione, dominio/sender, quota e stato suppression verificati;
- versione approvata della Brand Foundation e asset canonici effettivamente usati dalla UI;
- rischi non bloccanti accettati con condizione di riapertura;
- autorizzazioni distinte a deploy, release e primi invii Aruba reali;
- stato della protezione repository pubblica, scansione segreti/codice e canale vulnerabilità privata;
- stato `codex-review` riferito all'HEAD candidato, blob key `age` verificato e conferma che il plaintext non è mai entrato nell'indice o nella cronologia;
- baseline container non-root/senza privilegi e risultato della scansione dell'immagine candidata;
- ricevuta canary, permesso monouso consumato o scaduto senza residui validi, stato finale del kill switch e conferma che commit/digest non siano cambiati prima della release;
- draft GitHub Release, note verificate, manifest tecnico sanitizzato e stato dell'immutabilità.

Una checklist compilata senza link, hash, ID o risultati osservati non costituisce readiness.

---

## 29. Prompt operativo iniziale per Codex/Claude Code

```text
Stai implementando Hub Fatture 1.x. Leggi integralmente
"docs/Hub_Fatture_MASTER_PLAN.md" prima di agire e trattalo come
fonte di verità. Non iniziare da integrazioni reali o deploy.
La directory locale è `/Users/Matteo/Progetti/Hub-Fatture`.

Obiettivo della prima milestone:
1. creare il monolite TypeScript/Node.js con React e React Router scelti in 14.3 e versioni risolte negli artefatti M0;
2. aggiungere PostgreSQL, `pg`, SQL parametrizzato e Docker Compose locale con versioni e digest fissati nei file canonici M0;
3. aggiungere il runner compilato per migrazioni SQL append-only, autenticazione per un solo admin con `node:crypto`, sessioni PostgreSQL e OTPAuth;
4. definire la Brand Foundation leggera e i soli asset minimi approvati;
5. creare il modello minimo per ordini, clienti, Schede e audit;
6. importare fixture mock Shopify/eBay;
7. implementare trigger globale e raggruppamento giornaliero Europe/Rome;
8. lasciare un check eseguibile per ogni logica non banale.

Vincoli:
- la repository GitHub è pubblica ma non open source: non aggiungere `LICENSE` e non inserire dati reali, segreti plaintext o configurazioni sensibili nella storia Git; è ammesso soltanto il blob key `age` previsto;
- `ssh-key-ampere-a1.key` è una key user-owned per la VPS: durante M0 cifrala con `age` secondo §18.1 e versiona soltanto `ops/secrets/oci-vps-access.key.age`; non inserire mai il plaintext nella storia Git;
- non aggiungere microservizi, Redis, multi-tenancy, billing o un framework i18n multilingua; centralizza però il copy visibile nel catalogo italiano previsto dalla specifica;
- non sostituire la matrice 14.3 e non aggiungere Axios, librerie date/form/coda/UI, Jest, un secondo ORM o un secondo client SMTP;
- non trasformare la Brand Foundation in un design system, sito pubblico, webfont o catalogo di asset speculativi;
- non introdurre una libreria generica di diff XML: il comparatore futuro deve riusare i modelli strutturati e il generatore canonico;
- non configurare due trasporti SMTP Production o fallback automatici;
- non implementare numerazione fiscale reale;
- non presumere RegimeFiscale, sezionali o campi Aruba;
- non introdurre Web Services Premium, endpoint Aruba privati o automazione browser sulla VPS;
- non iniziare l'helper durante M0-M4: prima completare fondazioni, dominio ordini, connettori, documenti, approvazione e XML immutabile;
- implementare un solo helper Playwright locale per Windows/macOS con Chrome o Edge; login, 2FA e CAPTCHA restano umani e il percorso manuale resta sempre disponibile;
- non attendere l'audit Aruba per lavorare sulle fondazioni con mock;
- non usare dati o credenziali reali nei test;
- non fare deploy o invii reali senza autorizzazione;
- non trasformare il canary in un'abilitazione globale: usa soltanto il permesso monouso legato al batch, al manifest e ai documenti esatti;
- non sovrascrivere modifiche non tue;
- correggere le cause condivise, non i sintomi;
- usare la soluzione più semplice già offerta dallo stack.

Prima di modificare:
- ispeziona repository e istruzioni agentiche;
- proponi un piano breve;
- segnala eventuali divergenze materiali dalla specifica.

Alla fine:
- esegui typecheck, test e build;
- riporta file cambiati, verifiche, rischi e prossimo task;
- per ogni operazione remota, registra target, ID, readback e rollback senza esporre segreti.
```

---

## 30. Registro delle decisioni rinviate

Questi punti non sono dimenticanze. Sono sospesi intenzionalmente perché dipendono da dati reali, provider o approvazioni esterne. **Non resta aperta alcuna scelta di tool o dipendenza:** HF-O03 decide soltanto se installare il fallback PDFKit già selezionato; HF-O07 sceglie il provider SMTP, mentre l'adapter applicativo resta Nodemailer.

| ID | Decisione aperta | Blocca | Fonte necessaria | Condizione di chiusura |
|---|---|---|---|---|
| HF-O01 | `RegimeFiscale` esatto del cedente | profilo fiscale Production | XML Aruba accettato e/o commercialista | valore registrato nel profilo versionato e golden test verde |
| HF-O02 | Numerazione, sezionali, cambio anno e gestione scarti | numerazione e invii reali | audit Aruba, documenti reali e conferma fiscale | procedura atomica e casi di scarto approvati |
| HF-O03 | PDF ufficiale Aruba o attivazione del fallback PDFKit già selezionato | copia cliente definitiva | download dal pannello Aruba reale | readback PDF verificato o fallback PDFKit approvato |
| HF-O04 | Mapping campi fiscali Shopify | connettore Shopify completo | query su ordine reale e API corrente | contract fixture anonimizzata e mapper testato |
| HF-O05 | Forma tax identifier e importi rimborso eBay | connettore eBay completo e TD04 | payload Sandbox/reali e API corrente | fixture, mapper e casi ambigui verificati |
| HF-O06 | Locatori, pause di autenticazione, limiti, download e stati del pannello Aruba | M5 e Production | audit autenticato, prova controllata e guide correnti | helper sui due sistemi operativi, mapping, fallback manuale e recovery da stato incerto verificati |
| HF-O07 | Trasporto e limiti SMTP | invio copia cliente | provider e-mail esistente e PoC OCI Email Delivery | un solo trasporto canonico scelto; consegna, errore, suppression e reinvio verificati senza segreti o dati cliente nei log |
| HF-O08 | Retention fiscale e tecnica definitiva | go-live | commercialista, obblighi applicabili e capacità storage | durate, eccezioni e procedura di cancellazione approvate |
| HF-O09 | Direzione visiva della Brand Foundation leggera | UI definitiva | due o tre proposte minime coerenti con uso privato e accessibilità | il titolare approva `docs/brand/brand-foundation.md`, SVG canonico e asset richiesti senza ampliare il perimetro |

Qualsiasi altra scelta di routine entro i confini della matrice 14.3 è affidata all'implementatore e non richiede una nuova fase di analisi.

---

## 31. Definition of Done della 1.0

Hub Fatture 1.0 è concluso soltanto quando:

1. tutti i requisiti `HF-F01`-`HF-F32` sono implementati o esplicitamente riclassificati dal titolare;
2. M4-M5 sono completate con evidenze correnti e ogni azione remota ha la relativa autorizzazione registrata;
3. profilo fiscale, numerazione, XML fattura e TD04 derivano da fonti approvate e golden test;
4. import, raggruppamento, modifiche, comparatore fiscale, approvazione, helper assistito/automatico, fallback manuale, stati SdI, e-mail e note di credito superano l'E2E applicabile;
5. idempotenza, concorrenza, upload/invio incerto, permesso Aruba monouso e recovery hanno test riproducibili;
6. nessun dato o segreto plaintext compare in repository, CI, log, fixture o documentazione; la key VPS è archiviata soltanto come blob `age` verificato e il plaintext resta fuori da indice e cronologia;
7. CI riproduce documentazione, lint, typecheck, test, migrazioni e build sull'ambiente dichiarato;
8. dipendenze, lockfile, migrazioni e documentazione descrivono lo stesso stato;
9. backup OCI giornaliero cifrato, copia periodica sul Mac, recovery kit locale protetto, restore drill senza i segreti della VPS originaria e rollback applicativo sono verificati; timer, readback, lifecycle e allarme dimostrano l'RPO reale;
10. preflight, ricevuta, readback e rollback identificano ogni deploy remoto;
11. sicurezza, TOTP, firewall, TLS, webhook, token helper, allowlist, limiti body/risposta, timeout, parser XML senza DTD/entità esterne e retention sono verificati;
12. `AGENTS.md`, README, indice, glossario, Brand Foundation, asset canonici, contratti, evidenze e runbook sono aggiornati senza fonti duplicate;
13. il record corrente `docs/runbooks/release-readiness.md` collega prove fresche e rischi accettati;
14. non restano rischi P0/P1, decisioni bloccanti aperte o ordini storici approvabili senza riconciliazione;
15. il titolare autorizza separatamente deploy Production, singolo invio canary, release `v1.0.0` e uso Production ordinario;
16. commit/tag, artefatto distribuito e stato live coincidono dopo smoke live autenticato e readback provider;
17. la repository pubblica ha `main` protetto, `codex-review` required sull'HEAD esatto, workflow da fork senza segreti o esecuzione privilegiata di codice PR, scansioni di sicurezza attive, canale vulnerabilità privato e nessun `LICENSE` non approvato;
18. installazione vuota e upgrade dallo snapshot della release precedente superano migrazioni e invarianti senza modificare la cronologia applicata;
19. webhook/job stale, doppio submit, conflitti di revisione e readback Aruba fuori ordine sono recuperabili e coperti da test;
20. ogni transizione fiscale critica ha audit atomico e ogni stato provider mostrato deriva da conferma/readback o da un'esplicita condizione incerta;
21. il Canary Production su una sola fattura reale ha chiuso l'intera catena tramite l'helper e un permesso monouso consumato atomicamente, senza abilitare globalmente gli invii, senza P0/P1 o stati incerti; la ricevuta è nel record di readiness e `v1.0.0` usa lo stesso commit e digest verificati;
22. l'audit trasversale M8 è stato eseguito sul candidato corrente, contiene soltanto findings ancora pertinenti e non lascia P0/P1 aperti;
23. `react-doctor` è fissato a versione esatta, la scansione completa passa nel check locale/CI bloccante e l'Action ufficiale advisory è fissata a commit completo senza determinare l'esito del gate;
24. l'immagine `linux/arm64` candidata è costruita una volta, pubblicata su GHCR, attestata, scansionata e distribuita per digest; esegue non-root in una baseline Compose senza privilegi e `web`, `worker`, ricevuta e rollback fanno riferimento all'artefatto esatto;
25. il GitHub Environment `Production` limita le sorgenti ammesse, protegge i secret e richiede l'approvazione manuale del titolare senza introdurre un terzo ambiente applicativo;
26. OCI Monitoring e Notifications hanno plugin, topic e quattro allarmi iniziali collaudati, con soglie documentate e nessun servizio a pagamento attivato;
27. `mise.toml`, manifest e lockfile fissano la toolchain risolta in M0 secondo 14.3, i tipi sono allineati al runtime e la stessa toolchain è osservata sul Mac, in CI e nella build Docker;
28. Oxlint e Oxfmt sono le sole toolchain lint/formato, hanno versioni esatte e passano `lint`/`format:check` senza mantenere ESLint o Prettier paralleli;
29. la GitHub Release `v1.0.0` è pubblicata soltanto dopo autorizzazione, è immutabile e collega note verificate e manifest sanitizzato allo stesso commit, digest, schema e rollback superati dal canary;
30. Dependabot auto-unisce soltanto patch delle dev dependency dirette sulla stessa head verificata, senza auto-approvazione, checkout o esecuzione del codice PR nel contesto privilegiato; la prova end-to-end è osservata sulla prima patch reale idonea o su una base temporanea equivalente coperta dagli stessi gate e poi rimossa, senza alterare i pin di `main` e comunque prima della release Production;
31. il monitor HTTP OCI osserva dall'esterno Dynu, DNS, TLS, Caddy e `/health` ogni 6 minuti, notifica dopo due fallimenti consecutivi e non espone dati o dettagli interni;
32. Playwright copre i quattro flussi HF sintetici sulle PR in Chromium, li completa in M8 su Chromium/WebKit e verifica l'helper contro la pagina Aruba sintetica su Windows/macOS con Chrome o Edge, conservando trace solo al primo retry e mai sul Canary Production;
33. il comparatore fiscale deriva server-side dallo stesso generatore della trasmissione, mostra differenze strutturate per fattura e TD04 e impedisce l'approvazione quando revisione o hash sono stale;
34. la Brand Foundation leggera approvata è la fonte unica per icona, favicon, palette minima, tipografia e tono, senza design system, sito o asset speculativi;
35. il PoC OCI Email Delivery è documentato e Production usa un solo trasporto SMTP canonico; se è OCI, dominio, SPF/DKIM, approved sender, regione, quota, suppression, consegna e reinvio sono verificati;
36. manifest e lockfile rispettano la matrice 14.3 e sono la fonte canonica dei pin dopo lo scaffolding; `npm ci` risolve peer dependency e audit, le immagini fissate supportano `linux/arm64` e non sono stati introdotti tool equivalenti o dipendenze sostituibili dalle scelte native registrate;
37. versioni API e finestre di supporto Shopify/eBay e verifica periodica del pannello Aruba sono correnti e collegate ai contract test dei connettori e dell'helper;
38. l'helper non gira sulla VPS, non usa endpoint Aruba privati, non acquisisce credenziali/cookie/OTP e si arresta su host, account, DOM, batch o permesso inattesi; il fallback manuale resta documentato e collaudato.

Una checklist compilata senza risultati osservati, ID o link alle evidenze non costituisce completamento.

---

## 32. Conclusione

Hub Fatture 1.x deve restare un'applicazione piccola, affidabile e comprensibile: importa ordini, crea Schede giornaliere, confronta sorgente, bozza e proiezione XML, produce documenti semplificati nel profilo del margine, richiede sempre l'approvazione e usa il pannello Aruba Base tramite un helper locale presidiato per trasmissione, esiti e conservazione.

La priorità non è costruire un motore fiscale generale, ma impedire errori operativi: dati mancanti, doppie fatture, doppi rimborsi, numerazione errata, invii non approvati e perdita di tracciabilità.

Il primo lavoro concreto segue M1 e le milestone successive in ordine. La pagina Aruba sintetica e l'helper nascono soltanto in M5, dopo che M4 ha qualificato profilo fiscale, numerazione e XML tramite pannello read-only, documento già accettato dallo SdI e prova manuale controllata arrestata prima dell'invio. Nessuna integrazione Aruba procede su una roadmap parallela.
