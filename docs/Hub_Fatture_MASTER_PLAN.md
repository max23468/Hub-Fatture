# Hub Fatture 1.x

## Piano completo di prodotto, architettura, implementazione e handover

**Stato:** specifica funzionale e operativa consolidata; sequenza e criteri di uscita sono definiti nella roadmap
**Destinatari:** Codex, Claude Code e sviluppatori incaricati
**Lingua dell'interfaccia:** italiano
**Sigla interna:** HF, riservata a requisiti e discussione tecnica; non appare mai nel frontend o nei contenuti destinati all’utente
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
- M4 comprende audit autenticato read-only, analisi dell'XML accettato, profilo fiscale, numerazione, generatore definitivo e approvazione.
- M5 comprende l'integrazione locale dell'helper e si chiude con pagina sintetica, contratto candidato, fallback manuale e controlli fail-closed verificati. La prova manuale controllata del candidato XML sul pannello reale è differita a M8: l'indisponibilità temporanea dell'accesso presidiato non blocca M5-M7, ma blocca il completamento di M8, l'avvio di M9 e qualunque invio reale.
- Modifiche all'account Aruba, upload reali e invii richiedono sempre
  l'autorizzazione specifica del titolare nel momento in cui vengono eseguiti.
  Una richiesta affermativa di pubblicazione autorizza invece deploy e release
  tecniche applicabili; fuori da tale richiesta serve conferma separata. Questi
  consensi proteggono azioni remote, ma non costituiscono una roadmap parallela.

### 0.5 Governo e ciclo di vita della documentazione

La documentazione non ha versioni proprie: la cronologia Git è lo storico. Ogni documento descrive lo stato corrente e, quando diventa superato, viene aggiornato o rimosso invece di essere duplicato con un nuovo suffisso.

Date, branch, conteggi dei test e nomi delle milestone non vengono copiati in README, runbook, contratti, copy applicativo, nomi dei test, workflow o immagini Docker. Queste superfici descrivono capacità e gate osservabili; lo stato corrente deriva dal codice, dai manifest e dalla CI dell’HEAD esatto. Le sigle delle milestone restano soltanto nella roadmap e nei punti che esprimono una dipendenza di delivery. Timestamp e identificatori remoti sono ammessi nelle evidenze immutabili di operazioni esterne, dove costituiscono parte della prova e non richiedono aggiornamenti successivi.

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

- ambiente, commit/versione e target esatto; timestamp soltanto per operazioni esterne o quando è parte della prova;
- preflight e identità provider verificati;
- risultato osservato e matrice dei casi eseguiti;
- gate locali/CI collegati;
- ID remoto, readback e rollback quando esiste una scrittura remota;
- limiti non osservabili, rischio residuo e condizione di chiusura.

I log grezzi restano fuori dal repository quando contengono identificativi, configurazioni o dati fiscali. L'evidenza conserva solo estratti sanitizzati e gli identificatori tecnici strettamente necessari.

---

## 1. Sintesi esecutiva

Hub Fatture 1.x è un'applicazione web privata e single-tenant per l'attività del titolare. Importa ordini da un solo negozio Shopify e da un solo account venditore eBay, genera bozze di fatture elettroniche semplificate nel regime del margine e richiede sempre un'approvazione esplicita. Un helper locale multipiattaforma carica quindi l'XML nel pannello web di Aruba Fatturazione Elettronica usando Chrome o Edge, legge la validazione e, in base all'impostazione scelta, si ferma prima dell'ultimo clic oppure completa l'invio quando l'uso Production ordinario è abilitato e il manifest coincide con i documenti esatti. L'account Aruba corrente non usa la 2FA e non richiede autorizzazione SMS per ogni upload; login, password ed eventuali challenge di sicurezza inattese restano sempre passaggi umani. Stati, notifiche Aruba e risultati SdI vengono riconciliati dal pannello e dai file ufficiali scaricati.

L'app non è un gestionale fiscale completo e non deve sostituire la contabilità Aruba. Il suo compito è automatizzare la raccolta degli ordini, applicare un profilo fiscale preconfigurato e verificato, preparare il documento, consentire correzioni controllate, raccogliere l'approvazione e orchestrare la trasmissione.

Il prodotto sarà:

- usato soltanto dal titolare e dall'agente Codex, tramite i due account amministrativi fissi `Massimo` e `Codex`;
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

Nessuna fattura o nota di credito viene mai trasmessa senza un'approvazione esplicita. In modalità `Assistita` il titolare esegue personalmente l'ultimo clic nel pannello Aruba; in modalità `Automatica dopo conferma` l'helper può eseguirlo soltanto quando l'uso Production ordinario è abilitato e il batch approvato coincide con manifest, revisioni e hash XML esatti. Anche l'azione in blocco deve essere esplicita.

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

`importazione -> preparazione fattura -> bozza -> comparatore fiscale -> controlli -> approvazione -> helper locale -> validazione/upload Aruba -> invio autorizzato -> stato SdI -> copia leggibile -> archiviazione`

e quando un rimborso di prova produce correttamente:

`rimborso completato -> bozza TD04 cumulativa -> approvazione -> trasmissione -> collegamento alla fattura originaria`.

### 2.3 Requisiti funzionali tracciabili

| ID | Requisito | Stato |
|---|---|---|
| HF-F01 | Importare subito ordini e aggiornamenti da Shopify ed eBay | Confermato |
| HF-F02 | Generare la bozza al pagamento oppure all'evasione completa, secondo un'impostazione globale unica | Confermato |
| HF-F03 | Permettere la generazione manuale anticipata di una bozza | Confermato |
| HF-F04 | Creare automaticamente raggruppamenti giornalieri per cliente usando la data ordine in `Europe/Rome` | Confermato |
| HF-F05 | Evitare l'accorpamento automatico quando l'identità del cliente è ambigua | Confermato |
| HF-F06 | Produrre una riga semplificata per ordine con spedizione e sconti assorbiti; sottrarre per default solo la fee effettiva Shopify Payments, secondo un'impostazione globale modificabile | Confermato |
| HF-F07 | Conservare il dettaglio sorgente per riconciliazione senza riprodurlo 1:1 nel documento | Confermato |
| HF-F08 | Permettere modifiche a cliente, descrizioni, quantità, importi, pagamenti, causali e ordini inclusi fino all'approvazione | Confermato |
| HF-F09 | Consentire differenze rispetto al totale sorgente solo con avviso, seconda conferma e motivazione obbligatoria | Confermato |
| HF-F10 | Richiedere sempre approvazione esplicita prima di numerare e preparare l'invio, anche quando l'ultimo clic è delegato all'helper | Confermato |
| HF-F11 | Consentire approvazione massiva soltanto per preparazioni prive di eccezioni | Confermato |
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
| HF-F26 | Mantenere l'interfaccia solo in italiano, centralizzando il testo visibile in un catalogo italiano semplice | Confermato |
| HF-F27 | Bloccare centralmente l'invio automatico Aruba tramite kill switch Production senza impedire consultazione, export, upload manuale, import o diagnosi | Default tecnico di sicurezza |
| HF-F28 | Mostrare un comparatore fiscale strutturato fra snapshot sorgente, bozza corrente e proiezione XML prima di ogni approvazione | Confermato |
| HF-F29 | Definire una Brand Foundation leggera e versionata per nome, icona, favicon, palette minima, tipografia di sistema e tono UI | Confermato |
| HF-F30 | Valutare OCI Email Delivery in Development e selezionare un solo trasporto SMTP canonico prima dell'uso Production | Confermato come PoC; adozione OCI condizionata |
| HF-F31 | Eseguire la sincronizzazione dell’inventario Aruba tramite un preferito del browser in Safari, Chrome o Edge su computer, senza installer, runtime o credenziali persistenti | Confermato |
| HF-F32 | Offrire in Impostazioni le modalità `Assistita` e `Automatica dopo conferma`, con `Assistita` come default | Confermato |
| HF-F33 | Inventariare dall'account Aruba fatture e TD04 anche quando non sono stati generati da HF, con prima scansione dell'anno fiscale corrente estesa agli ordini ancora riconciliabili e ai documenti precedenti non terminali, poi aggiornamenti incrementali | Confermato |
| HF-F34 | Collegare automaticamente un documento Aruba a ordini e documenti locali soltanto con corrispondenza univoca e XML ufficiale coerente; lasciare ambiguità, conflitti e documenti privi di ordine nelle code di verifica | Confermato |
| HF-F35 | Per le fatture TD01, trattare la sincronizzazione dell'inventario Aruba come processo parallelo gestito da Dashboard e Impostazioni: la preparazione mostra soltanto lo stato globale, avvisa dopo un'ora e blocca approvazione e numerazione quando Aruba non è mai stato letto, il readback ha più di 24 ore o esiste uno stato remoto incerto | Confermato |
| HF-F36 | Eseguire al primo avvio del preferito una scansione completa della finestra Aruba rilevante e usare agli avvii successivi un intervallo incrementale con sovrapposizione; un nuovo stream, un cursore assente o un'incongruenza rendono nuovamente obbligatoria la scansione completa | Confermato |
| HF-F37 | Aggiornare gli stati Aruba/SdI in modo monotono e conservare osservazioni append-only senza creare submission fittizie per documenti nati fuori da HF | Confermato |

`HF-F25`, propagazione delle correzioni cliente verso Shopify, è stata riclassificata come evoluzione futura in 3.3: era disattivata di default, non serve a emettere un documento e obbligherebbe a chiedere scope di scrittura Shopify. L'identificativo resta libero e non viene riusato.

---

## 3. Perimetro confermato

### 3.1 Compreso nella 1.x

- Un solo store Shopify.
- Un solo account venditore eBay.
- Un solo account Aruba.
- Account Aruba Base; nessuna dipendenza dai Web Services Premium.
- Due account amministrativi fissi, `Massimo` e `Codex`, con login case-insensitive e identità canoniche di audit distinte; le sole transizioni fiscali irreversibili restano riservate a `Massimo`.
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
- Inventario in sola lettura di fatture e TD04 presenti in Aruba, inclusi i documenti nati fuori da HF, con riconciliazione continuativa e coda `Documenti → Da collegare`.
- I documenti nati fuori da Shopify ed eBay restano soltanto nell’inventario Aruba per prevenire doppie emissioni: se non presentano né un riferimento ordine esplicito né un match locale compatibile non diventano ordini, fatture da gestire o verifiche bloccanti.
- Preferito `Sincronizza Aruba` per Safari, Chrome o Edge su computer, configurato una volta e avviato esplicitamente dall'utente nella pagina Aruba.
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
- preparazioni create senza un ordine Shopify/eBay.
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
- Helper di caricamento e trasmissione su Safari; questo componente usa Chrome o Edge, mentre il preferito di sola lettura supporta anche Safari.
- Alta disponibilità, cluster, microservizi, Redis e Kubernetes.
- Retrocompatibilità o implementazioni legacy non necessarie.

### 3.3 Possibili evoluzioni, non da predisporre ora

- Dominio proprietario.
- Replica dei backup su un secondo provider indipendente da OCI.
- Più utenti e ruoli.
- Altri marketplace o vendite manuali.
- Multi-valuta.
- Propagazione delle correzioni anagrafiche verso Shopify, già HF-F25.
- Profili fiscali multipli.
- OSS o altri regimi, solo su nuova specifica fiscale.
- Localizzazione dell'interfaccia.

Non creare astrazioni speculative per queste evoluzioni. Il codice deve essere modulare nei confini reali - connettori, generatore XML, storage - ma non generalizzato in anticipo.

---

## 4. Decisioni consolidate e motivazioni

| Area | Decisione | Motivazione |
|---|---|---|
| Modello operativo | Pannello web autonomo | Shopify, eBay e Aruba hanno pari importanza; l'app non deve dipendere dall'Admin Shopify |
| Utenza | Due account amministrativi fissi, `Massimo` e `Codex`, con login case-insensitive; approvazione e numerazione riservate a `Massimo` | È un'app privata e non servono ruoli, registrazione o onboarding; l'unico privilegio distinto è quello che rende irreversibile un documento fiscale |
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
| Sincronizzazione Aruba | Preferito JavaScript per Safari, Chrome o Edge e ponte autenticato temporaneo in HF | La sessione Aruba resta nel browser dell'utente e l'uso ordinario non richiede installer, runtime, Terminale, estensioni o codici da copiare |
| Inventario Aruba | Cache provider-first dei documenti presenti nell'account, indipendente dai batch HF; prima scansione dell'anno fiscale corrente e sincronizzazione incrementale locale | Rileva fatture create direttamente in Aruba, impedisce doppie emissioni e rende osservabile la freschezza reale del readback |
| Modalità helper | `Assistita` di default e `Automatica dopo conferma` opzionale | Consente di scegliere il livello di automazione senza rimuovere l'approvazione esplicita |
| Comparatore fiscale | Diff strutturato server-side fra sorgente, bozza e proiezione XML | Rende visibili trasformazioni, correzioni e arrotondamenti senza affidarsi a un fragile confronto testuale dell'XML |
| Versionamento | `package.json` + SemVer/tag per le release Production | Collega codice e artefatto senza imporre bump alle modifiche locali o documentali |
| Pubblicazione release | GitHub Release immutabile con note generate e manifest tecnico | Rende leggibile e non riscrivibile il legame fra versione, commit, immagine, schema e rollback |
| Aggiornamenti automatici | Auto-merge soltanto per patch delle dev dependency dirette | Riduce manutenzione ordinaria senza modificare automaticamente runtime, provider, workflow o Production |
| Versioni dipendenze | La matrice 14.3 fissa le scelte; manifest, lockfile, `mise.toml` e digest fissano le versioni | Evita pin duplicati nel piano e impone una sola risoluzione verificata prima del codice |
| Backend | Monolite TypeScript/Node.js secondo lo stack 14.3 | Volume ridotto e integrazioni più semplici in un solo deploy |
| Frontend | React con React Router in modalità framework secondo lo stack 14.3 | Pannello autonomo full-stack nello stack TypeScript, senza dipendere dall'Admin Shopify |
| Analisi React | React Doctor stabile con scansione completa bloccante nel gate locale e sul push runtime a `main`, più Action ufficiale bloccante dai warning sulle modifiche React delle PR | Conserva diagnosi React complete e feedback inline con la stessa soglia bloccante in locale e su GitHub senza analizzare PR estranee a React |
| Identità visiva | Brand Foundation leggera, versionata prima della UI definitiva | Evita decisioni visive sparse senza introdurre un design system o un sito non necessari |
| Database | PostgreSQL locale, driver `pg` e SQL versionato secondo 14.3 | Transazioni, vincoli, audit e code senza ORM o migration CLI aggiuntive |
| Coda | Basata su PostgreSQL | Evita Redis e un servizio aggiuntivo; carico di poche centinaia di ordini al mese |
| Storage documenti | Filesystem persistente VPS + metadati DB | XML/PDF/notifiche consultabili senza dipendere da Aruba |
| Dominio funzionale | `billing_case` interno, esposto come "Preparazione fattura" | Il contenitore tecnico non è una destinazione di navigazione |
| Generazione | Impostazione globale: pagamento o evasione completa | Un solo comportamento coerente per Shopify ed eBay |
| Approvazione | Sempre esplicita | Nessun invio fiscale senza una conferma riferita ai documenti esatti |
| Primo invio Aruba | Nessuna corsia o autorizzazione monouso distinta: avviene soltanto dopo l'abilitazione separata dell'uso Production ordinario | Il canary tecnico non invia documenti e il kill switch resta l'unica abilitazione persistente; manifest e validazione confinano ogni batch |
| Fattura | Una riga semplificata per ordine | Non serve replicare il dettaglio commerciale delle piattaforme |
| Sconti/spedizione | Assorbiti nell'importo netto della riga ordine | Il documento deve restare semplice; il dettaglio resta interno |
| Commissioni Shopify Payments | Regola globale modificabile: per default sottrarre dal totale fatturabile esclusivamente le commissioni effettive restituite da `OrderTransaction.fees` per transazioni `shopify_payments` riuscite, convertite nella valuta negozio soltanto tramite il tasso di regolamento tipizzato della stessa transazione | Allinea il documento al comportamento Aruba osservato senza ricostruire percentuali o cambi esterni e senza applicare costi di altri gateway; PayPal, bonifico, PostePay, metodi manuali ed eBay restano sempre al totale pieno |
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
| Propagazione delle correzioni cliente verso Shopify | Rinviata alle evoluzioni | Disattivata di default, estranea all'emissione del documento e richiederebbe scope di scrittura Shopify |
| Fattura 1:1 con prodotti, sconti e spedizione | Superata | Scelta una riga netta e semplice per ordine |
| Una fattura per ogni ordine | Superata | Scelto accorpamento automatico giornaliero per cliente |
| Termini "Pratica" e "Scheda" | Superati | L'interfaccia usa "Preparazione fattura" nel contesto degli ordini |
| Nessun backup | Evoluto | Scelto backup automatico cifrato su OCI Object Storage con seconda copia periodica sul Mac |

---

## 5. Terminologia e modello concettuale

### 5.1 Raggruppamento di fatturazione interno

Il **raggruppamento di fatturazione interno** è il contenitore tecnico del ciclo documentale. Nell'interfaccia non costituisce una sezione autonoma: si apre dagli ordini come **Preparazione fattura** e, dopo l'approvazione, il risultato vive in **Documenti**. Collega:

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
Preparazione fattura 000154
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

Nel codice usare il nome tecnico diretto e stabile `billing_case`. Non esporre all'utente i termini tecnici, "Scheda" o "Pratica". Evitare gerarchie astratte non necessarie.

Il numero pubblico della preparazione è un progressivo interno non fiscale, senza sigla né prefisso: `HF` resta interna e non compare in nessun identificativo visibile, in nessuna schermata e in nessun documento destinato all'utente.

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

Raggruppamento interno (`billing_case`):

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

- Preparazione fattura e il suo equivalente tecnico interno `billing_case`;
- bozza, approvazione, numerazione, trasmissione, consegna e scarto;
- fattura, nota di credito e rimborso;
- totale ordine, commissione Shopify Payments, totale fatturabile, totale documento e differenza;
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
- prepara batch e manifest immutabili;
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
5. Normalizza cliente, indirizzi, identificativi fiscali, righe, totale, sconti, spedizione, pagamento, commissione effettiva Shopify Payments e stato di evasione.
6. Verifica la valuta: solo EUR è ammessa; altro valore porta a errore bloccante.
7. Valuta il trigger globale:
   - ordine interamente pagato; oppure
   - ordine completamente evaso/spedito.
8. Se non idoneo, imposta `WAITING_FOR_TRIGGER`.
9. Se annullato prima del trigger, conserva l'ordine come `CANCELLED_NO_DOCUMENT`.
10. Se idoneo, cerca o crea il raggruppamento giornaliero compatibile.

La piattaforma resta fonte del dato originario. Una risincronizzazione non deve sovrascrivere modifiche manuali della bozza: registra la differenza e richiede revisione quando è rilevante.

Per i dati anagrafici mantenere tre forme distinte: snapshot sorgente immutabile, profilo canonico per matching e anti-duplicazione, forma di presentazione per interfaccia e documenti. La forma di presentazione uniforma Unicode e spazi, e-mail, codici Paese/provincia e identificativi; applica maiuscole leggibili a nomi personali, città e indirizzi italiani riconoscibili soltanto quando il risultato è ad alta confidenza. Ragioni sociali, parole già in casing misto e parti ambigue restano invariate. La correzione manuale prevale e le preparazioni già create non vengono riscritte.

Dati fiscali o anagrafici mancanti non impediscono la creazione della bozza interna: la preparazione nasce in `NEEDS_REVIEW` e resta non approvabile finché i campi obbligatori non sono completati.

### 7.2 Trigger globale di generazione

Impostazione unica per Shopify ed eBay:

- **Alla conferma del pagamento**: la bozza nasce quando l'ordine è interamente pagato.
- **Alla completa evasione/spedizione**: la bozza nasce solo all'evasione completa; spedizioni parziali non bastano.

L'ordine viene comunque importato subito. Il cambio dell'impostazione:

- non ricrea, non scioglie e non riapre una bozza esistente;
- rivaluta gli ordini ancora senza bozza;
- si applica operativamente agli ordini idonei non ancora raggruppati, che confluiscono nella bozza aperta del proprio cliente e giorno secondo 7.3: la bozza acquisisce l'ordine e le anomalie che l'ordine porta con sé, senza che il cambio di impostazione alteri da solo i dati già raggruppati;
- lascia disponibile la generazione manuale anticipata per un singolo ordine.

### 7.3 Identità cliente e raggruppamento

L'app crea automaticamente un raggruppamento cumulativo per ordini compatibili dello stesso cliente e della stessa data ordine nel fuso `Europe/Rome`.

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

L'e-mail da sola non basta. Nei casi ambigui non accorpare: creare raggruppamenti separati e mostrare una possibile corrispondenza.

Ordini Shopify ed eBay possono confluire nello stesso raggruppamento. Se una preparazione è già approvata e arriva un altro ordine dello stesso giorno, crearne una nuova senza modificare quella emessa.

### 7.4 Bozza di fattura semplificata

La fattura non replica prodotti, coupon o spedizione 1:1.

Per ciascun ordine incluso creare una riga:

```text
Vendita beni usati - Ordine Shopify #1234     120,00 EUR
Vendita beni usati - Ordine eBay #5678         75,00 EUR
```

Regole:

- quantità predefinita `1`;
- importo pari al totale fatturabile dell'ordine;
- sconti già assorbiti;
- spedizione inclusa;
- per una transazione Shopify Payments riuscita, commissione effettiva sottratta solo quando la relativa impostazione globale è `Sottrai`; la modalità predefinita è `Sottrai`;
- PayPal, bonifico, PostePay, gateway manuali, altri metodi Shopify ed eBay restano sempre al totale ordine pieno;
- nessuna percentuale o quota fissa viene ricalcolata: l'unica fonte ammessa è l'importo `fees.amount` restituito da Shopify;
- Natura e diciture secondo il profilo Aruba verificato;
- totale documento uguale alla somma delle righe, salvo modifica manuale esplicitamente confermata.

Internamente conservare il dettaglio di prodotti, sconti, spedizione, pagamenti, commissioni Shopify Payments e rimborsi per riconciliazione e note di credito. Conservare separatamente totale ordine, commissione osservata, commissione sottratta e totale fatturabile. Il cambio dell'impostazione ricalcola soltanto ordini e bozze ancora modificabili; documenti approvati e riconciliazioni storiche già chiuse restano immutabili.

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

Se il totale differisce dal totale fatturabile canonico degli ordini:

- mostra totale ordine, commissioni Shopify Payments sottratte, totale fatturabile, totale documento e differenza;
- escludi la preparazione dall'approvazione massiva standard;
- richiedi seconda conferma;
- rendi obbligatoria una motivazione;
- registra l'eccezione nell'audit.

### 7.6 Approvazione e trasmissione

Flusso normale:

1. Controlli bloccanti locali.
2. Anteprima del documento.
3. Proiezione XML e validazione XSD locale.
4. Conferma esplicita: **"Approva fattura"**. Il riepilogo chiarisce che l'approvazione assegna automaticamente il prossimo numero disponibile e genera l'XML definitivo.
5. Assegnazione atomica di numero e data secondo configurazione verificata.
6. Generazione e archiviazione immutabile dell'XML finale.
7. Creazione del manifest del batch con documenti, revisioni e hash SHA-256 esatti. In modalità automatica il batch resta utilizzabile soltanto mentre l'abilitazione Production ordinaria è attiva.
8. Avvio volontario dell'helper locale, che verifica hostname Aruba, account atteso, modalità e manifest; se la sessione non è valida mette in pausa il flusso per il login umano e per qualunque challenge di sicurezza inattesa.
9. Caricamento degli XML tramite l'interfaccia web documentata senza autorizzazione SMS ordinaria; l'helper attende che il documento compaia nel riepilogo. Se Aruba presenta comunque una challenge OTP, SMS o CAPTCHA, l'helper si mette in pausa senza tentare di aggirarla. Qualunque errore arresta il batch prima dell'invio; ogni documento viene quindi riconciliato e gli upload pendenti già accettati vengono rimossi, oppure il batch resta bloccato per pulizia manuale verificata prima di qualunque nuovo tentativo.
10. In modalità `Assistita`, arresto prima dell'ultimo clic e invio eseguito dal titolare nel pannello. In modalità `Automatica dopo conferma`, rilettura dell'abilitazione Production e nuovo confronto del batch; solo allora l'helper esegue il clic finale.
11. Archiviazione dell'esito tecnico sanitizzato e riconciliazione dal pannello e dai file XML, PDF e notifiche scaricati.

Nessuna bozza ottiene numero fiscale definitivo prima dell'approvazione. Una fattura approvata non è più modificabile.

L'ordine esatto fra prenotazione del numero, validazione tramite upload, correzione e riuso del progressivo viene definito e testato in **M4**. Non inventare una politica: deve riflettere Aruba, l'XML reale e la regola fiscale confermata.

L'approvazione massiva:

- include solo preparazioni `READY`;
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
- incasso successivo aggiorna il raggruppamento interno, non la fattura emessa.

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

- l’importo lordo del rimborso resta quello autorevole del provider;
- per ogni ordine, la TD04 accredita al massimo l’importo realmente attribuito a quell’ordine nella fattura originaria: un rimborso Shopify Payments comprensivo della commissione non può reintrodurre la commissione già esclusa dalla fattura;
- somma note di credito non superiore al totale originario né all’importo fatturato per ciascun ordine;
- stesso rimborso mai contabilizzato due volte;
- una nota emessa è immutabile;
- rimborsi successivi all'emissione aprono una nuova bozza cumulativa;
- rimborso `pending` non genera nota;
- per eBay, se gli importi disponibili non rappresentano con certezza quanto restituito all'acquirente, bloccare e chiedere verifica.

### 7.12 Annullamenti

Gli ordini annullati prima dell'emissione vengono conservati come raggruppamenti/ordini chiusi, nascosti di default dalle code operative ma disponibili in archivio, ricerca e audit.

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
- Per ogni transazione, gateway, stato e `OrderTransaction.fees.amount` con valuta; la fee è applicabile soltanto a `shopify_payments` riuscito.
- Campi fiscali localizzati dell'ordine.
- Eventuale tax ID dell'anagrafica come fallback.

### 8.3 Dati fiscali Shopify

Priorità prevista:

1. campi localizzati dello specifico ordine (`Order.localizedFields` o equivalente corrente);
2. tax ID dell'anagrafica cliente (`Customer.taxSettings.taxId` o equivalente corrente);
3. seconda riga dell'indirizzo di fatturazione Shopify, usata dal negozio come fallback
   storico: estrarre soltanto un singolo CF o una singola P.IVA italiana con formato valido,
   rimuovere dall'indirizzo normalizzato il solo token consumato e conservare l'eventuale
   contenuto reale residuo;
4. anagrafica interna HF;
5. inserimento manuale.

Non mappare un campo soltanto dal titolo visualizzato, che può cambiare con lingua/configurazione. Salvare `key`, `countryCode`, `purpose`, `title`, `value` e il payload utile; usare `key` e `purpose` come riferimenti stabili quando la risposta reale li valorizza e configurare il mapping a partire da ordini reali.

Il fallback sull'anagrafica può richiedere scope aggiuntivi come `read_customers` o `read_taxes` e l'approvazione dei protected customer data: verificare i requisiti della versione API corrente e non richiedere scope non utilizzati.

Il dato dell'ordine è una fotografia storica. Una modifica successiva del cliente non deve alterare automaticamente una fattura già generata.

Riferimenti ufficiali da verificare quando si fissa il contratto del connettore:

- [`Order.localizedFields` e `LocalizedField`](https://shopify.dev/docs/api/admin-graphql/latest/objects/LocalizedField) confermano `key`, `countryCode`, `purpose`, `title` e `value`;
- [`Customer.taxSettings`](https://shopify.dev/docs/api/admin-graphql/latest/objects/TaxSettings) conferma `taxId` in sola lettura con scope `read_customers` o `read_taxes`;
- l'accesso resta soggetto ai protected customer data applicabili.

### 8.4 Webhook minimi da verificare

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

La richiesta `getOrder` include `X-EBAY-C-MARKETPLACE-ID` derivato dall'unico
`lineItems[].listingMarketplaceId` del riepilogo. Senza l'header eBay può restituire la
forma generica del buyer e omettere `taxIdentifier` anche per ordini `EBAY_IT`.

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
- `production`, con il pannello web reale soltanto nella prova controllata di M8 e nelle attività successive specificamente autorizzate;
- `manuale`, esportando gli XML da HF e importando in seguito file ed esiti scaricati da Aruba.

Credenziali, cookie, session storage, codici OTP e seed TOTP non entrano mai in HF, nel repository, nei prompt o nei log. Il profilo browser persistente è creato e posseduto dall'utente sul proprio computer.

### 10.1.1 Ipotesi operative da verificare

La documentazione ufficiale e le osservazioni preliminari non ancora registrate come evidenza indicano:

- caricamento tramite selettore file XML con supporto multiplo;
- limite corrente mostrato dal pannello di 300 documenti, 30 MB complessivi e 4,9 MB per file, da rileggere prima di fissare un batch;
- separazione fra caricamento/validazione e invio finale;
- account corrente senza 2FA e con protezione OTP per singolo caricamento disattivata dal titolare; il percorso ordinario non richiede quindi un SMS dopo l'upload, mentre qualunque challenge inattesa resta manuale e fail-closed;
- ricerca e dettaglio delle fatture inviate, timeline degli stati e download PDF, XML e P7M;
- download massivo supportato dal pannello.

Riferimenti di partenza: [caricamento XML](https://guide.aruba.it/soluzioni-fatturazione-elettronica/fe/fatture-documenti/carica-fatture/come-caricare-fatture-formato-xml-pannello), [accesso e 2FA](https://guide.aruba.it/soluzioni-fatturazione-elettronica/fe/accesso-homepage/accesso-pannello-e-app/come-accedere-pannello-fe) e [download delle fatture inviate](https://guide.aruba.it/soluzioni-fatturazione-elettronica/fe/fatture-inviate-ricevute-bozze/fatture-inviate/come-scaricare-fatture-inviate).

Questi dettagli restano ipotesi fino all'audit M4 registrato in un'evidenza sanitizzata con ambiente, account, data, readback e limiti osservati. Dopo la conferma diventano il contratto operativo verificato dagli smoke sintetici; il DOM del pannello può cambiare senza versionamento.

### 10.2 Helper locale multipiattaforma

L'helper di trasmissione è un comando TypeScript/Playwright della stessa repository, avviato dal titolare sul proprio computer. Usa un'installazione locale stabile di Chrome o Edge e un profilo browser dedicato. La stessa implementazione deve funzionare su Windows e macOS; non introdurre due automazioni native. Per questo flusso di caricamento e trasmissione Safari resta utilizzabile soltanto per il percorso manuale; il preferito distinto di sola lettura supporta invece anche Safari.

Il server HF non ospita un browser Aruba e non riceve la sessione. L'helper riceve da HF un token casuale, revocabile, a scadenza breve e vincolato al solo batch; durante le pause umane ne rinnova la scadenza breve tramite heartbeat, entro un limite assoluto di 45 minuti dalla creazione. Se l'operazione non termina prima del limite, il server revoca il token e forza la riconciliazione mentre il token è ancora valido. Recupera il manifest via HTTPS e invia a HF soltanto stato, identificativi tecnici e readback sanitizzato. Questa comunicazione usa esclusivamente endpoint interni di Hub Fatture, non API Aruba. Il token non autorizza da solo il clic finale: in modalità automatica il server ricontrolla manifest, stato validato e abilitazione Production immediatamente prima dell'invio. L'helper non legge né esporta cookie o local storage e non deve tentare di aggirare CAPTCHA o controlli anti-automazione.

Usare soltanto la UI visibile e gli URL ufficiali Aruba, con allowlist stretta dell'hostname e locatori semantici. Non chiamare endpoint interni scoperti tramite DevTools. Prima di ogni azione irreversibile rileggere account, ambiente, documenti e modalità autorizzati.

### 10.2.1 Sincronizzazione in entrata

L'inventario provider-first delle fatture e TD04 presenti nell'account, anche quando sono nati fuori da HF, usa il preferito `Sincronizza Aruba`. La prima configurazione consiste nel trascinare il pulsante nella barra dei preferiti di Safari, Chrome o Edge su computer; non richiede installer, estensioni, firma, Node.js, npm o Terminale. Per ogni aggiornamento il titolare sceglie **Apri Aruba** in HF, completa personalmente login ed eventuali challenge, poi usa il preferito da qualunque pagina autenticata del pannello, compresa la Home. Dalla Home il preferito chiede di selezionare personalmente `Fatture inviate`, perché il menu ExtJS richiede un'interazione nativa; arma la cattura sull'interazione stessa, ignora il traffico concorrente e attende la stabilità della griglia prima di leggere. La prima lettura percorre integralmente gli anni fiscali richiesti dal manifest, dal corrente fino al più remoto ordine ancora riconciliabile. Le letture successive sono incrementali: rileggono almeno gli ultimi sette giorni, estendono la finestra fino al più vecchio documento non terminale e terminano soltanto dopo una pagina interamente precedente al limite. Una nuova stream, un cursore mancante o una scansione completa più vecchia di trenta giorni forza una nuova lettura integrale. Il filtro data Aruba resta inattivo finché il suo comportamento Production non è qualificato. Poiché Aruba non espone un cursore di pagina immutabile, dopo un'interruzione il nuovo tentativo riparte dall'inizio della finestra corrente in una sessione pulita; l'ingest idempotente evita duplicazioni e una sola scansione può essere attiva per account e ambiente.

Il preferito non contiene token, credenziali o identità persistenti e resta riutilizzabile senza rigenerazione. Apre un ponte HF autenticato in una finestra separata; il ponte verifica l'origine Aruba esatta, crea automaticamente a ogni avvio una nuova sessione casuale temporanea di sola lettura e conserva il bearer nella propria memoria senza inviarlo alla pagina Aruba. Il ponte inoltra soltanto manifest, heartbeat, pagine inventario, completamento/fallimento e preflight tramite allowlist esatta. La sessione non può leggere manifest di upload, caricare XML o inviare documenti. Il server non riceve cookie, local storage o sessione Aruba. La finestra Aruba invia a HF soltanto righe visibili e sanitizzate. I file ufficiali che richiedono download separati non vengono acquisiti dal preferito: HF li segnala come evidenza mancante e non allenta i gate fiscali che li richiedono.

La normalizzazione degli stati conserva nella pagina inventario anche la dicitura sorgente sanitizzata, senza includerla nell'identità fiscale o nel digest dei metadati. Le diciture elettroniche osservate nel pannello reale sono coperte da regressioni dedicate; una pagina sufficientemente popolata in cui almeno metà dei documenti resta `UNKNOWN` viene rifiutata prima dell'ingest e rende la sessione fallita, così un cambiamento massivo del DOM o del vocabolario Aruba non può produrre un falso allineamento riuscito. La versione del mapper viene registrata sui cursori Aruba: un suo avanzamento forza una sola scansione completa di riallineamento, poi le letture tornano incrementali fino alla normale scadenza mensile.

I documenti esterni non generano `aruba_submissions` fittizie. HF conserva inventario, osservazioni append-only e collegamenti separati, riusa gli stati comuni `SUBMITTED`, `SDI_PROCESSING`, `DELIVERED`, `NOT_DELIVERED` e `REJECTED`, aggiorna gli esiti senza regressioni e materializza un documento storico `ARUBA_HISTORY` soltanto dopo XML ufficiale valido, match univoco e stato `DELIVERED` o `NOT_DELIVERED`. Negli stati intermedi, scartati o incerti XML e notifiche restano di proprietà del remote document senza creare una riga `documents`, perché `ARUBA_HISTORY` rappresenta documenti approvati e partecipa all'unicità fiscale. Soltanto `DELIVERED` e `NOT_DELIVERED` confermano l'emissione e consumano l'unicità della fattura o il residuo dei rimborsi coperti da una TD04: gli stati intermedi sospendono il caso senza chiuderlo, mentre `REJECTED` conserva il tentativo ma lascia possibile la revisione/riedizione e non genera note di credito. Una TD04 esterna emessa collega atomicamente tutti e soli i rimborsi completati che copre, impostando il loro `credit_document_id` sotto lo stesso lock usato dal processo di generazione, così nessun rimborso può essere riaccreditato. Gli stati di preparazione/upload restano esclusivi dei tentativi partiti da HF; etichette remote non riconosciute o terminali incompatibili aprono uno stato incerto. Gli altri casi restano in `Documenti → Da collegare` o `Da verificare`. Il piano esecutivo è in [docs/plans/aruba-inbound-reconciliation.md](plans/aruba-inbound-reconciliation.md).

Per le fatture TD01 la sincronizzazione dell'inventario è indipendente dalla preparazione. Dashboard e Impostazioni mostrano freschezza, avanzamento ed eventuale azione correttiva; la preparazione consuma lo stesso stato globale senza avviare scansioni, chiedere l'apertura di Aruba o raccogliere readback specifici. Una lettura completata da non più di un'ora non aggiunge rumore; fra un'ora e 24 ore compare un avviso non bloccante. Inventario mai letto, lettura oltre 24 ore, fallimento non risolto, match ambiguo, conflitto o stato remoto incerto bloccano server-side approvazione e numerazione. La correzione avviene sempre da Dashboard o Impostazioni e poi si torna alla preparazione aggiornata. Il preflight on-demand delle TD04 resta invariato finché quel flusso non viene riprogettato separatamente.

### 10.3 Modalità selezionabili in Impostazioni

- **Assistita**, default: l'helper apre il pannello, attende l'eventuale autenticazione umana, carica gli XML, legge la validazione e si ferma prima dell'ultimo clic `Invia`. Il titolare controlla ed esegue il clic nel pannello.
- **Automatica dopo conferma**: dopo la stessa validazione, l'helper può eseguire `Invia` soltanto se `ARUBA_SUBMISSION_ENABLED=true` e il server riconferma il manifest esatto. Qualunque mismatch o stato non riconosciuto arresta il flusso.

La scelta è globale ma viene mostrata nel riepilogo di ogni approvazione. Cambiarla non modifica batch già approvati.

### 10.4 Flusso atteso

1. HF genera e valida localmente gli XML definitivi.
2. HF crea il manifest immutabile del batch.
3. L'utente avvia l'helper dal proprio computer.
4. L'helper apre Chrome o Edge con il profilo dedicato e verifica il pannello Aruba reale.
5. Se necessario, l'utente completa login e password; qualunque challenge di sicurezza inattesa viene completata personalmente nel browser.
6. L'helper carica gli XML direttamente, senza salvarli come bozze Aruba modificabili, e prosegue quando il riepilogo mostra i documenti caricati.
7. L'helper legge e registra la validazione di ogni documento; un solo errore arresta il batch prima dell'invio. Esegue il readback di ogni documento, rimuove gli upload pendenti già accettati quando il pannello lo consente e, negli altri casi, mantiene il batch bloccato in attesa di pulizia manuale e readback conclusivo; nessun documento del batch può essere ritentato prima della riconciliazione completa.
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
- stato dell'abilitazione Production per l'invio automatico;
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

La preparazione TD01 non offre fallback o override Aruba specifici. Se lo stato globale blocca l'approvazione, il titolare completa o sostituisce la sincronizzazione dalla Dashboard o dalle Impostazioni. Il readback manuale specifico resta disponibile soltanto per i flussi che richiedono ancora un preflight on-demand, come le TD04, finché non saranno riprogettati separatamente.

Per la sincronizzazione in entrata, “completo” comprende anche la sostituzione verificabile di una scansione fallita. HF apre una sessione guidata sulla stessa finestra e presenta gli stream obbligatori per anno/tipo, il limite temporale, i precedenti non terminali e gli errori da risolvere. Il titolare percorre manualmente in Aruba tutte le pagine di ogni stream e acquisisce in HF ogni riga con i metadati canonici dell’inventario, oppure importa un export ufficiale completo dell’intero stream; registra inoltre filtri, ordinali, conteggi, estremi tecnici e pagina terminale e importa i file ufficiali necessari per documenti nuovi, cambiati, candidati o incompleti. Il server verifica che tutte le righe attese siano presenti una sola volta e rifiuta buchi, duplicati, stream mancanti, conteggi/estremi incoerenti ed errori documentali o stati incerti ancora aperti. Quantità, estremi o attestazioni senza il contenuto integrale delle righe non completano il readback.

La ricevuta può essere finalizzata soltanto da `Massimo` con `can_approve`, perché rende di nuovo possibili approvazione e numerazione. La finalizzazione marca l'inventario completo con provenienza `MANUAL` e chiude l'errore operativo sostituito senza cancellare la sessione automatica fallita; non è un override di collisioni, parsing/file invalidi, match possibili o ambigui, conflitti di profilo o stati remoti incerti. Conservare finestra, copertura, conteggi sanitizzati, hash dei file, autore e timestamp, mai dati cliente duplicati nella ricevuta.

---

## 11. Qualifica Aruba nelle milestone M4, M5 e M8

Questa attività non è una roadmap parallela che possa aggirare i gate. M4 incorpora le verifiche fiscali e documentali necessarie al generatore; M5 implementa e verifica sinteticamente l'automazione; M8 qualifica il contratto candidato sul pannello reale prima del Canary Production. La riconciliazione Aruba in entrata può essere sviluppata in tranche isolate parallelamente agli altri lavori del candidato M8, ma ne fa parte e deve essere completata prima di M9.

La raccolta dei materiali, però, non è implementazione e può iniziare durante M2 e M3. Sessione di audit, XML della fattura accettata, eventuale XML della nota di credito e conferma del commercialista dipendono dalla disponibilità di terzi e sono il percorso critico di tutto ciò che segue M3: attenderli fino all'apertura formale di M4 aggiunge attesa senza aggiungere sicurezza. Anticipare significa soltanto raccogliere e registrare evidenze in sola lettura. Restano vietati prima del rispettivo gate qualunque codice del generatore definitivo, la numerazione reale, il caricamento di XML nel pannello e ogni attività dell'helper.

### 11.1 M4 - audit autenticato read-only del pannello Aruba

M4 esegue l'audit autenticato in sola lettura, verifica le ipotesi registrate in 10.1.1 e completa i dati fiscali e operativi mancanti senza modificare configurazioni, attivare 2FA, creare documenti o caricare XML.

L'audit avviene sul computer del titolare, nella sessione Aruba che gli appartiene, e non passa mai dalla VPS. L'agente prepara la checklist dei rilievi di 11.1.1, guida la sessione e redige l'evidenza sanitizzata; la navigazione è presidiata dal titolare, che esegue personalmente login, 2FA ed eventuale CAPTCHA. L'assistenza tramite strumenti di controllo del desktop è ammessa soltanto su quella macchina, in sola lettura e sotto supervisione: non è un prerequisito, non entra nella matrice 14.3 e la sua indisponibilità non blocca M4, perché l'alternativa è il rilievo manuale dello stesso elenco. In nessuna forma vengono catturati o trasmessi a HF credenziali, cookie, sessione, OTP o schermate contenenti dati di clienti reali.

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
- ordine con data locale a fine anno approvato nell'anno successivo: quale anno determina progressivo, sezionale e data documento, e se il raggruppamento giornaliero di §7.3 deve essere spezzato quando attraversa il 31 dicembre;
- ordine corretto fra prenotazione progressivo, validazione tramite upload e invio;
- comportamento dopo scarto;
- riuso o meno del numero;
- eventuali automatismi Aruba.

Durante lo sviluppo precedente a M4 usare una numerazione mock chiaramente non fiscale. L'audit read-only definisce una procedura candidata; la prova controllata prevista in 11.4 verifica in M8 anche l'ordine osservabile soltanto dopo l'upload. Qualunque divergenza aggiorna procedura, generatore e test prima di completare M8 e prima di avviare M9.

### 11.4 M8 - prova manuale controllata come gate di uscita

L'ultimo passaggio di M8 è una prova autorizzata con dati sintetici o anonimizzati: caricamento manuale di un XML fiscalmente valido prodotto da M4 e destinato esclusivamente alla prova, lettura della validazione e del riepilogo trasmissibile, verifica del controllo finale `Invia`, arresto prima dell'ultimo clic, readback e rimozione sicura dell'upload pendente. M5 sviluppa pagina sintetica, helper e arresti fail-closed dal contratto candidato ricavato dall'audit read-only; la prova reale di M8 ne verifica e fissa il contratto definitivo prima del Canary Production.

L'autorizzazione specifica del titolare è il prerequisito della prova, non un divieto sulla prova: senza quell'autorizzazione non viene caricato alcun XML. Ottenuta l'autorizzazione, il caricamento è ammesso per il solo XML dedicato alla prova e la prova non esegue in nessun caso un invio.

La prova registra:

- validazione ottenuta dal caricamento e formato degli errori visibili;
- limiti di upload riletti;
- locatori semantici necessari e schermate di arresto;
- comportamento della sessione persistente, del caricamento ordinario senza SMS e delle pause per eventuali challenge di sicurezza;
- tempi e limiti del readback assistito;
- download XML/PDF/notifiche;
- percorso manuale completo quando l'helper è indisponibile.

### 11.5 Materiali e output delle milestone

- accesso controllato al pannello Aruba;
- XML originale di una fattura accettata;
- PDF corrispondente;
- se disponibile, XML/PDF di una nota di credito;
- Chrome o Edge installato sul computer che eseguirà l'helper;
- decisione operativa confermata: 2FA Aruba non usata e protezione OTP per ciascun caricamento disattivata;
- conferma del commercialista per i valori fiscali non deducibili dai documenti.

M4-M5 producono il contratto candidato; M8 aggiorna questa specifica o produce un ADR breve con:

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

- **Automatica dopo l'esito SdI**: inviare dopo che il readback riporta un esito che conferma l'emissione, mai dopo la sola validazione del file né dopo la sola acquisizione Aruba.
- **Manuale con approvazione**: nella schermata di approvazione l'utente decide per la singola preparazione.
- **Disattivata**: HF non propone né accoda nuovi invii, rifiuta reinvii e scelte `Invia` manomesse e sopprime prima del contatto SMTP eventuali job già accodati. Lo storico resta consultabile; un invio SMTP già materialmente iniziato non è annullabile.

Anche in modalità automatica, la schermata deve permettere di non inviare per una specifica preparazione prima dell'approvazione.

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

La copia parte quando il readback riporta un esito SdI che conferma l'emissione, non alla validazione del file e non alla semplice acquisizione da parte di Aruba. Inviare all'acquisizione anticipa la copia di poco e, in caso di scarto, lascia al cliente il PDF di una fattura che non esiste, recuperabile soltanto a mano: attendere l'esito elimina l'intera classe di errore al costo di un'attesa in genere breve.

Confermano l'emissione sia `DELIVERED` sia `NOT_DELIVERED`: la mancata consegna riguarda il recapito al canale del destinatario, non la validità del documento, ed è anzi il caso in cui la copia leggibile è più utile al cliente. Il trigger esclude soltanto `REJECTED` e gli stati ancora incerti, che non autorizzano alcun invio.

Poiché in HF il readback non è continuo (10.6), l'esito può essere osservato soltanto quando l'helper è aperto o dopo un import manuale: la copia in modalità automatica parte quindi alla prima riconciliazione utile, e il pannello mostra da quanto tempo un documento resta senza esito. Se questa latenza diventa un problema operativo, la risposta è la modalità `Manuale`, non l'invio anticipato.

Uno scarto non invia automaticamente nulla al cliente e non cancella un invio già registrato: richiede gestione manuale secondo la procedura di scarto verificata.

### 12.5 PoC OCI Email Delivery e scelta del trasporto

Il PoC ha una precondizione eliminatoria, da verificare prima di scrivere qualunque codice o creare qualunque risorsa OCI: il dominio dell'indirizzo mittente del negozio deve essere posseduto dal titolare con accesso ai record DNS. Senza quel controllo, SPF, DKIM e approved sender non sono configurabili e il PoC non è eseguibile.

Se la precondizione non è soddisfatta, HF-O07 si chiude immediatamente su «SMTP esistente»: il PoC, le relative attività di M6 e M7 e i punti di checklist che lo riguardano decadono senza sostituzioni, e la decisione viene registrata nel contratto e-mail. È una verifica da pochi minuti che può cancellare l'intero blocco di lavoro: eseguirla prima di M6, non durante.

Se la precondizione è soddisfatta, eseguire il PoC soltanto in Development, con documento sintetico e destinatario controllato dal titolare:

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
3. Documenti
4. Clienti
5. Attività
6. Impostazioni

La navigazione resta a un solo livello. Una destinazione compare soltanto quando dispone di una superficie utilizzabile; le funzioni future non producono voci o contenitori vuoti. Le code e le prospettive sullo stesso oggetto sono viste interne, non nuove destinazioni.

- `Ordini`: Tutti, Da fatturare, Da verificare, In attesa e Annullati.
- `Documenti`: Tutti, Fatture, Note di credito e viste per stato di trasmissione.
- `Attività`: Da gestire e Cronologia; richieste privacy e job falliti restano azioni operative, non impostazioni.
- `Impostazioni`: pagina unica con navigazione interna a Profilo e sicurezza, Fatturazione, Profilo fiscale, Connessioni, Aruba e helper, E-mail al cliente e Sistema.

Il menu rapido del profilo mostra identità, capacità operative, tema e uscita. Il collegamento `Profilo e sicurezza` porta alla relativa sezione di `Impostazioni`, che ripropone lo stesso riepilogo prima dei controlli completi dell’account.

Su desktop la sidebar fissa può essere compressa dall'utente mantenendo visibili marchio, icone e destinazione attiva. I nomi restano accessibili e disponibili su hover o focus, la preferenza viene conservata nel browser e non esiste espansione automatica al passaggio del mouse. Al primo accesso parte aperta da 1024 px e compressa fra 769 e 1023 px; la scelta esplicita dell'utente prevale sul default responsive.

Su mobile la navigazione principale resta una barra inferiore a cinque destinazioni: Dashboard, Ordini, Documenti, Clienti e `Altro`. `Altro` contiene Attività e Impostazioni. Le icone sono sempre visibili e accessibili, mentre soltanto la destinazione attiva espone anche l’etichetta su una riga. Il cambio pagina sposta etichetta ed evidenza sulla nuova destinazione senza scorrimento orizzontale.

### 13.2 Dashboard

Mostrare:

- preparazioni pronte da approvare;
- da verificare;
- pagamenti pendenti;
- note di credito da approvare;
- upload falliti;
- scarti SdI;
- errori di sincronizzazione;
- ultimo sync Shopify/eBay e ultimo readback Aruba, con indicazione di eventuale stato obsoleto;
- stato dell'inventario Aruba, documenti da collegare o ambigui e azione `Sincronizza Aruba ora`; `Mai letto`, un readback bloccante o uno stato remoto incerto impediscono il riepilogo `Tutto sotto controllo`;
- documenti emessi oggi/mese.

Nessuna e-mail operativa nella 1.x: gli avvisi critici devono essere evidenti qui.

### 13.3 Ordini

- Viste Tutti, Da fatturare, Da verificare, In attesa e Annullati.
- Filtri per piattaforma, stato, data, trigger, pagamento.
- Ricerca per ID ordine, cliente, e-mail, codice fiscale/P.IVA.
- Vista del dato originale e normalizzato.
- Collegamento alla Preparazione fattura.
- Documento Aruba collegato, stato SdI e freschezza del readback quando disponibili.
- Un match su un solo ordine di una preparazione multi-ordine invalida atomicamente la bozza materializzata, esclude soltanto l'ordine coperto e rigenera una preparazione con i residui ancora fatturabili; un errore ripristina l'intera transazione.
- La chiusura e la separazione avvengono soltanto dopo `DELIVERED` o `NOT_DELIVERED`: uno stato intermedio sospende la preparazione e `REJECTED` mantiene l'ordine disponibile per revisione/riedizione.
- Una TD04 esterna emessa collega atomicamente i rimborsi completati coperti; rimborsi ambigui, già collegati altrove o non riconciliabili non vengono consumati automaticamente.
- Forzatura manuale della generazione bozza.
- Archivio annullati.

### 13.4 Clienti

La sezione espone l’anagrafica corrente riconciliata dai canali senza sostituire gli snapshot storici di ordini, preparazioni o documenti.

- Viste `Tutti` e `Da verificare`.
- Ricerca per nome, e-mail, telefono, codice fiscale, partita IVA o riferimento cliente del canale.
- Elenco con tipo cliente, e-mail, identificativo fiscale senza etichettarne il tipo, canali collegati, ultimo ordine e conteggi operativi; quando assente mostra uno stato neutro.
- Dettaglio con anagrafica corrente, origine Shopify/eBay, ordini, preparazioni fattura e documenti collegati.
- Le correzioni fiscali continuano ad avvenire nella Preparazione fattura: valgono per il relativo documento, restano auditate e non riscrivono ordini già importati o dati del provider.

Una stessa identità fiscale riconciliata fra Shopify ed eBay compare una sola volta; un’identità ambigua resta separata e visibile in `Da verificare`. La pagina non introduce modifica massiva, propagazione verso i provider o cancellazione dei dati.

### 13.5 Preparazione fattura

È la pagina di lavoro aperta dalle viste Da fatturare e Da verificare di Ordini. Non è una destinazione della navigazione principale e il nome tecnico `billing_case` non compare nel frontend.

- Riepilogo con stato, cliente, data, ordini, totale e anomalie.
- Timeline e audit.
- Aggiunta/rimozione di ordini compatibili prima dell'approvazione.
- Separazione di un ordine.
- `Non trasmettere` con motivo.
- Anteprima fattura già valida e approvabile quando lo stato è `READY`; nessun salvataggio è richiesto se i dati proposti non vengono modificati.

### 13.6 Approvazione

Mostrare in una sola pagina:

- cliente e dati fiscali;
- ordini inclusi;
- righe semplificate;
- totale importato, totale documento e differenza;
- pagamento;
- esito controlli;
- risultato della validazione XSD;
- solo quando non sano, stato globale dell'inventario Aruba e collegamento alla sede in cui aggiornarlo;
- scelta invio e-mail;
- conferme eccezionali.

Il comparatore fiscale visuale occupa la stessa pagina e presenta tre livelli derivati server-side:

1. snapshot immutabile dell'ordine o rimborso sorgente;
2. bozza corrente, comprese normalizzazioni e modifiche manuali;
3. proiezione strutturata dell'XML che il generatore corrente produrrebbe per Aruba.

Raggruppare le differenze per anagrafica fiscale, ordini/righe, importi, pagamento, causale e dati tecnici. Per ogni valore cambiato mostrare origine, valore precedente, valore finale e motivo disponibile; gli elementi invariati restano comprimibili. Colore e posizione non sono mai gli unici indicatori. Il raw XML è soltanto una vista tecnica espandibile o scaricabile, mai un editor e mai la base di un diff testuale.

Nelle fatture TD01 il riepilogo mostra subito l'esito sintetico dei controlli; il confronto fiscale completo e il raw XML restano espandibili. Se l'utente modifica anagrafica, righe o pagamento, l'interfaccia mostra `Salva modifiche` e ricalcola automaticamente validazione e proiezione; se non modifica nulla, può approvare direttamente la proposta server-side.

Il comparatore usa lo stesso generatore e la stessa versione della bozza impiegati dall'endpoint di approvazione. Dopo qualunque modifica diventa stale e viene ricalcolato; al submit il server rigenera la proiezione e rifiuta l'approvazione se revisione o hash non coincidono. Un errore di generazione o una differenza non classificabile blocca l'approvazione e indica l'azione correttiva. Lo stesso contratto vale per TD04, senza estendere automaticamente a quel flusso la nuova organizzazione visuale TD01.

Azioni:

- salva le modifiche, soltanto dopo che l'utente ha cambiato i dati proposti;
- approva la fattura, assegnando automaticamente il numero e generando l'XML definitivo;
- non trasmettere.

Il pulsante `Approva fattura` è la conferma esplicita dell'azione descritta nel riepilogo finale: non aggiungere una checkbox generica che ripeta lo stesso consenso. Restano obbligatorie e distinte le sole conferme eccezionali, per pagamento pendente o differenza d'importo motivata.

Il server blocca approvazione e numerazione se l'inventario Aruba dell'anno corrente non è mai stato completato, ha più di 24 ore o presenta uno stato incerto rilevante; dopo un'ora mostra un avviso. La preparazione TD01 non offre override o sincronizzazioni specifiche: la correzione avviene dalla Dashboard o dalle Impostazioni e poi si torna alla pagina aggiornata.

### 13.7 Documenti

La sezione riunisce fatture, note di credito e documenti nei diversi stati di trasmissione. Le viste interne evitano tre archivi separati e mantengono filtri coerenti per tipo, stato, cliente e data.

La vista interna `Da collegare` raccoglie i documenti osservati in Aruba senza un ordine o documento HF collegabile in modo univoco. Mostra origine, stato remoto, ultimo aggiornamento e anomalie senza creare ordini locali. Un documento senza riferimenti ordine espliciti né match Shopify/eBay compatibili resta visibile per l’anti-duplicazione ma non è una verifica bloccante; soltanto riferimenti espliciti incompatibili, match potenziali, ambiguità, conflitti ed errori alimentano anche `Da verificare` e `Attività`.

Per le note di credito mostrare:

- Fattura originaria.
- Rimborsi inclusi.
- Residuo accreditabile.
- Righe e totale.
- Anomalie di riconciliazione.
- Anteprima e approvazione separata.

### 13.8 Attività

La vista `Da gestire` riunisce errori, verifiche richieste, scarti, documenti Aruba da collegare o ambigui, conflitti di profilo, stati remoti incerti, richieste privacy Shopify e retry dei job falliti con la relativa azione. Dopo il cliente mostra l’identificativo fiscale senza etichettarne il tipo, usando lo snapshot autorevole dell’ordine, della preparazione o del documento e uno stato neutro quando assente. Questi elementi non compaiono in `Impostazioni`, che mostra soltanto stato e collegamento al dettaglio operativo. La vista `Cronologia` espone il registro attività ricercabile e non modificabile. La Dashboard può riepilogare i conteggi critici, ma non duplica il dettaglio.

### 13.9 Impostazioni

- Pagina unica con navigazione interna; nessuna destinazione di primo livello aggiuntiva.
- Profilo e sicurezza: stesso riepilogo del menu rapido, tema, cambio password, sessioni attive, revoca delle altre sessioni e uscita.
- Trigger globale bozza: pagamento/evasione completa.
- Modalità invio copia: automatica/manuale.
- Fuso orario: Europe/Rome, non modificabile nella 1.x salvo reale necessità.
- Profilo fiscale: sola lettura dopo audit, con versione.
- Numerazione/sezionale: protetta e configurata dopo audit.
- Modalità Aruba: `Assistita` come default oppure `Automatica dopo conferma`.
- Stato sintetico della sincronizzazione Aruba, ultimo inventario completo, tre conteggi operativi, azione **Apri Aruba** e istruzioni per configurare una volta il preferito. Sessione in corso e codice diagnostico restano nei dettagli.
- Trasporto SMTP scelto e stato, senza mostrare credenziali.
- Sistema: ambiente e fuso orario; versione applicativa, backup e ripristino compaiono soltanto quando M7 fornisce dati e azioni reali.

La vista interna `Connessioni` mostra, per Shopify, eBay e il trasporto SMTP canonico:

- ambiente;
- stato;
- ultimo controllo;
- ultimo sync;
- riconnetti;
- verifica credenziali;
- dettagli errore sanificati.

Per Aruba non mostrare `riconnetti` o `verifica credenziali`: HF non possiede credenziali Aruba. La vista ordinaria mostra un solo stato osservato, l'ultimo inventario completo, i conteggi `documenti`, `senza ordine Shopify/eBay` e `da verificare`, l'azione **Apri Aruba** e le due istruzioni del preferito. Sessione temporanea e codice diagnostico sono dettagli avanzati. `Sincronizzazione in corso` significa soltanto che il ponte HF ha ricevuto un heartbeat recente: non implica che la sessione Aruba sia autenticata, informazione che resta nella pagina Aruba.

`Modalità Assistita` e `Automatica dopo conferma` appartengono alla trasmissione dei documenti, non alla sincronizzazione dell'inventario, e vivono in un blocco separato. Il readback manuale completo non compare nella vista ordinaria: resta sempre raggiungibile dal recupero avanzato soltanto quando esiste un errore bloccante e solo per il titolare.

Non mostrare mai segreti.

### 13.10 Fondazione UI, identità leggera e contenuti

Hub Fatture è uno strumento operativo privato: non serve un sistema di brand esteso. Prima della UI definitiva serve però una Brand Foundation leggera e vincolante, composta soltanto da:

- nome `Hub Fatture`; la sigla `HF` resta esclusivamente interna e non viene resa nel frontend, nei nomi accessibili, nelle notifiche o nei documenti destinati all’utente;
- un marchio/icona SVG canonico, favicon e sole varianti raster effettivamente richieste dall'app e da GitHub;
- palette minima e token CSS essenziali, senza sostituire i colori semantici di stato;
- tipografia di sistema, nessun webfont;
- tono e principi di microcopy;
- regole minime di contrasto, spaziatura e uso del marchio.

La fonte è `docs/brand/brand-foundation.md`; gli asset sorgente vivono in `docs/brand/assets/`. Non creare brand board, pacchetto di componenti separato, Storybook, sito pubblico, set di illustrazioni o varianti speculative. Il design system interno resta leggero: token CSS semantici, componenti React accessibili e pattern applicativi condivisi. La direzione visiva approvata viene riusata da UI, favicon, README e social preview della repository.

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

Le azioni ad alto impatto richiedono una conferma che descriva la conseguenza specifica, non un generico «Sei sicuro?». Per `Approva fattura` il riepilogo mostra almeno documento, destinatario, totale, profilo fiscale, stato del pagamento e irreversibilità della numerazione automatica; il pulsante esplicito completa la conferma senza una checkbox generica ridondante. Le sole eccezioni fiscali previste mantengono conferme aggiuntive dedicate. La trasmissione è un passaggio successivo e separato. La protezione è sempre server-side: nascondere o disabilitare un pulsante non autorizza né impedisce una transizione.

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

- `aruba-helper`: comando TypeScript/Playwright avviato dal titolare su Windows o macOS e collegato a Chrome/Edge tramite un profilo dedicato. Usa via HTTPS token di batch brevi per upload/invio. Non è un servizio remoto, non gira sulla VPS, non conserva credenziali Aruba e non chiama API Aruba. La sincronizzazione dell'inventario non usa questo componente: il preferito opera nella pagina Aruba già autenticata e comunica con il ponte temporaneo di HF.

Gli ambienti sono separati logicamente:

- `development`: database, token, storage e hostname propri; solo fixture o pagina Aruba sintetica locale;
- `production`: dati reali e credenziali Shopify/eBay/SMTP/infrastruttura sulla VPS; nessuna credenziale Aruba;
- nessun ambiente staging permanente nella 1.x, salvo necessità emersa durante l'integrazione Aruba.

Per esporre temporaneamente lo sviluppo locale sono ammessi Cloudflare Quick Tunnel o ngrok. Non usarli come URL di produzione.

### 14.2 Confini modulari

La struttura segue le responsabilità osservate, non un albero di cartelle preparato in anticipo:

- `src/*.ts` contiene dominio puro, schemi e trasformazioni senza accesso a rete, filesystem o database;
- `src/db/*.server.ts` possiede SQL, transazioni e persistenza per capacità; storage documentale, comandi ordine e validazione degli ID database sono moduli distinti;
- `src/integrations/*.server.ts` traduce i contratti dei provider e usa il livello dati senza incorporare query SQL;
- `app/routes/*.tsx` compone il rendering e i componenti della schermata; quando parsing HTTP e orchestrazione server diventano sostanziali vivono nel modulo `*.server.ts` adiacente;
- `app/components/` contiene componenti condivisi o sezioni autonome con API tipizzate, senza accesso runtime ai moduli server.

All'interno di `src/db` i consumatori importano il modulo proprietario della capacità, non un barrel generico né una facciata mantenuta per compatibilità interna. Le dipendenze devono restare acicliche: una primitiva condivisa viene estratta nel livello più basso che la possiede, mentre un ciclo non viene mascherato con import dinamici o re-export. Il gate unitario percorre gli import locali di `app` e `src` e fallisce se compare un ciclo.

La lunghezza di un file non è da sola un difetto. Si estrae un modulo quando esistono motivi di modifica distinti, un confine di effetto reale o dipendenze riusabili; non si frammentano query e transazioni coese per rispettare una soglia numerica.

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
| `lucide-react` | unica libreria di icone lineari dell’interfaccia |
| `pg` | driver PostgreSQL |
| `zod` | configurazione e confini esterni, non modelli duplicati interni |

Dipendenze runtime già scelte ma installate soltanto alla milestone che le usa, per non tenere superficie di supply chain e immagine senza consumatori:

| Pacchetto | Uso ammesso | Installazione |
|---|---|---|
| `@shopify/shopify-api` | OAuth, webhook e API Shopify ufficiali | connettori |
| `xmlbuilder2` | costruzione e parsing XML; il profilo definitivo viene qualificato con i documenti | documenti e approvazione |
| `nodemailer` | unico adapter SMTP, indipendente dal provider scelto in HF-O07 | notifiche |

Dipendenze di sviluppo dirette iniziali:

| Pacchetto | Uso ammesso |
|---|---|
| `@react-router/dev` | build e route type-safe |
| `vite` | build del framework |
| `typescript` | typecheck e compilazione worker |
| `@playwright/test` | E2E, smoke browser e helper Aruba locale; non installato nell'immagine server Production |
| `oxlint`, `oxfmt` | uniche toolchain lint/formato |
| `react-doctor` | scansione React completa nel comando locale/CI canonico e configurazione condivisa con l'Action bloccante dai warning |
| `@types/node`, `@types/react`, `@types/react-dom` | tipi piattaforma allineati al runtime |
| `@types/pg` | tipi driver PostgreSQL; `@types/nodemailer` entra con `nodemailer` |

`pdfkit` e i relativi tipi sono l'unica dipendenza condizionale già selezionata: non installarli finché HF-O03 non dimostra che Aruba non restituisce un PDF ufficiale utilizzabile. Se servono, usare font incorporati e non aggiungere Chromium al runtime per renderizzare PDF.

Scelte native deliberate:

- `node:crypto` (`scrypt`, `randomBytes`, `randomUUID`, SHA-256 e HMAC) per password, identificativi e hash; nessun wrapper crypto;
- `fetch` nativo per eBay, Dynu e comunicazione HTTPS helper-HF; niente Axios o secondo client HTTP;
- `Intl.DateTimeFormat` e `timestamptz` PostgreSQL per Europe/Rome; niente libreria date;
- importi monetari in centesimi di euro interi, validati con `Number.isSafeInteger`; niente libreria decimale;
- `node:test` come unico runner unitario e d'integrazione; Playwright resta il solo runner browser;
- type stripping nativo del runtime scelto per script e CLI TypeScript locali, solo dopo uno smoke della sintassi supportata; niente esecutore TypeScript aggiuntivo;
- logger locale minimo: un oggetto JSON per riga su stdout/stderr, campi tipizzati e allowlist; niente libreria di logging;
- form/action e sessioni server-side di React Router persistite in PostgreSQL; niente form library o auth framework;
- coda PostgreSQL con tabella, lease e `FOR UPDATE SKIP LOCKED`; niente Redis, broker o libreria di coda;
- HTML semantico, CSS, token e componenti locali; niente pacchetto design system separato, Tailwind, Storybook o libreria UI;
- query SQL parametrizzate, vincoli, lock e transazioni in PostgreSQL confinati in `src/db`; nessun repository pattern o interfaccia con una sola implementazione.

Le migrazioni sono file SQL append-only ordinati e sottoposti a review. Un piccolo runner compilato con l'app usa `pg`, advisory lock, transazione, tabella `schema_migrations` e checksum per rifiutare file già applicati ma modificati; non esiste un comando `push` Production. Tutti gli importi monetari sono colonne PostgreSQL `integer` espresse in centesimi e valori TypeScript `number` interi sicuri; le stringhe decimali esterne vengono convertite da un parser stretto che rifiuta cifre decimali non nulle oltre i centesimi. Percentuali o coefficienti fiscali non monetari che richiedono precisione restano stringhe validate fino alla serializzazione XML. Il worker e il runner migrazioni vengono compilati con `tsconfig` dedicati; soltanto script e CLI locali possono eseguire `.ts` direttamente quando il runtime fissato ne supera lo smoke, con sola sintassi cancellabile, import espliciti e senza alias `paths`. L'uso SMTP resta limitato a `createTransport`/`sendMail` e ha un typecheck mirato. M0 verifica installazione pulita, peer dependency, audit, test nativi, import smoke, React Doctor e typecheck prima di rendere canonici manifest, lockfile e digest.

Riferimenti da riverificare quando si crea il lockfile: [release Node.js](https://nodejs.org/en/about/previous-releases), [React Router Framework Mode](https://reactrouter.com/start/modes), [documentazione PostgreSQL](https://www.postgresql.org/docs/), [release age](https://github.com/FiloSottile/age/releases).

Non introdurre due ORM, un framework API separato o una dipendenza già sostituita da Node, PostgreSQL o React Router.

### 14.4 Transazioni critiche

Usare transazioni DB per:

- assegnazione ordine a raggruppamento interno;
- approvazione e numerazione;
- creazione/aggiornamento nota cumulativa;
- registrazione di un rimborso;
- acquisizione univoca di webhook;
- passaggio job da pending a running;
- chiusura di un documento.

### 14.5 Lock e concorrenza

Vincoli DB e lock transazionali devono impedire:

- due raggruppamenti per la stessa chiave quando uno è ancora aperto;
- ordine in più fatture;
- due note per lo stesso rimborso;
- doppia numerazione;
- due worker sullo stesso job.

Lock e vincoli proteggono lo stato letto, non soltanto la scrittura finale: configurazione, documento, residuo rimborsabile e prossimo numero fiscale vanno riletti dentro la stessa transazione o lease che autorizza la mutazione.

### 14.6 Fonti autorevoli

| Informazione | Fonte autorevole | Ruolo di HF |
|---|---|---|
| Ordine, pagamento, evasione, annullamento e rimborso sorgente | Shopify o eBay | snapshot storico e stato normalizzato riconciliabile |
| Commissione Shopify Payments effettiva | `OrderTransaction.fees` di Shopify | importo osservato immutabile; la configurazione HF decide separatamente se sottrarlo dal totale fatturabile |
| Identità normalizzata, raggruppamento, bozza, override e approvazione | PostgreSQL HF + audit | fonte primaria applicativa |
| Profilo fiscale approvato | versione HF derivata da XML Aruba accettato e decisioni approvate | snapshot immutabile nel documento |
| XML/PDF/notifica archiviati | file immutabile + hash e metadati DB | fonte del contenuto conservato |
| Inventario Aruba e stato SdI corrente | pannello Aruba e file ufficiali scaricati | cache provider-first con data dell'ultimo inventario completo, osservazioni append-only e collegamenti ai documenti locali |
| Invio e-mail | esito del trasporto SMTP canonico e `message_id` | stato locale riconciliabile |
| Release | tag/commit Git e digest immagine | `/version` e ricevuta di deploy confermano lo stato live |
| Backup | archivio OCI cifrato, copia cifrata sul Mac, manifest e checksum | il DB conserva solo l'ultimo esito operativo |

Un webhook segnala che qualcosa può essere cambiato: non sostituisce la rilettura dello stato corrente quando il provider offre un readback. Gli esiti Aruba sono aggiornati soltanto da osservazioni dell'helper o import manuali; eventi fuori ordine non devono far regredire uno stato autorevole.

La presenza in Aruba è indipendente dal percorso di invio locale: `aruba_submissions` resta autorevole sui tentativi partiti da HF, mentre l'inventario remoto rappresenta anche documenti creati direttamente nel pannello. La freschezza operativa deriva dall'ultima scansione completata, non dal semplice heartbeat dell'helper.

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
- `username`
- `password_hash`
- `can_approve`
- `created_at`
- `last_login_at`

Sono ammesse operativamente soltanto le due righe con username canonici `Massimo` e `Codex`. Il login è case-insensitive, ma database, interfaccia e audit conservano e mostrano sempre la forma canonica. `can_approve` è vero soltanto per `Massimo` e autorizza le sole transizioni fiscali irreversibili descritte in 17.1; la colonna nasce nella migrazione M4.

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

Per Aruba usare stream distinti per anno fiscale e tipo inventario, con cursore opaco, finestra di sovrapposizione e timestamp dell'ultima scansione completa. Il cursore viene avanzato soltanto dopo il commit idempotente dell'intera pagina.

#### `aruba_remote_documents`

Inventario canonico dei documenti osservati nel pannello, indipendente dall'origine locale. Conserva account/ambiente, ID remoto, tipo, numero/serie/anno, data, destinatario e identificativi normalizzati necessari al matching, totale, stato remoto corrente, hash XML ufficiale, riferimenti ai file e date di prima/ultima osservazione. Ogni chiave di deduplicazione — ID remoto, identità fiscale del documento e hash XML — è confinata per account e ambiente; collisioni incompatibili diventano conflitti, non fusioni automatiche.

#### `aruba_remote_observations`

Cronologia append-only delle osservazioni del pannello e dei file ufficiali, collegata a sessione e cursore. La proiezione corrente accetta soltanto transizioni monotone; `NOT_FOUND` dopo una precedente osservazione e stati conclusivi incompatibili aprono uno stato remoto incerto.

#### `aruba_document_matches`

Collegamenti fra inventario remoto e documenti, ordini, preparazioni o rimborsi locali, con stato `MATCHED`, `UNMATCHED`, `AMBIGUOUS`, `PROFILE_CONFLICT`, `ERROR` o `UNKNOWN_REMOTE_STATE`, segnali/versione del matcher e decisione automatica o manuale auditata. Un match automatico richiede unicità e XML ufficiale coerente; il solo totale non è mai sufficiente. Per le TD04 il collegamento identifica l'insieme esatto dei rimborsi coperti e aggiorna `credit_document_id` atomicamente soltanto dopo un esito che conferma l'emissione.

#### `aruba_sync_sessions`

Lease delle sessioni helper di sola lettura, con token conservato soltanto come hash, installazione/dispositivo, account/ambiente, versione helper/browser, heartbeat, scadenza assoluta entro 8 ore, cursori, conteggi sanitizzati ed errore stabile. Un vincolo o lock garantisce una sola sessione attiva per account e ambiente.

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
- `shopify_payments_fee_amount`
- `deducted_shopify_payments_fee_amount`
- `billable_amount` generato come `gross_amount - deducted_shopify_payments_fee_amount`
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
- `country_code`
- `source_field`
- `imported_at`

#### `payments`

- `id`
- `order_id`
- `external_payment_id`
- `method`
- `status`
- `amount`
- `shopify_payments_fee_amount`
- `paid_at`
- `recorded_manually`
- `raw_json`

#### `order_source_revisions`

- `id`
- `order_id`
- `billing_case_id`
- `previous_normalized_snapshot_json`
- `current_normalized_snapshot_json`
- `created_at`

Ogni conflitto sorgente conserva entrambe le versioni in modo immutabile prima di aggiornare
l’ordine corrente.

#### `billing_cases`

- `id`
- `public_number` (progressivo interno non fiscale, senza prefisso; reso come `Preparazione fattura 000154`)
- `customer_id`
- `customer_snapshot_json`
- `local_order_date`
- `currency`
- `fiscal_profile_version`
- `status`
- `do_not_transmit_reason`
- `created_at`
- `updated_at`
- `closed_at`

Lo snapshot anagrafico della preparazione è immutabile: ordini importati in seguito possono
aggiornare il cliente normalizzato, ma non i dati mostrati dalle preparazioni precedenti.

#### `documents`

- `id`
- `billing_case_id`
- `kind` (`INVOICE`, `CREDIT_NOTE`)
- `origin` (`HUB`, `ARUBA_HISTORY`)
- `status`
- `document_type`
- `series`
- `fiscal_year`
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

`series` e `fiscal_year` esistono perché il numero fiscale è unico soltanto dentro il proprio sezionale e anno: senza queste colonne il vincolo di §15.2 non è esprimibile. Valori e formato sono definiti dall'audit di 11.3; le colonne nascono nella migrazione M4 che introduce la numerazione.

L'assenza di sezionale si rappresenta con un valore canonico esplicito, mai con `NULL`: un `UNIQUE` PostgreSQL considera distinti i `NULL`, quindi una serie nulla lascerebbe passare due documenti con lo stesso anno e numero, cioè esattamente la doppia numerazione che §14.5 deve impedire. Un `CHECK` impone che `series`, `fiscal_year` e `fiscal_number` siano tutti valorizzati dagli stati numerati in poi, e l'unicità è un indice unico sulle tre colonne limitato ai documenti già numerati.

Quando il confronto storico trova in Aruba una fattura con esito `DELIVERED` o `NOT_DELIVERED`, il suo XML ufficiale viene validato, archiviato immutabilmente con origine `ARUBA_HISTORY` e collegato agli ordini riconosciuti. Il documento storico partecipa all'unicità della numerazione e al residuo accreditabile, ma non può essere caricato nuovamente nel pannello Aruba; è la fonte necessaria per collegare eventuali TD04 successive senza ricostruire o indovinare i dati fiscali originari. Un documento `SUBMITTED`, `SDI_PROCESSING`, `REJECTED` o incerto resta nell'inventario remoto con file/notifiche propri e non crea `ARUBA_HISTORY`, perché quello stato locale è approvato e consumerebbe impropriamente l'unicità fiscale.

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

Questa tabella registra esclusivamente tentativi di upload/invio originati da HF. I documenti nati fuori da HF vivono nell'inventario remoto e vengono collegati a `documents` senza creare submission artificiali.

Per `aruba_files` e `sdi_notifications`, `submission_id` e `remote_document_id` sono owner di provenienza alternativi con vincolo “esattamente uno valorizzato”. Il collegamento opzionale a `documents` viene aggiunto dopo il match senza cambiare la provenienza e senza costruire una submission fittizia.

#### `aruba_files`

- `id`
- `document_id` opzionale
- `submission_id` opzionale
- `remote_document_id` opzionale
- `storage_object_id`
- `kind`
- `imported_at`
- `metadata_json`

`submission_id` e `remote_document_id` sono singolarmente opzionali ma soggetti al vincolo esclusivo sopra: esattamente uno dei due deve essere valorizzato.

#### `sdi_notifications`

- `id`
- `submission_id` opzionale
- `remote_document_id` opzionale
- `remote_notification_id`
- `type`
- `status`
- `received_at`
- `storage_object_id`
- `metadata_json`

Anche qui esattamente uno fra `submission_id` e `remote_document_id` deve essere valorizzato.

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
- Numero fiscale univoco sulla chiave `(series, fiscal_year, fiscal_number)` fra i documenti numerati, con serie sempre valorizzata e unicità imposta dal DB dopo l'audit.
- Ogni invio automatico richiede batch e manifest immutabili, documenti validati e `ARUBA_SUBMISSION_ENABLED=true`; mismatch di batch, documento, revisione o hash arrestano il flusso.
- Nessun segreto in tabelle di log/audit.
- Nessuna transizione fiscale basata su un valore fornito soltanto dal browser.
- Approvazione, numerazione, finalizzazione di un readback manuale e risoluzione manuale di match con effetti fiscali soltanto da un account con `can_approve`.
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
- `aruba_reconcile_inventory`
- `prepare_aruba_batch`
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
- Aruba inventory: prima scansione completa della finestra rilevante, poi scansioni esplicite incrementali con sovrapposizione; nuovo stream, cursore assente o incongruenza forzano una nuova scansione completa.
- Pulizia sessioni: giornaliera.

Rispettare rate limit reali e usare cursori/sovrapposizione per Shopify, eBay e inventario Aruba. Per Aruba non simulare un polling headless sulla VPS e non promettere aggiornamenti automatici: la scansione parte soltanto dal preferito, con una sessione server-side unica per account e ambiente. Mostrare l'età dell'ultimo inventario completo e l'azione concreta per aprire Aruba quando è obsoleto o esistono documenti non conclusi.

Quando una correzione del mapper richiede di rileggere ordini già importati, una migrazione
append-only riporta il cursore `orders` a poco prima dell'ordine più remoto interessato e
rende la connessione immediatamente schedulabile. Il worker usa il normale import con upsert:
un job già pendente o in esecuzione resta unico e il replay non duplica ordini. Se il provider
espone più risultati del limite per singolo job, il cursore conserva pagina e limite temporale
del batch e il worker prosegue con job successivi prima di tornare alla finestra incrementale.

### 16.4 Registro errori e riconciliazione

Definire un registro chiuso di codici stabili, raggruppato almeno per `AUTH`, `VALIDATION`, `CONFLICT`, `PROVIDER`, `NETWORK`, `PARSING`, `STORAGE`, `MIGRATION` e `UNKNOWN_REMOTE_STATE`. Ogni codice specifica:

- se l'errore è transitorio, permanente o richiede decisione umana;
- se il retry può essere automatico;
- messaggio UI sanificato e dato operativo consentito;
- evento/audit necessario;
- azione di riconciliazione.

Timeout, errori di trasporto, risposta non JSON/XML, schema inatteso e `5xx` devono essere catturati e tradotti in codici stabili: non propagare stack trace o messaggi del provider all'utente. L'errore originale può essere conservato solo in forma sanitizzata e con retention breve.

Dashboard e `Attività → Da gestire` mostrano soltanto dead-letter ancora azionabili. Un job
fallito resta conservato secondo retention e audit, ma passa allo storico operativo quando una
sincronizzazione completa successiva dello stesso provider ne supera il tentativo; il webhook e
il job derivato rappresentano una sola criticità e non vengono sommati due volte. Un retry manuale
fallito dopo l'ultimo readback riuscito torna invece immediatamente azionabile.

---

## 17. Sicurezza e privacy

### 17.1 Autenticazione

- Due account amministrativi fissi, `Massimo` e `Codex`, con login case-insensitive e identità canoniche di audit distinte.
- I due account condividono tutte le capacità operative tranne le transizioni fiscali irreversibili. Approvazione, numerazione, finalizzazione di un readback manuale che sblocca l'emissione e risoluzione manuale di un match che chiude un ordine o collega rimborsi richiedono `can_approve`, valorizzato soltanto per `Massimo`. L'identità di audit registra chi ha agito, non impedisce l'azione: senza questo controllo un agente potrebbe completare da solo la catena che §19.6 classifica come P0. Il controllo è server-side su ogni mutazione, come previsto da 17.6; nascondere il pulsante non è una protezione.
- `can_approve` è una colonna booleana sui due account fissi, non un sistema di ruoli, e nasce nella migrazione M4 che introduce l'approvazione.
- Username e password, senza secondo fattore applicativo.
- Password di almeno 8 e non oltre 128 caratteri, hashate con `node:crypto.scrypt` e verificate con confronto constant-time.
- Bootstrap unico e atomico: entrambi gli account vengono creati insieme oppure non viene creato nessuno dei due.
- Session cookie `HttpOnly`, `Secure`, `SameSite`.
- Sessioni persistenti indipendenti per ogni accesso e dispositivo, con scadenza fissa a un anno e revoca esplicita. Ogni account può cambiare la propria password confermando quella attuale; il cambio conserva la sessione corrente e revoca tutte le altre. La UI elenca soltanto date affidabili di creazione, ultima attività e scadenza, senza dedurre dispositivo, posizione o IP.
- Rate limiting login.
- CSRF per azioni mutative se il framework non lo copre.

### 17.2 Segreti

- Variabili d'ambiente o file secret non versionato.
- Permessi filesystem minimi.
- Token OAuth rinnovabili e altri segreti applicativi cifrati con AEAD usando una chiave master conservata fuori dal database quando verranno introdotti.
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
- Token helper casuali, revocabili, a scadenza breve e vincolati al batch, mai in query string o log; hostname HF e Aruba verificati contro allowlist esatte. L'ultimo clic automatico richiede una verifica server-side fresca dell'abilitazione e del manifest.
- Sessioni temporanee del preferito separate dai batch, emesse soltanto dal ponte HF autenticato, limitate alla sola lettura/importazione e tecnicamente incapaci di upload o invio; il bearer resta nella memoria del ponte e non viene inviato alla pagina Aruba.

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

- bootstrap degli account, login, logout, cambio password e revoca delle altre sessioni;
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

Non registrare password, token o contenuto completo non necessario.

### 17.6 Confini di fiducia e minacce principali

Confini da trattare come non fidati:

- browser e input dell'amministratore;
- webhook Shopify/eBay, DOM Aruba e file importati;
- helper locale, profilo browser e canale HTTPS helper-HF;
- file XML/PDF e percorsi di storage;
- SMTP e risposte dei provider;
- variabili d'ambiente, secret store e pipeline di deploy;
- backup trasferiti fra VPS e Mac.

Le minacce prioritarie della 1.x sono: invio o numerazione senza approvazione, helper su account o batch errato, furto della sessione browser, duplicazione di fatture/note, perdita o alterazione di documenti, stato remoto incerto, esposizione di dati fiscali nei log e deploy verso il target sbagliato. I controlli minimi sono validazione ai confini, transazioni e vincoli DB, manifest/hash immutabili, kill switch Production, allowlist degli host, profilo browser locale, redazione dei log, preflight del target e readback remoto.

XML, PDF e risposte remote vengono accettati soltanto entro limiti espliciti di dimensione e tempo. Il parser XML rifiuta `DOCTYPE`, entità esterne e strutture oltre i limiti di profondità/numero elementi definiti dal contratto; la validazione XSD non sostituisce questi controlli. I byte firmati di un webhook vengono verificati prima del parsing e nessun parser o decoder riceve input non limitato.

L'autorizzazione viene rivalutata sul server per ogni mutazione usando sessione autenticata, stato DB e transizione ammessa. Parametri di route/query, campi hidden, stato React e schermate nascoste sono input non fidati. Identificativi di provider e account vengono risolti dalla connessione server selezionata, non accettati direttamente dal browser.

In modalità `Automatica dopo conferma`, subito prima del clic Aruba irreversibile l'helper rilegge il manifest da HF, fa ricontrollare al server `ARUBA_SUBMISSION_ENABLED`, stato validato e hash, quindi confronta il riepilogo visibile con documenti e importi attesi. In modalità `Assistita` esegue gli stessi confronti, registra il controllo e si arresta lasciando il clic al titolare. Se il DOM non è riconosciuto, compare un documento inatteso oppure, nella modalità automatica, il server non conferma l'autorizzazione corrente, l'helper si arresta senza cliccare.

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
├── app/
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

L'albero elenca soltanto ciò che il piano governa: cartelle del framework, output di build, cache e file di configurazione degli strumenti nascono dalle convenzioni dello stack e non vanno aggiunti qui. Un file di configurazione di lint o formato esiste solo quando serve a disattivare o modificare un default osservato: senza quel bisogno, gli strumenti restano sui propri default e nessun file viene creato.

Creare cartelle e documenti soltanto quando hanno contenuto reale. `docs/INDEX.md` diventa il catalogo canonico; `docs/brand/brand-foundation.md` è l'unica fonte dell'identità leggera; `README.md` descrive setup e comandi correnti; `AGENTS.md` contiene soltanto regole operative stabili; `CLAUDE.md` contiene solo `@AGENTS.md`; `CONTRIBUTING.md` spiega il flusso pubblico senza concedere diritti di riuso; `SECURITY.md` indica come segnalare privatamente vulnerabilità senza dati reali. Non mantenere copie parallele del Master Plan.

La repository resta **pubblica ma non open source** finché il titolare non approva una licenza e aggiunge `LICENSE`. README e CONTRIBUTING devono dichiarare che la sola visibilità del codice non concede automaticamente permessi di uso, modifica o distribuzione.

### 18.2 Ambienti

Due soli ambienti:

| Ambiente | Uso | Dati e provider |
|---|---|---|
| Development (`dev`) | sviluppo, integrazione e collaudo | fixture e contract test Shopify senza app remota, eBay Sandbox, pagina Aruba sintetica locale, SMTP di test e PoC OCI Email Delivery con destinatario controllato |
| Production (`prod`) | uso reale del titolare | database, storage e credenziali Shopify/eBay/SMTP/infrastruttura sulla VPS; sessione Aruba soltanto nel browser locale |

Non creare uno staging permanente finché un bisogno osservato non giustifica il costo di un terzo database, storage e set di segreti. Development e Production devono avere configurazioni, credenziali dei provider applicabili, database e storage separati; Shopify non ha più un'app Development remota e in locale usa soltanto fixture e contract test, mentre Aruba fa eccezione perché HF non ne conserva credenziali o sessione. Il codice distribuito deriva dallo stesso commit verificato.

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
- prima di aprire la PR di pubblicazione, completare i gate locali applicabili e
  presentare un HEAD coerente e già pronto alla review; un nuovo commit riapre
  la review Codex soltanto per una correzione reale, non per completare lavoro
  prevedibile dopo l'apertura;
- una richiesta affermativa e inequivocabile di pubblicazione autorizza deploy
  Production e release tecniche applicabili; fuori da tale richiesta restano
  avviati dal titolare e separati dal merge.

Un branch `develop` si aggiunge soltanto se compare un ambiente remoto intermedio stabile o più collaboratori rendono insufficiente `main` protetto. La repository pubblica e l'uso da parte di un solo titolare non sono, da soli, motivi per aggiungerlo.

### 18.4 Versionamento e changelog

- `package.json#version` è la fonte canonica della versione applicativa e coincide con il lockfile.
- Durante lo sviluppo locale non serve un bump per ogni PR.
- Quando una modifica runtime viene destinata a una release Production, bump SemVer e voce in `CHANGELOG.md` fanno parte della stessa PR dell'implementazione e precedono il merge. Non aprire una seconda PR di sola versione, changelog o release: se i metadati di release non sono pronti, la PR runtime non è pronta al merge. Una deroga richiede una richiesta esplicita del titolare riferita al caso specifico.
- Ogni release Production usa SemVer, tag `vX.Y.Z`, voce in `CHANGELOG.md`, commit esatto e piano di rollback.
- Ogni voce di changelog descrive il cambiamento osservabile e, per i fix, la causa condivisa corretta; non elenca soltanto file o ticket.
- Modifiche solo documentali non richiedono bump, tag o release.
- Migrazioni applicate sono immutabili; una correzione usa una nuova migrazione.
- Il numero di versione non prova che il deploy sia avvenuto: la ricevuta remota resta separata.

Ogni release Production approvata è pubblicata anche come GitHub Release immutabile:

1. preparare una draft release sul commit e tag candidati già passati dal canary tecnico Production;
2. generare le note dalle PR tramite `.github/release.yml`, poi confrontarle con `CHANGELOG.md` e rimuovere voci non pertinenti;
3. allegare un solo `release-manifest.json` privo di segreti e dati reali, con versione, commit, digest GHCR, versione schema, riferimento all'attestazione e digest di rollback;
4. pubblicare la release soltanto dopo una richiesta affermativa di pubblicazione o un'autorizzazione esplicita separata; per il go-live `v1.0.0`, pubblicazione della GitHub Release e uso Production ordinario restano gate distinti perché costituiscono una nuova attivazione produttiva;
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

La classificazione è deterministica, additiva e fail-closed: parte dai percorsi
modificati, attiva più superfici quando necessario e assegna il gate completo a
un percorso sconosciuto. I contesti richiesti dal ruleset restano stabili; un
check non applicabile conclude esplicitamente senza eseguire setup, dipendenze o
runner costosi. PostgreSQL, E2E, contract test provider e matrice Aruba girano in
job indipendenti e paralleli soltanto quando la relativa superficie è attiva.
La decisione di deploy usa il diff cumulativo fra l'ultimo commit Production
distribuito con successo e il candidato finale: una singola PR docs-only non può
nascondere modifiche runtime precedenti non ancora distribuite.
Ogni superficie usa il check dell'ultimo commit non distribuito che l'ha
attivata: un check no-op su un commit successivo non può mascherare un fallimento,
mentre un fix successivo della stessa superficie sostituisce correttamente il
gate precedente. Dopo il readback riuscito, un deployment tecnico exact-SHA
registra come nuova base il commit realmente installato, anche quando il workflow
manuale è stato avviato da un HEAD di `main` più recente.
Un candidato antenato della base distribuita è invece un rollback deliberato:
la classificazione copre le superfici rimosse, i gate si riferiscono al commit
target e il digest attestato storico viene cercato immediatamente, senza
confondere il percorso con un avanzamento cumulativo. L'orchestrazione resta
quella fidata della revisione del workflow e un preflight blocca il rollback
prima di sostituire container quando lo schema del target non coincide con la
ricevuta Production.

La CI non esegue deploy automatici su merge. Action di terze parti vanno vincolate a commit completi, con permessi minimi, timeout e `concurrency` appropriata. I workflow di verifica possono cancellare run obsoleti; un deploy Production già avviato non viene cancellato da un nuovo push. Dependabot copre npm, GitHub Actions, Dockerfile e Compose e apre PR verso `main`; gli aggiornamenti npm e GitHub Actions minor/patch sono raggruppati e possono essere uniti automaticamente dopo i gate, mentre major, Docker e Compose restano deliberati manualmente.

Il required check `codex-review` riusa il contratto già collaudato in CF Ready invece di introdurre un secondo protocollo:

- all'apertura o al passaggio da draft a ready parte la review automatica senza commenti di richiesta;
- dopo un nuovo commit o per un retry l'agente pubblica una sola riga `@codex review` per l'HEAD corrente;
- il gate accetta soltanto un segnale positivo del reviewer Codex legato allo stesso SHA o un verdetto pulito che dichiari esplicitamente il commit revisionato;
- finding P0/P1 sull'HEAD corrente, inline o top-level, bloccano il merge; P2/P3 restano advisory e non impediscono il gate;
- uno status riuscito è riusabile soltanto per lo stesso SHA; se l'HEAD cambia il gate torna pending;
- il workflow non crea commenti di richiesta: osserva i segnali della review Codex già avviata, pubblica lo status necessario e non esegue codice della PR;
- se usa `pull_request_target`, legge metadati con permessi minimi e può fare checkout soltanto del branch predefinito fidato; non fa checkout, build, installazione, download di artifact o esecuzione di contenuto della PR.

Workflow, script e test sono copie locali degli artefatti canonici comuni alle repository compatibili, senza varianti specifiche per Hub Fatture.

L'auto-merge Dependabot è ammesso soltanto quando tutte le condizioni seguenti sono vere:

- autore verificato `dependabot[bot]` e repository head uguale alla repository corrente;
- ecosistema `npm` o `github-actions` e update type `version-update:semver-patch` o `version-update:semver-minor`;
- tutti i required check della stessa head SHA sono verdi;
- merge squash richiesto con verifica della head corrente; nessuna approvazione automatica;
- Action `dependabot/fetch-metadata` fissata a commit completo;
- l'eventuale `pull_request_target` non esegue checkout, script, build o contenuto della PR e dispone soltanto dei permessi necessari ad abilitare l'auto-merge.

Qualsiasi condizione non riconosciuta lascia la PR aperta per decisione manuale. Il merge su `main` non abilita deploy o release. Riferimento da riverificare allo scaffold: [automazione Dependabot con GitHub Actions](https://docs.github.com/en/code-security/tutorials/secure-your-dependencies/automate-dependabot-with-actions).

Toolchain locale e CI:

- `mise.toml` fissa Node.js e npm risolti in M0 ed è la fonte canonica usata sul Mac e da GitHub Actions; la build Docker usa la stessa patch Node fissata nell'immagine per digest;
- un'eventuale Action Mise è fissata a commit completo; non usare Mise per task, segreti o configurazioni di ambiente che appartengono già a npm e al runtime applicativo;
- `oxlint` e `oxfmt` sono dev dependency a versione esatta e sostituiscono, non affiancano, ESLint e Prettier;
- `npm run lint`, `npm run format` e `npm run format:check` usano rispettivamente `oxlint --deny-warnings .`, `oxfmt --write` e `oxfmt --check`; senza `--deny-warnings` le regole native emettono soltanto warning e il gate non potrebbe fallire; `format:check` fa parte del gate standard;
- la policy toolchain verifica che i pin di Node e npm coincidano fra `engines`, `packageManager`, `mise.toml` e `Dockerfile`, e che nella chiusura di produzione del lockfile non compaiano strumenti di build;
- `npm test` usa `node --test`; lo stesso runner esegue i test d'integrazione contro PostgreSQL reale quando la corsia lo richiede;
- `npm run check` resta il gate locale completo; `check:docs`, `check:standard`
  e le suite DB/provider sono composizioni interne usate dalla CI per applicare
  soltanto le corsie necessarie senza creare un secondo contratto di test;
- partire con le regole native ad alto segnale e senza type-aware linting: `tsc --noEmit` resta la verifica canonica dei tipi; abilitare type-aware solo se copre un difetto reale non intercettato;
- mantenere `doctor.config.json` minimale: blocco locale/CI dai warning in su, controllo supply-chain esterno disabilitato e soli ignore effettivamente necessari.

Riferimenti da riverificare allo scaffold: [Oxlint](https://oxc.rs/docs/guide/usage/linter.html), [Oxfmt](https://oxc.rs/docs/guide/usage/formatter.html) e [Mise per Node/npm](https://mise.jdx.dev/lang/node.html).

React Doctor usa due superfici con responsabilità distinte: `npm run doctor` esegue la scansione completa dalla dipendenza locale fissata e blocca `npm run check` dai warning in su; l'Action ufficiale usa sempre `version: latest`, analizza le modifiche React delle PR con la stessa soglia, esegue la scansione completa sul push runtime a `main` e pubblica soltanto i finding inline, senza commenti riepilogativi quando la scansione è pulita. Un falso positivo non si aggira: l'agente lo segnala nella PR, applica la soppressione nativa più stretta possibile con una motivazione verificabile, la committa e ripete il gate. Il pin npm locale è esatto, l'Action è fissata a commit completo e il controllo supply-chain esterno resta disabilitato perché già coperto dai gate dipendenze. Lo score è informativo e non decide l'esito.

Riferimento da riverificare allo scaffold: [configurazione React Doctor](https://www.react.doctor/docs/configuration).

L'artefatto Production segue una sola corsia:

- GitHub Actions costruisce una sola immagine `linux/arm64` dal commit candidato e la pubblica nel package GHCR pubblico collegato alla repository;
- sul push runtime a `main`, build, scansione e attestazione dell'artefatto
  candidato partono senza accedere a Production e senza effettuare deploy; il
  workflow manuale riusa quel digest verificato e costruisce un fallback
  soltanto se l'artefatto exact-SHA non è disponibile;
- tag SemVer e SHA sono riferimenti leggibili, ma il digest `sha256` è l'identità canonica usata da deploy, ricevuta e rollback;
- l'immagine riceve un'attestazione GitHub di provenienza legata al digest; il deploy la verifica prima del pull;
- nessun segreto o dato reale entra nell'immagine, nei build argument, nei layer o nei metadati;
- l'immagine applicativa finale esegue come utente non-root, contiene soltanto runtime e file necessari e viene sottoposta a scansione delle vulnerabilità prima del canary; `@react-router/node` dichiara `typescript` come peer dependency opzionale, quindi `npm ci --omit=dev` lo installa insieme al binario nativo di piattaforma: il layer finale li rimuove e il gate immagine verifica che nell'artefatto non resti alcun compilatore TypeScript; finding critici/alti raggiungibili bloccano il candidato, gli altri richiedono motivazione e condizione di riapertura;
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
- `CI` come required check aggregatore dei soli job applicabili; il workflow
  separato `React Doctor` è required, conclude esplicitamente quando non
  applicabile e blocca dai warning in su;
- GitHub Environment `Production` protetto, secret scoped, reviewer unico e restrizione a `main`/tag di release;
- package GHCR pubblico collegato alla repository, attestazioni abilitate e nessuna cancellazione automatica dei digest usati in Production o come rollback;
- release immutabili abilitate, `.github/release.yml` minimale e pubblicazione consentita soltanto nel flusso release autorizzato;
- auto-merge Dependabot limitato agli aggiornamenti npm e GitHub Actions minor/patch, senza checkout o esecuzione della PR nel workflow privilegiato;
- workflow da fork senza secret, permessi read-only e nessun checkout di codice esterno sotto `pull_request_target`;
- titoli PR e commit di merge in formato Conventional Commit, verificati dal gate `Foundation`;
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

Il deploy è un'azione separata dal merge. Una richiesta affermativa di
pubblicazione costituisce l'autorizzazione esplicita del titolare; fuori da tale
richiesta serve conferma separata.

Procedura prevista:

1. Workflow manuale e serializzato sul commit/tag candidato già presente in `main`, soggetto all'approvazione del GitHub Environment `Production`; un secondo deploy non cancella quello in corso.
2. Gate locali e CI verdi sullo stesso SHA, verificati da una barriera
   esplicita che attende `CI`, Foundation, CodeQL e React Doctor del commit
   candidato invece di affidarsi all'ordine temporale dei workflow.
3. Preflight di account, VPS, hostname, versione, configurazione proprietaria del target, backup e rollback.
4. Riuso dell'immagine `linux/arm64` exact-SHA già costruita, scansionata e
   attestata in GitHub Actions al merge; build di fallback una volta sola se il
   digest non è disponibile, mentre `web` e `worker` usano lo stesso artefatto.
5. Migrazione DB soltanto se compatibile con versione precedente e successiva; altrimenti finestra di manutenzione e autorizzazione specifica.
6. Verifica dell'attestazione, pull da GHCR e avvio dei nuovi container dal digest esatto; nessuna build sulla VPS.
7. Verifica della baseline Compose: app non-root, nessun container privilegiato, capability eliminate salvo necessità documentata, PostgreSQL su rete interna non pubblicata, filesystem applicativo read-only salvo volumi espliciti e limiti CPU/memoria coerenti con la VPS.
8. Health check.
9. Verifica login, webhook, connessioni e percorso critico applicabile.
10. Readback completo di commit/versione, digest, schema, kill switch e configurazione non segreta effettiva.
11. Registrazione della ricevuta; rollback applicativo compatibile o forward-fix se il check fallisce.

Le migrazioni distruttive richiedono un backup off-host recente verificato, un restore drill valido e autorizzazione. Non alterare o cancellare migrazioni già applicate per rendere possibile un rollback.

Modifiche esclusivamente documentali, di test o di governance con nessuna
differenza runtime dal commit già distribuito terminano dopo merge e rilettura
Git: immagine, deploy e release sono non applicabili. Più modifiche runtime
correlate già assorbite in `main` vengono distribuite insieme una sola volta sul
candidato finale. Prima di un deploy ordinario si verifica la ricevuta del
backup giornaliero; migrazioni o modifiche allo storage richiedono invece un
backup aggiuntivo prima del deploy e una nuova ricevuta coerente dopo il deploy.

### 19.6 Incidenti e kill switch

Classificazione minima:

- **P0:** invio fiscale non autorizzato o duplicato, perdita/corruzione dati, esposizione di segreti o impossibilità di determinare se Aruba ha ricevuto un documento;
- **P1:** import/sync/approvazione indisponibile senza perdita dati o con workaround manuale sicuro;
- **P2:** difetto non bloccante o degradazione minore.

La Production deve avere un kill switch semplice `ARUBA_SUBMISSION_ENABLED=false`: blocca il clic automatico e forza i nuovi batch al percorso assistito/manuale, ma lascia disponibili numerazione autorizzata, export XML, caricamento manuale, consultazione, import e diagnosi. Il valore iniziale resta `false` dopo la qualifica Aruba di M8 e il canary tecnico M9, finché l'uso ordinario non viene autorizzato separatamente. Nessun kill switch separato per ogni funzione finché non emerge un bisogno reale.

Il canary tecnico M9 non approva, numera, carica o invia documenti. Verifica invece sul candidato Production immutabile tutti i gate locali e remoti non fiscali, l'inventario Aruba in sola lettura, l'assenza di batch e upload pendenti, il kill switch, il backup e la continuità operativa. Il primo invio reale futuro non è un requisito di M9 e avviene soltanto dopo la separata autorizzazione all'uso Production ordinario; `ARUBA_SUBMISSION_ENABLED=true` rende disponibile il percorso automatico senza permessi temporanei aggiuntivi.

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

Git contiene solo gli script operativi:

```text
scripts/backup.sh
scripts/restore.sh
```

`scripts/backup.sh` viene eseguito sulla VPS da un timer `systemd`: produce uno snapshot coerente, lo cifra in streaming con il solo destinatario pubblico `age`, carica l'archivio cifrato tramite OCI CLI e Instance Principal limitato al bucket e verifica oggetto, checksum e dimensione tramite readback. Nessun plaintext viene scritto su disco e nessuna credenziale Object Storage statica vive sulla VPS.

Il Mac scarica periodicamente una copia già cifrata in `backups/` dentro il checkout locale canonico `/Users/Matteo/Progetti/Hub-Fatture`, usando una procedura breve nel runbook. La directory è accessibile soltanto al titolare ed è esclusa da Git: il repository versionato non contiene backup, dump, XML o PDF reali. Prima di eliminare, ricreare o pulire il checkout con opzioni che rimuovono i file ignorati, la copia locale deve essere verificata e trasferita in una posizione protetta.

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
- Grafo degli import aciclico e verificato automaticamente; niente barrel interni che nascondano dipendenze fra capacità.
- Route orientate alla composizione: orchestrazione HTTP sostanziale in moduli server adiacenti e controlli UI condivisi in componenti stabili.
- Nessuna facciata di retrocompatibilità interna: dopo un'estrazione i consumatori importano direttamente il nuovo proprietario.
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
- Shopify Partner/Dev, Codex/Claude Code, account Aruba Base e un browser supportato sul computer operativo sono prerequisiti posseduti o gestiti separatamente dal titolare; Safari, Chrome o Edge bastano per l'inventario, mentre l'helper di trasmissione richiede Chrome o Edge. HF non richiede un add-on Aruba a pagamento.
- Se un limite gratuito o una condizione contrattuale cambia, fermarsi e proporre l'alternativa prima di attivare costi.

### 21.7 Politica delle dipendenze

- La matrice in 14.3 è l'elenco iniziale accettato: nessuna scelta di tool o dipendenza resta aperta allo scaffolding, mentre i pin nascono soltanto nel manifest e nel lockfile.
- Pin esatto delle dipendenze dirette e lockfile committato; le versioni transitive sono determinate dal lockfile.
- Node.js e npm risolti in M0 sono fissati in `mise.toml` e riusati in locale, CI e build Docker.
- Installazione riproducibile con `npm ci`.
- Nessuna beta/RC/canary salvo eccezione esplicita e temporanea documentata.
- Dipendenze nuove solo quando piattaforma, standard library o stack già installato non coprono il bisogno in modo semplice.
- `pdfkit` resta assente dal manifest finché HF-O03 non attiva il fallback già selezionato; non valutare una seconda libreria PDF.
- `react-doctor` ha pin esatto; minor e patch seguono i gate automatici comuni, mentre le major restano deliberate; l'Action ufficiale resta bloccante dai warning e fissata a commit completo.
- Oxlint e Oxfmt con pin esatto, aggiornati insieme e senza tool equivalenti mantenuti in parallelo.
- Dependabot settimanale; npm e GitHub Actions minor/patch raggruppati e auto-uniti dopo i required check, major, Docker e Compose deliberati manualmente.
- Audit obbligatorio quando cambiano manifest o lockfile e prima di ogni release.
- Un advisory senza percorso vulnerabile attivo può essere accettato soltanto con motivazione verificabile e condizione di riapertura.

---

## 22. Strategia di test

### 22.1 Test unitari mirati

Usare `node:test` del runtime fissato come unico runner unitario e d'integrazione TypeScript. I test `.ts` rispettano gli stessi vincoli di type stripping degli script locali; non introdurre Vitest, Jest o un secondo runner.

- normalizzazione Codice Fiscale/P.IVA senza inventare il tipo;
- normalizzazione di presentazione field-aware senza alterare ragioni sociali, casing misto intenzionale o snapshot sorgente;
- data ordine in Europe/Rome;
- chiave di raggruppamento;
- conversione stretta delle stringhe decimali esterne in centesimi, inclusi segno, zeri, cifre eccedenti e limiti del dominio DB;
- calcolo riga semplificata;
- mapping fail-closed delle fee Shopify Payments: importo effettivo, valuta, gateway, stato e limiti;
- cambio della regola commissioni con conservazione della fee osservata e ricalcolo delle sole bozze modificabili;
- rimborso Shopify Payments lordo dopo una fattura netta: il dato provider resta invariato e la TD04 è limitata all’importo fatturato per l’ordine;
- differenze importo;
- residuo accreditabile;
- esclusione della nota di credito quando la fattura originaria è scartata;
- cambio trigger senza ricreare bozze esistenti;
- mapping stati esterni;
- generazione XML a partire dalla fixture Aruba.
- classificazione strutturata delle differenze fra sorgente, bozza e proiezione XML.
- limiti degli identificativi `bigint` PostgreSQL e assenza di cicli nel grafo degli import applicativi.

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
- autenticazione username/password, sessioni e separazione dell'identità di audit dei due account.
- l'account privo di `can_approve` non può approvare, numerare, finalizzare un readback manuale o confermare un match manuale con effetti fiscali, nemmeno chiamando direttamente l'endpoint.
- impossibilità di preparare o autorizzare un invio senza approvazione e snapshot immutabile.
- import storico non approvabile prima della riconciliazione Aruba.
- riconciliazione Shopify Payments sul totale fatturabile al netto della fee effettiva quando la regola è attiva; PayPal, metodi manuali ed eBay restano al lordo.
- due browser modificano la stessa bozza/configurazione: la seconda scrittura riceve conflitto.
- comparatore e approvazione usano la stessa revisione e lo stesso hash; una proiezione stale viene rifiutata.
- errore remoto dopo approvazione: snapshot/audit restano coerenti, stato provider non diventa riuscito.
- batch Aruba misto valido/non valido: nessun invio, readback di ogni documento, pulizia degli upload pendenti e retry bloccato fino alla riconciliazione completa.
- evento fuori ordine non fa regredire uno stato provider già riconciliato.
- audit critico assente provoca rollback della transazione, non una transizione priva di prova.
- invio automatico rifiutato quando il kill switch è attivo o batch, manifest, documento, revisione, hash e validazione non coincidono.
- migrazione da database vuoto e da snapshot della release precedente con dati sintetici rappresentativi.

### 22.3 Contract test

Fixture sanificate per:

- Shopify ordine italiano privato;
- Shopify azienda;
- Shopify pagamento pendente;
- Shopify Payments con fee effettiva e Shopify PayPal/manuale senza fee applicabile;
- Shopify rimborso parziale;
- eBay ordine con Codice Fiscale;
- eBay ordine con P.IVA;
- eBay rimborso ambiguo;
- pagina Aruba sintetica: upload ordinario senza challenge, validazione positiva/negativa, login richiesto, challenge di sicurezza post-upload inattesa e DOM inatteso;
- pagina Aruba sintetica: arresto assistito, invio automatico autorizzato e stato incerto;
- file XML/PDF/P7M e notifiche SdI scaricati, sanitizzati e importabili.

Ogni connettore copre anche timeout, risposta oltre il limite, risposta non parsabile, schema inatteso, autenticazione scaduta e rate limit, verificando la traduzione nel codice errore stabile. L'helper copre inoltre hostname inatteso, sessione scaduta, challenge OTP/SMS/CAPTCHA inattesa, locatore assente, documento estraneo e invio non autorizzato. Le fixture rappresentano il payload o DOM minimo realmente osservato, ma sono sanificate e non vengono trattate come prova dello stato live.

### 22.4 End-to-end

1. Login case-insensitive con `Massimo` e con `Codex`, verificando la forma canonica in interfaccia e audit.
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

- sulle PR esegue Chromium soltanto su quattro flussi sintetici: login con entrambi gli account, import fixture, creazione della preparazione fattura e approvazione contro Aruba mock;
- in M8 esegue gli stessi flussi HF e il preferito di sincronizzazione su Chromium e WebKit nel candidato; contro la pagina Aruba sintetica verifica inoltre l'helper di trasmissione con Chrome o Edge su runner macOS e Windows e aggiunge i percorsi completi di stato SdI, e-mail e nota di credito;
- usa locator accessibili e dati sintetici deterministici; nessuna credenziale o informazione reale entra in test, report o trace;
- registra la trace soltanto al primo retry fallito, con retention CI breve di 7 giorni; niente video continui o snapshot visuali finché non esiste una regressione visiva concreta;
- non traccia né automatizza il Canary Production e non aggiunge Firefox finché non emerge un bisogno reale.

Riferimenti da riverificare allo scaffold: [Playwright Trace Viewer](https://playwright.dev/docs/trace-viewer) e [best practice Playwright](https://playwright.dev/docs/best-practices).

### 22.5 Test di sicurezza

- CSRF.
- session fixation.
- rate limit login.
- webhook signature.
- token helper breve e vincolato al batch, rinnovo limitato alle pause umane con durata assoluta massima, allowlist hostname e verifica server-side dell'abilitazione prima dell'invio automatico.
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

Le milestone applicative sono sequenziali. M1-M3 costruiscono l'app senza dipendere da Aruba; M4 incorpora qualifica fiscale, documenti e approvazione; M5 integra pagina sintetica, helper e fallback manuale; M8 qualifica il contratto sul pannello reale prima del Canary Production. Non esiste una corsia Aruba parallela e l'helper non è un progetto iniziale autonomo.

Brand Foundation leggera, comparatore fiscale e PoC/decisione OCI Email Delivery entrano nelle milestone che già possiedono i relativi contratti. Non nasce una milestone intermedia e non si aggiungono un pacchetto design system separato, una libreria di diff XML o due trasporti SMTP paralleli.

Le scelte di tool e dipendenze chiuse nella matrice 14.3 non generano una milestone aggiuntiva: M0 ne verifica compatibilità e lockfile, M1 le usa per le fondazioni, le milestone successive installano soltanto ciò che raggiunge un caso d'uso reale.

Stati ammessi: `non iniziata`, `in corso`, `bloccata`, `completata`. Una milestone è `completata` solo quando deliverable e criteri di uscita hanno evidenze fresche in `docs/evidence/` o in output automatici collegabili. Il riepilogo di chiusura registra commit, versione eventuale, prove, difetti corretti, rischi residui e milestone successiva; non riscrive il contenuto della milestone.

### M0 - Ricognizione e scaffolding readiness

**Stato: completata.** Evidenze ripetibili: [readiness della toolchain](evidence/toolchain-readiness.md), workflow Foundation e readback GitHub della repository protetta.

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
- gate `codex-review` canonico, required e verificato su HEAD stabile, nuovo commit e finding corrente senza eseguire codice PR in contesto privilegiato;
- auto-merge Dependabot configurato fail-closed, senza auto-approvazione né esecuzione del codice PR nel contesto privilegiato; la prova end-to-end è differita a M8 e non blocca M1-M7;
- release immutabili abilitate e categorie minime di `.github/release.yml` definite senza creare una release anticipata;
- React Doctor completo bloccante nel gate locale e sul push runtime a `main`,
  con Action ufficiale bloccante dai warning sulle modifiche React delle PR;
- Playwright configurato con Chromium, smoke sintetico e trace solo al primo retry;
- comando locale canonico e CI essenziale verificati;
- preflight provider disponibile prima della prima scrittura remota;
- nessun accesso di produzione richiesto in chat.

### M1 - Fondazioni locali

**Stato: completata.** Evidenze ripetibili: [fondazioni locali](evidence/local-foundations.md), gate canonico, migrazioni PostgreSQL ed E2E sintetico.

Output:

- repository;
- monolite React Router su Node.js secondo la matrice 14.3;
- PostgreSQL con `pg` e SQL parametrizzato secondo la matrice 14.3;
- migrazioni SQL append-only applicate dal runner compilato con advisory lock e checksum;
- test installazione vuota e upgrade da snapshot rappresentativo;
- Docker Compose locale;
- autenticazione username/password case-insensitive per gli account fissi canonici `Massimo` e `Codex`;
- limiti di body e timeout comuni applicati prima di parsing/buffering, con errori stabili e test minimi;
- Brand Foundation leggera approvata, con fonte unica e asset minimi versionati;
- registro errori stabile e inventario segreti senza valori;
- CI essenziale.

### M2 - Dominio ordini e preparazione fattura

**Stato: completata.** Evidenze ripetibili: [dominio ordini e preparazione fattura](evidence/order-domain.md), contratto tecnico, migrazioni PostgreSQL ed E2E sintetico.

Output:

- schema ordine/cliente/raggruppamento interno;
- import fixture;
- trigger globale;
- raggruppamento giornaliero;
- UI Ordini con viste operative e dettaglio Preparazione fattura;
- UI Clienti con ricerca, vista Da verificare e dettaglio dei collegamenti operativi;
- audit.
- contratto tecnico corrente per fonti autorevoli, transazioni e concorrenza riusato dalle milestone successive.

Gate:

- due ordini concorrenti dello stesso cliente e giorno producono una sola preparazione fattura, provato da un test d'integrazione su PostgreSQL reale;
- un ordine non può appartenere a due preparazioni e l'identità ambigua non accorpa;
- il cambio del trigger globale non ricrea, non scioglie e non riapre bozze esistenti, e i soli ordini rivalutati sono quelli ancora privi di bozza;
- una preparazione da verificare si chiude correggendo l'anagrafica dentro l'applicazione, senza dipendere da una modifica alla piattaforma sorgente;
- la stessa identità fiscale importata da Shopify ed eBay compare una sola volta in Clienti, mentre un’identità incerta resta separata e ricercabile in Da verificare;
- nessun identificativo visibile contiene la sigla interna.

### M3 - Connettori Shopify ed eBay

**Stato: completata.** Evidenze ripetibili: [connettori Shopify ed eBay](evidence/connectors.md), contract test dei provider, migrazioni PostgreSQL e gate canonico.

Output:

- OAuth;
- versioni/endpoint API supportati fissati nei contratti con finestra di supporto e verifica periodica;
- webhook/sync;
- tax ID;
- pagamenti/evasioni;
- rimborsi;
- anteprima dell'import storico di 7 giorni in modalità prudenziale; esecuzione reale rimandata al go-live.

Gate:

- versione API e finestra di supporto di ogni connettore fissate nel contratto, senza alias `latest` nel runtime;
- webhook duplicato, fuori ordine e con firma non valida gestiti senza duplicare ordini o documenti;
- timeout, risposta oltre limite, risposta non parsabile, schema inatteso, autenticazione scaduta e rate limit tradotti nei codici stabili del registro errori;
- HF-O04 e HF-O05 chiusi su payload reali o sandbox, con fixture anonimizzate versionate.

### M4 - Documenti e approvazione

**Stato: completata.** Evidenze ripetibili: [audit Aruba e profilo FatturaPA](evidence/aruba-fatturapa-profile.md), fixture anonimizzate, golden test, migrazioni PostgreSQL e gate canonico.

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
- storage immutabile.

Gate:

- HF-O01 e HF-O02 chiusi, cavallo d'anno incluso; golden test verde sulla fixture anonimizzata dell'XML accettato;
- numerazione atomica provata sotto concorrenza, con unicità `(series, fiscal_year, fiscal_number)` imposta dal DB e verificata anche in assenza di sezionale, dove la serie usa il valore canonico e non `NULL`;
- un account privo di `can_approve` non approva e non numera, nemmeno chiamando l'endpoint direttamente;
- proiezione stale rifiutata al submit e documento approvato non più modificabile.

### M5 - Integrazione Aruba e helper locale

**Stato: completata.** Evidenze ripetibili: [integrazione Aruba locale](evidence/aruba-helper.md), pagina sintetica, contract test, migrazione PostgreSQL, helper multipiattaforma e gate canonico.

Prerequisito: M4 completata. La qualifica del pannello reale è deliberatamente differita a M8 e non autorizza invii reali. Fino al suo superamento i locatori restano candidati e `ARUBA_SUBMISSION_ENABLED=false` resta obbligatorio in Production.

Output:

- mapping stati, limiti di upload, locatori minimi e percorso manuale derivati dall'audit read-only e verificati contro la pagina sintetica;
- pagina Aruba sintetica locale per test deterministici;
- helper TypeScript/Playwright unico per Windows e macOS con Chrome o Edge;
- upload ordinario senza SMS e pause sicure per login o challenge inattese;
- upload e validazione visibile tramite UI;
- modalità `Assistita` e `Automatica dopo conferma`;
- manifest, validazione e kill switch verificati prima dell'ultimo clic;
- readback/import di stati, notifiche, XML, P7M e PDF;
- fallback manuale completo;
- recovery senza retry cieco dopo stato incerto;
- parser XML/PDF e output del pannello limitati e testati contro input ostili o eccessivi;
- XML candidato verificato localmente e pronto per la prova manuale controllata di M8.

Gate:

- helper verde sui due sistemi operativi contro la pagina sintetica; HF-O06 resta assegnato al gate M8 senza bloccare M5-M7;
- mismatch di batch, manifest, documento, revisione o hash e kill switch attivo non autorizzano l'ultimo clic;
- stato incerto fail-closed, con riconciliazione obbligatoria prima di ogni nuovo tentativo;
- percorso manuale completo eseguito end-to-end senza helper;
- nessuna credenziale, cookie, sessione o OTP Aruba raggiunge HF, verificato sui log e sulle evidenze;
- contratto del pannello reale esplicitamente candidato fino alla prova M8, senza accesso, upload o invio implicati dalla chiusura tecnica di M5.

### M6 - Note di credito ed e-mail

**Stato: completata.** Evidenze ripetibili: [note di credito ed e-mail](evidence/credit-notes-email.md), prove PostgreSQL, E2E sintetico e PoC OCI Email Delivery. HF-O07 è chiusa su `OCI_EMAIL_DELIVERY` come unico trasporto canonico, con volume massimo stimato di 500 copie mensili rispetto al margine prudenziale di 2.500.

Output:

- cumulazione rimborsi;
- TD04;
- TD04 instradato nello stesso manifest, nelle stesse due modalità helper e nello stesso fallback manuale delle fatture;
- precondizione DNS di 12.5 verificata e, solo se soddisfatta, PoC OCI Email Delivery con dati sintetici e confronto con il provider esistente;
- un solo trasporto SMTP canonico configurato e HF-O07 chiuso con la relativa motivazione;
- modalità automatica dopo l'esito SdI che conferma l'emissione e modalità manuale;
- reinvio.
- superficie `Impostazioni` riorganizzata senza duplicare il contratto e-mail: Profilo e sicurezza, stato dei servizi e configurazioni M6 condividono la stessa pagina, mentre errori e retry restano in `Attività`.

Gate:

- stesso rimborso mai contabilizzato due volte e somma delle note mai superiore alla fattura, imposte da vincoli DB;
- nessuna nota di credito per fattura scartata o non emessa;
- rimborso eBay non riconciliabile con certezza blocca in `NEEDS_REVIEW` invece di indovinare;
- la copia automatica parte soltanto dopo un esito SdI che conferma l'emissione, `DELIVERED` o `NOT_DELIVERED`, e mai su `REJECTED` o stato incerto;
- un fallimento e-mail non altera lo stato fiscale del documento e resta reinviabile.

### M7 - Produzione su OCI

**Stato: completata.** Evidenze ripetibili: [Production OCI](evidence/production-oci.md), workflow Production, smoke autenticato, rollback applicativo reale e restore drill isolato.

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

Gate:

- preflight che rifiuta il target sbagliato, provato in ambiente non produttivo;
- ricevuta di deploy con commit, digest, versione schema e configurazione non segreta riletta;
- rollback all'artefatto precedente eseguito e verificato, non soltanto documentato;
- restore drill superato da una macchina priva dei segreti della VPS originaria;
- `ARUBA_SUBMISSION_ENABLED=false` verificato tramite readback dopo il deploy.

Richiede autorizzazione esplicita prima del deploy.

### M8 - Collaudo e release candidate

Output:

- deploy del candidato sullo stesso SHA e digest destinati alla `1.0.0`, con creazione dei permessi ordinari per il clic automatico bloccata (`ARUBA_SUBMISSION_ENABLED=false`);
- readback operativo che conferma l'assenza di documenti approvati o trasmissibili e di upload Aruba pendenti;
- import reale degli ultimi 7 giorni e riconciliazione con Aruba senza numerare o trasmettere;
- inventario provider-first di tutte le fatture e TD04 dell'anno fiscale corrente, esteso fino al più remoto ordine riconciliabile e ai documenti precedenti non terminali, acquisito completamente al primo avvio e poi aggiornato con sovrapposizione incrementale, deduplicato rispetto ai documenti HF, con documenti esterni non collegati e match ambigui nelle code previste;
- sincronizzazione dell'inventario Aruba indipendente dalle preparazioni TD01, con stato globale consumato dalle approvazioni singole e massive senza avviare preflight per fattura; preflight on-demand TD04 mantenuto nel suo flusso separato;
- readback manuale guidato capace di sostituire una scansione fallita soltanto dopo acquisizione di ogni riga di tutti gli stream o di un export ufficiale completo, import delle evidenze richieste e ricevuta finalizzata dal titolare;
- gate server-side TD01 che avvisa dopo un'ora e blocca approvazione/numerazione se Aruba non è mai stato letto, ha più di 24 ore o presenta uno stato remoto incerto, senza override nella preparazione;
- prova manuale controllata sul pannello Aruba reale con XML sintetico o anonimizzato dedicato: autenticazione umana, caricamento, validazione e riepilogo osservati, arresto prima di `Invia`, readback e rimozione sicura dell'upload pendente;
- contratto definitivo dei locatori, limiti, pause di autenticazione, download e stati aggiornato insieme a helper e test se il pannello reale diverge;
- test end-to-end HF completi su Chromium e WebKit e test helper contro la pagina Aruba sintetica su Windows/macOS con Chrome o Edge, oltre a recovery, sicurezza e migrazioni;
- comparatore fiscale verificato su fattura e TD04, inclusi proiezione stale, modifiche manuali e arrotondamenti;
- trasporto SMTP canonico verificato end-to-end con ricevuta e reinvio;
- audit trasversale del codice corrente in `docs/audits/release-candidate-review.md`, concentrato su transazioni/concorrenza, duplicazioni, webhook/job interrotti, stato locale/provider, migrazioni/rollback, autorizzazioni server-side, dati fiscali e azioni irreversibili;
- runbook operativo;
- `docs/runbooks/release-readiness.md` compilato come record candidato corrente con prove fresche e rischi residui;
- attestazione del digest verificata, gate `Production` osservato, allarmi OCI e monitor HTTP esterno in stato sano;
- scansione dell'immagine candidata senza finding critici/alti raggiungibili aperti;
- backup OCI giornaliero osservato, copia cifrata sul Mac e RPO effettivo registrato;
- auto-merge Dependabot verificato end-to-end sul primo aggiornamento reale npm o GitHub Actions minor/patch idoneo oppure, se non si presenta, su una patch sintetica verso un branch base temporaneo protetto dagli stessi required check e abilitato esplicitamente nei workflow; in ogni caso prima della release Production e senza alterare i pin di `main`;
- approvazione del titolare per accedere al canary.

Gate:

- prova Aruba reale di §11.4 superata con evidenza sanitizzata e HF-O06 chiuso; senza questa prova M8 resta aperta e M9 non può iniziare;
- nessun P0/P1 o decisione bloccante aperta;
- ogni finding dell'audit ha prova, severità e stato corrente; P2/P3 residui hanno accettazione e condizione di riapertura;
- nessun ordine storico approvabile senza riconciliazione;
- nessuna preparazione approvabile quando l'inventario Aruba è assente, bloccante o incerto; la Dashboard non combina `Mai letto` con `Tutto sotto controllo`;
- nessuna approvazione TD01 quando lo stato globale dell'inventario è assente, scaduto oltre 24 ore, fallito o contiene match, conflitti o stati incerti bloccanti; l'avviso fra una e 24 ore resta non bloccante;
- prima scansione completa della finestra rilevante, successivi aggiornamenti incrementali con sovrapposizione e ritorno automatico al completo per nuovi stream, cursori assenti o incongruenze; lease concorrente, matching prudenziale, riconciliazione parziale multi-ordine, ownership file/notifiche e sessione read-only verificati senza capacità di upload o invio;
- TD04 esterne emesse collegate atomicamente ai rimborsi coperti, con concorrenza incapace di generare un secondo accredito;
- documento esterno scartato conservato come tentativo senza chiudere l'ordine, consumare l'unicità di emissione o impedire una nuova revisione;
- `ARUBA_HISTORY` creato soltanto per `DELIVERED`/`NOT_DELIVERED`; intermedi, scarti e incerti conservati esclusivamente nell'inventario/file remoti;
- fallback manuale verificato capace di chiudere un errore operativo soltanto dopo inventario integrale riga per riga o export ufficiale completo, senza superare errori documentali, stati incerti o match irrisolti;
- account `Codex` rifiutato server-side sulla finalizzazione del readback manuale e sulle risoluzioni manuali con effetti fiscali;
- commit, digest, schema, backup, rollback e kill switch verificati;
- nessun documento approvato o trasmissibile e nessun upload Aruba pendente;
- prova end-to-end dell'auto-merge Dependabot chiusa senza auto-approvazione né esecuzione privilegiata del codice PR; qualsiasi esito non riconosciuto ha lasciato la PR aperta e gli eventuali branch, regole e trigger temporanei sono stati rimossi dopo la prova;
- nessun invio Aruba reale eseguito in questa milestone.

### M9 - Canary tecnico Production

Output:

- candidato Production identificato da commit, versione, digest immagine e schema esatti;
- backup fresco verificato prima della prova e ripristinabilità già qualificata;
- inventario Aruba completo in sola lettura, senza match potenziali o verifiche irrisolte per ordini Shopify/eBay; i documenti esterni privi di riferimenti espliciti e match compatibili restano visibili e non bloccanti;
- Dashboard e Impostazioni coerenti con l’attività reale dell’helper e dell’inventario;
- `ARUBA_SUBMISSION_ENABLED=false`, nessun documento approvato o numerato per la prova, nessun batch o upload Aruba aperto;
- gate locali, CI, helper multipiattaforma, deploy, health, rollback e readback Production verdi;
- ricevuta tecnica sanitizzata con commit, digest, schema, backup, inventario, code e stato finale del kill switch.

Gate:

- nessuna fattura o nota di credito reale selezionata, approvata, numerata, caricata o inviata;
- nessuna e-mail reale generata;
- `ARUBA_SUBMISSION_ENABLED=false` rimasto invariato e nessuna sessione helper con capacità di scrittura attiva;
- profilo browser Aruba persistente conservato e sessione read-only riutilizzabile, senza richiedere login aggiuntivi per la chiusura;
- nessun P0/P1, nessuno stato remoto incerto e nessuna verifica Aruba irrisolta; i soli documenti esterni senza candidati locali non costituiscono una verifica;
- record di readiness aggiornato con prove live riferite al candidato esatto.

Il canary M9 termina deliberatamente prima di qualunque mutazione fiscale. Il primo invio reale appartiene all’uso Production ordinario successivo e richiede l’autorizzazione separata prevista per M10; non esistono permessi monouso o eccezioni pilota. Se il canary tecnico richiede una modifica di codice, immagine, schema o configurazione operativa, il candidato cambia e va ripetuta almeno la parte interessata.

### M10 - Go-live e `1.0.0`

Output:

- approvazione finale del titolare sulla ricevuta canary e sui rischi residui;
- runbook operativo;
- `docs/runbooks/release-readiness.md` finalizzato con prove fresche e rischi accettati;
- draft GitHub Release completata con note verificate e `release-manifest.json` sanitizzato;
- tag e GitHub Release immutabile `v1.0.0` pubblicati sullo stesso commit e digest superati dal canary;
- abilitazione dell'uso Production ordinario;
- monitoraggio rafforzato della prima giornata operativa, inclusa freschezza dell'inventario Aruba e coda dei documenti da collegare.

Richiede autorizzazioni esplicite e separate per release e uso Production ordinario. Il canary non le implica.

---

## 24. Sequenza di implementazione

Questa sezione dà soltanto l'ordine dei lavori dentro ciascuna milestone. Cosa produrre è nei deliverable e nei gate di §23; le condizioni da provare prima di ogni passaggio irreversibile sono nelle checklist di §28; il comportamento richiesto è nelle sezioni di merito. Non ripetere qui requisiti che vivono già altrove: un elenco parallelo entra in drift alla prima modifica.

Ogni task lascia un check eseguibile. Evitare scaffolding non usato: una tabella, una rotta o un modulo nascono nella milestone che li usa davvero.

### Fondazioni - M0/M1

Repository e documenti minimi, poi il monolite React Router sulla toolchain risolta in M0, poi `mise.toml`, TypeScript strict, Oxlint e Oxfmt. Quindi Compose locale con immagini per digest, livello dati `pg` con runner di migrazioni, configurazione validata all'avvio, health check. Infine i gate: `node:test`, Playwright con Chromium, comando locale canonico, CI, protezioni GitHub e `codex-review` canonico. In parallelo la Brand Foundation leggera e la messa in sicurezza della key VPS come blob `age`.

### Autenticazione - M1

Bootstrap atomico dei due account fissi, hash e login con `node:crypto`, sessioni React Router persistite in PostgreSQL, rate limiting e audit del login. Poi protezione di tutte le rotte e limiti condivisi di body, timeout e dimensione risposta applicati prima di parsing e buffering.

### Modello dati - M2 e successive

Le tabelle nascono nella milestone che le usa, nell'ordine delle dipendenze: connessioni e cursori, ricevute webhook con lease, clienti, ordini con righe e tax ID, pagamenti, preparazioni fattura, documenti, rimborsi, submission Aruba e notifiche, storage objects, coda job, audit events. Vincoli di unicità e lock come in §14.5 e §15.2, non aggiunti dopo.

### Dominio ordini - M2

Normalizzatore comune, validazione EUR, trigger globale, chiave giornaliera `Europe/Rome`, matching cliente prudente, raggruppamento atomico, annullamento senza documento, righe semplificate, riconciliazione del totale interno.

### UI operativa - M2 e M4

Prima catalogo italiano, glossario e fondazione UI, poi Dashboard, ordini, Clienti con dettaglio dei collegamenti, preparazioni fattura, editor cliente e righe, `Non trasmettere`. Approvazione, comparatore fiscale, conferme eccezionali e approvazione massiva arrivano in M4 con il generatore che alimentano. Registro attività e pannello errori chiudono la superficie operativa. L'accessibilità delle azioni critiche si verifica insieme alla schermata, non in coda.

### Connettori - M3

Per Shopify: app custom, versione GraphQL fissata nel contratto, OAuth e storage token, scope e protected customer data, query ordine, mapping dei campi localizzati su ordine reale, fallback tax ID, verifica firma webhook sui byte originali, ingest idempotente con lease, sync periodico di recupero, annullamenti e rimborsi.

Per eBay: Sandbox e Production con endpoint e deprecazioni registrati, OAuth con refresh, `getOrders` incrementale, dettaglio `getOrder`, mapping `buyer.taxIdentifier` da payload reale, pagamenti e fulfillment, rimborsi con controllo di ambiguità, polling con cursore e sovrapposizione.

### Documenti e approvazione - M4

Audit Aruba e fixture anonimizzata, profilo fiscale e numerazione versionati, generatore XML per fattura e poi per TD04 con lo stesso builder e profilo, validazione `xmllint` con i limiti di parsing di §17.6, numerazione atomica, snapshot immutabile e hash, `can_approve` sulle transizioni irreversibili.

### Integrazione Aruba e helper - M5

Pagina Aruba sintetica e contratto candidato dei locatori derivati dall'audit read-only, helper unico per Windows e macOS, pause umane e allowlist, upload con lettura della validazione e arresto assistito, manifest immutabile e verifica dell'abilitazione automatica, stato incerto fail-closed con readback e import dei file ufficiali, export XML e procedura manuale completa. M5 si chiude sulle prove locali e multipiattaforma; la qualifica del contratto sul pannello reale resta il gate M8 previsto in §11.4.

### Note di credito ed e-mail - M6

Ingest del rimborso completato, bozza TD04 cumulativa, residuo accreditabile, nuova bozza dopo l'emissione, blocco per fattura scartata, UI dedicata. Sul fronte e-mail: precondizione DNS di §12.5, scelta del trasporto canonico, configurazione Nodemailer, template italiano, modalità automatica dopo l'esito SdI e manuale, stato ed errore con reinvio. La stessa tranche consolida la pagina `Impostazioni`: il menu rapido rimanda a `Profilo e sicurezza`, la configurazione e-mail riusa il contratto M6 e le azioni operative restano in `Attività`.

### Produzione e continuità - M7/M10

Compose di produzione e Caddyfile, Dynu e IP, firewall e hardening SSH, GitHub Environment `Production`, workflow di build e pubblicazione su GHCR con attestazione e scansione, pull per digest senza build remota. Poi monitoraggio: plugin OCI, Notifications, i quattro allarmi, monitor HTTP esterno, rotazione log. Quindi continuità: `backup.sh` con timer e readback, `restore.sh` con conferma distruttiva, restore drill senza i segreti originari. Infine runbook, `.github/release.yml` con immutabilità, import storico riconciliato, collaudo M8, audit trasversale con correzione delle cause condivise, canary tecnico e record di readiness. Deploy, pubblicazione della release e uso Production ordinario restano autorizzazioni distinte come richiesto da §28 e §31; §26 elenca soltanto le classi di azione per cui fermarsi.

### Collaudo e qualifica Aruba - M8

Distribuire il candidato con kill switch attivo, riconciliare lo storico e completare i test trasversali. Implementare inoltre in tranche isolate il piano [aruba-inbound-reconciliation.md](plans/aruba-inbound-reconciliation.md): inventario provider-first, sessione helper read-only, matching, gate server-side e UI sulle superfici esistenti. Soltanto dopo autorizzazione specifica eseguire le letture del pannello reale, senza inviare: il login e qualunque challenge inattesa restano umani, l'upload dedicato viene validato, riletto e rimosso. Qualunque divergenza aggiorna contratto, helper e test prima di chiudere M8 e accedere al Canary Production.

---

## 25. Import storico e anti-duplicazione

### 25.1 Import iniziale

Al primo collegamento, proporre come default gli ultimi sette giorni calcolati rispetto all'attivazione del connettore, con possibilità di modificare la data prima dell'avvio.

Importare ordini creati o aggiornati nel periodo, inclusi annullamenti e rimborsi collegati.

Separatamente dall'import ordini, la prima sincronizzazione Aruba acquisisce tutte le fatture e TD04 dell'anno fiscale corrente e si estende fino al più remoto ordine ancora riconciliabile; continua inoltre a rileggere i documenti non terminali degli stream precedenti. Le sincronizzazioni successive sono incrementali con overlap e non dipendono dall'esistenza di batch HF. Questa lettura reale richiede autorizzazione specifica e non abilita upload o invii.

### 25.2 Stato prudenziale

Poiché l'app precedente non ha scritto tag, note o numeri nelle piattaforme, gli ordini storici devono partire in:

`LEGACY_BILLING_REVIEW`

Non renderli approvabili finché non sono confrontati con l'elenco documenti Aruba.

### 25.3 Strategia di confronto

Dopo l'audit Aruba, usare i dati disponibili:

- riferimento ordine in descrizione/causale;
- data;
- cliente;
- totale;
- per Shopify Payments, commissione effettiva osservata e totale fatturabile secondo l'impostazione valida per l'ordine non ancora chiuso;
- numero documento;
- eventuale metadata.

Se il matching non è univoco, richiedere conferma manuale. Non considerare il solo totale una prova.
L'assenza del riferimento esplicito non impedisce il collegamento soltanto quando provider,
data, destinatario e totale fatturabile individuano un unico ordine storico aperto; un marker
di un marketplace diverso o qualsiasi collisione mantiene l'ordine non riconciliato.

Per registrare l'esito “già fatturato”, acquisire anche l'XML ufficiale della fattura Aruba, verificarne profilo, numero e riferimento all'ordine quando presente oppure l'insieme univoco delle altre prove, quindi conservarlo come documento storico immutabile. La sola nota testuale non chiude il confronto quando esistono rimborsi post-emissione, perché la TD04 deve riferire la fattura originaria.

La modalità di pagamento presente nell'XML è documentale: validarla fra i valori supportati e conservarla sul documento storico, senza confonderla con il metodo predefinito del profilo fiscale né con la regola separata sulle commissioni del marketplace.

Il confronto dell'importo usa il totale fatturabile canonico: per Shopify Payments, con modalità `Sottrai`, equivale al totale ordine meno la somma delle sole `OrderTransaction.fees.amount` riuscite e validate. Se le fee sono nella valuta di presentazione, la somma viene convertita e arrotondata una sola volta nella valuta negozio esclusivamente con `settlementCurrencyRate`, dopo aver verificato coerenza fra valuta delle fee, `amountSet.presentmentMoney`, `settlementCurrency` e valuta ordine; non si interrogano cambi esterni. Per ogni altro metodo il totale fatturabile equivale al totale ordine. Eventuali rimborsi completati prima della fattura vengono sottratti successivamente. Un importo Aruba diverso resta non riconciliato e quindi non approvabile.

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

- deploy o release non già autorizzati da una richiesta affermativa di
  pubblicazione;
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
| Sessione Aruba scaduta o challenge OTP/SMS/CAPTCHA inattesa | Intervento umano durante il batch | Profilo browser locale persistente, pausa esplicita e nessun tentativo di bypass |
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
| Il design system interno cresce in un pacchetto separato | Ritardo e manutenzione senza valore operativo | Un documento, token CSS, componenti locali, un SVG canonico e soli asset richiesti; niente sito, webfont, Storybook o libreria proprietaria |
| Stato upload/invio incerto | Doppio invio | Manifest/hash, ricerca nel pannello, confronto del file scaricato e nessun retry automatico |
| L'agente completa una transizione fiscale irreversibile | Emissione o riconciliazione fiscale senza decisione umana | `can_approve` soltanto su `Massimo`, controllo server-side su approvazione, numerazione, permessi, readback manuale e match manuali fiscali, verificato chiamando gli endpoint direttamente |
| Canary lascia aperti gli invii | Trasmissione fiscale non autorizzata | Kill switch globale sempre `false`, nessun batch di scrittura e verifica live del flag |
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
5. Completare in M4 l'audit autenticato previsto in 11.1; in M5 sviluppare e verificare pagina sintetica, helper e controlli locali; in M8 eseguire la prova reale autorizzata di 11.4 come gate finale prima del Canary Production, senza effettuare invii.
6. Eseguire test, typecheck e build dopo ogni milestone.
7. Fuori da una richiesta affermativa di pubblicazione, fermarsi per
   autorizzazione prima di deploy o release; fermarsi sempre prima di invii reali
   o migrazioni distruttive.

Decisioni di naming, formattazione, struttura interna delle cartelle e dettagli d'implementazione entro la matrice 14.3 spettano all'implementatore. ORM, runner, builder XML, client SMTP, rappresentazione del denaro, logger, toolchain e immagini base non sono più scelte aperte. Se incontra due volte lo stesso problema, deve correggerne la causa condivisa e aggiungere il più piccolo test di regressione.

### Materiali che arriveranno dal titolare

- disponibilità del titolare per la sessione presidiata di audit del pannello Aruba prevista in 11.1;
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
- [ ] Pianificare in M1 la Brand Foundation e il design system interno leggero, senza pacchetto separato, sito o asset speculativi.
- [ ] Dichiarare repository pubblica ma non open source; non aggiungere `LICENSE` senza decisione esplicita.
- [ ] Configurare protezione `main`, template PR, vulnerabilità private, Dependabot e auto-merge degli aggiornamenti npm e GitHub Actions minor/patch senza auto-approvazione; lasciare disabilitati Issues, Discussions e Projects rivolti alla community; adattare da CF Ready `codex-review` exact-HEAD e verificarlo su un nuovo commit.
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

### Prima di completare M5

- [ ] M4 completata con XML candidato immutabile.
- [ ] Pagina Aruba sintetica, fixture dei file ufficiali e contratto candidato derivati dall'audit read-only e dai documenti anonimizzati.
- [ ] Percorso assistito, automatico e manuale verificato localmente, inclusi fail-closed, readback, pulizia e kill switch.
- [ ] Gate reale assegnato esplicitamente a M8, con locatori ancora candidati e `ARUBA_SUBMISSION_ENABLED=false` obbligatorio in Production.

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

### Prima di completare M8 e avviare il Canary Production

- [ ] Import storico di 7 giorni riconciliato con Aruba.
- [ ] Inventario di fatture e TD04 Aruba dell'anno fiscale corrente completato e deduplicato, con cursore e overlap verificati.
- [ ] Nuovo avvio dell'helper verificato su inventario già popolato: la finestra completa comprende ordini riconciliabili a cavallo d'anno e documenti precedenti non terminali, mentre i file invariati non vengono riscaricati.
- [ ] Sessione helper di sola sincronizzazione, legata al dispositivo, revocabile e limitata a 8 ore verificata incapace di upload o invio; una sola scansione concorrente anche da due dispositivi.
- [ ] Readback manuale completo verificato dopo helper indisponibile o scansione fallita: ogni riga di tutti gli stream/pagine o export ufficiale completo acquisiti, evidenze richieste importate, ricevuta `MANUAL` finalizzata dal solo titolare e sessione fallita conservata.
- [ ] Dashboard, approvazione e numerazione TD01 rispettano `Mai letto`, avviso a un'ora e blocco a 24 ore/stato incerto; la preparazione non offre override e rimanda la correzione dello stato globale a Dashboard o Impostazioni.
- [ ] Ogni approvazione TD01, anche massiva, rilegge lo stato globale dell'inventario; inventario assente, oltre 24 ore, fallito o con match, conflitti o stati incerti blocca la mutazione senza introdurre un passaggio Aruba nella preparazione. Il preflight on-demand TD04 resta verificato separatamente.
- [ ] Deduplicazione confinata per account/ambiente, ownership esclusiva submission/remote document dei file/notifiche e mapping monotono degli stati verificati.
- [ ] I documenti Aruba senza ordine Shopify/eBay restano visibili in `Documenti → Da collegare` senza creare ordini; soltanto riferimenti espliciti incompatibili, match potenziali, ambiguità, conflitti ed errori compaiono anche in `Da verificare` e `Attività`.
- [ ] Match emesso su un solo ordine di una preparazione multi-ordine invalida la bozza corrente, esclude il solo ordine coperto e rigenera atomicamente i residui; un errore non lascia stati parziali.
- [ ] TD04 esterna `DELIVERED`/`NOT_DELIVERED` collega atomicamente tutti e soli i rimborsi coperti e una corsa concorrente non può creare una seconda nota per gli stessi rimborsi.
- [ ] Documento esterno `REJECTED` conserva XML, match e audit ma non chiude l'ordine come fatturato, non consuma il residuo e consente la revisione/riedizione prevista.
- [ ] `REJECTED`, `SUBMITTED`, `SDI_PROCESSING` e stati incerti non creano righe `documents`/`ARUBA_HISTORY`; XML e notifiche restano collegati al remote document fino a un esito emesso.
- [ ] Account `Codex` non può finalizzare il readback manuale né confermare un match manuale che chiude ordini o collega rimborsi, anche chiamando direttamente gli endpoint.
- [ ] Nessun ordine storico approvabile senza verifica.
- [x] Account Aruba confermato senza 2FA e con protezione OTP su **Carica Fatture** disattivata; l'helper non presume un SMS ordinario e resta fail-closed davanti a challenge inattese.
- [x] Autorizzazione specifica ottenuta per la sola prova controllata.
- [x] Fattura sintetica validata sulla pagina locale e caricamento controllato sul pannello reale completato.
- [x] Validazione, riepilogo e controllo finale osservati; prova arrestata prima di `Invia`, upload rimosso e assenza confermata dal readback, con evidenza sanitizzata.
- [x] Contratto dei locatori, helper e test aggiornati insieme per ogni divergenza del pannello reale; HF-O06 chiuso.
- [x] Nota di credito sintetica validata sulla pagina locale; se non è disponibile un TD04 già accettato, TD04 valido dedicato caricato in modo controllato sul pannello reale, arrestato prima dell'ultimo clic e ripulito senza invio.
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
- [ ] Candidato canary tecnico identificato da commit e digest, con `ARUBA_SUBMISSION_ENABLED=false` verificato e invio automatico testato contro flag disattivato, mismatch e stato non validato.

### Canary Production

- [ ] Nessuna fattura o nota di credito reale selezionata, approvata, numerata, caricata o inviata.
- [ ] Nessun documento approvato, batch di scrittura o upload Aruba pendente.
- [ ] Backup immediatamente precedente verificato.
- [ ] `ARUBA_SUBMISSION_ENABLED=false` verificato prima e dopo la prova, senza eccezioni pilota.
- [ ] Inventario Aruba in sola lettura completo e senza riferimenti espliciti incompatibili, match potenziali, ambiguità, conflitti, errori o stati incerti relativi a ordini Shopify/eBay; i documenti esterni senza riferimenti espliciti né match compatibili restano osservabili e non bloccanti.
- [ ] Backup, schema, servizi, health, code, rollback e readback Production verificati sul candidato esatto.
- [ ] Ricevuta del canary tecnico collegata al record di readiness.
- [ ] Nessun P0/P1 o stato remoto incerto irrisolto.

### Prima del go-live

- [ ] Il commit e il digest candidati non sono cambiati dopo il canary; altrimenti la prova interessata è stata ripetuta.
- [ ] Record di readiness finalizzato con esito canary e rischi residui.
- [ ] Draft GitHub Release collegata al tag candidato, note confrontate con `CHANGELOG.md` e `release-manifest.json` sanitizzato allegato.
- [ ] Immutabilità delle release confermata; nessun tag o asset pubblicato prima dell'autorizzazione.
- [ ] Autorizzazione esplicita alla release `v1.0.0`.
- [ ] Autorizzazione separata all'uso Production ordinario.

### Record di readiness 1.0

Prima del Canary Production creare `docs/runbooks/release-readiness.md` e finalizzarlo dopo il canary. Non è una copia delle checklist precedenti: è il record corrente che, per ogni gate bloccante di §23 e §28, collega la prova fresca che lo chiude.

Ogni voce ha la stessa forma: gate, esito osservato, riferimento verificabile - commit, digest, hash, ID remoto, run CI o evidenza - e data. Un gate senza riferimento verificabile è aperto, non chiuso.

Il record riporta inoltre ciò che nessuna checklist esprime: commit, tag e versione candidati; stato di `HF-O01`-`HF-O09`; RPO effettivamente osservato; rischi non bloccanti accettati con la condizione che li riapre; le autorizzazioni distinte già ottenute e quelle ancora mancanti.

Una checklist compilata senza link, hash, ID o risultati osservati non costituisce readiness.

---

## 29. Prompt operativo per Codex/Claude Code

Il prompt non ripete i vincoli del piano: li richiama. Gli obiettivi sono quelli della prima milestone non completata in §23, non un elenco fissato qui che invecchia a ogni chiusura.

```text
Stai implementando Hub Fatture 1.x. Leggi integralmente
"docs/Hub_Fatture_MASTER_PLAN.md" prima di agire e trattalo come
fonte di verità. La directory locale è `/Users/Matteo/Progetti/Hub-Fatture`.

Lavora sulla prima milestone non completata in §23: i suoi deliverable
sono l'obiettivo, i suoi gate sono la condizione di chiusura. Non
anticipare milestone successive e non iniziare da integrazioni reali,
invii o deploy.

Vincoli che non puoi rilassare da solo:
- perimetro §3.1 e §3.2, matrice tecnica §14.3 e scelte native §14.3:
  niente dipendenze, servizi o tool equivalenti a ciò che è già scelto;
- niente numerazione fiscale reale e nessun valore fiscale presunto
  prima di M4: RegimeFiscale, sezionali e campi Aruba si rilevano, non
  si deducono;
- nessun dato reale, segreto plaintext o credenziale in repository,
  test, log o fixture; l'unico blob sensibile ammesso è la key VPS
  cifrata in `ops/secrets/`;
- helper Aruba soltanto da M5, soltanto locale e presidiato; login e
  challenge OTP/SMS/CAPTCHA inattese restano umani e il percorso manuale resta disponibile;
- approvazione e numerazione richiedono `can_approve`
  e restano fuori dalla portata dell'account agente;
- fuori da una richiesta affermativa di pubblicazione, fermati e chiedi prima di
  deploy o release; fermati sempre prima di invii Aruba reali,
  migrazioni distruttive, eliminazione dati, decisioni fiscali non
  deducibili dai materiali e modifiche materiali al perimetro.

Metodo:
- ispeziona repository e istruzioni agentiche, proponi un piano breve e
  segnala le divergenze materiali dalla specifica prima di modificare;
- correggi le cause condivise, non i sintomi, e usa la soluzione più
  semplice già offerta dallo stack;
- lascia un check eseguibile per ogni logica non banale;
- chiudi con typecheck, test e build, riportando file cambiati,
  verifiche, rischi e prossimo task;
- per ogni operazione remota registra target, ID, readback e rollback
  senza esporre segreti.
```

---

## 30. Registro delle decisioni rinviate

Questi punti non sono dimenticanze. Sono sospesi intenzionalmente perché dipendono da dati reali, provider o approvazioni esterne. **Non resta aperta alcuna scelta di tool o dipendenza:** HF-O03 ha confermato il PDF ufficiale Aruba e ha escluso l'attivazione del fallback PDFKit; HF-O07 sceglie il provider SMTP, mentre l'adapter applicativo resta Nodemailer.

| ID | Decisione aperta | Blocca | Fonte necessaria | Condizione di chiusura |
|---|---|---|---|---|
| HF-O01 | `RegimeFiscale` esatto del cedente | profilo fiscale Production | XML Aruba accettato e/o commercialista | valore registrato nel profilo versionato e golden test verde |
| HF-O02 | Numerazione, sezionali, cambio anno, ordini a cavallo d'anno e gestione scarti | numerazione e invii reali | audit Aruba, documenti reali e conferma fiscale | procedura atomica, caso di fine anno e casi di scarto approvati |
| HF-O03 | PDF ufficiale Aruba — chiusa sul download ufficiale | copia cliente definitiva | download dal pannello Aruba reale | readback di un PDF ufficiale integro, leggibile e stabile; fallback PDFKit non attivato |
| HF-O04 | Mapping campi fiscali Shopify | connettore Shopify completo | query su ordine reale e API corrente | contract fixture anonimizzata e mapper testato |
| HF-O05 | Forma tax identifier e importi rimborso eBay | connettore eBay completo e TD04 | payload Sandbox/reali e API corrente | fixture, mapper e casi ambigui verificati |
| HF-O06 | Locatori, pause di autenticazione, limiti, download e stati del pannello Aruba | M8 e Production | audit autenticato, prova controllata e guide correnti | helper sui due sistemi operativi, mapping, fallback manuale e recovery da stato incerto verificati sul candidato e qualificati sul pannello reale senza invio |
| HF-O07 | Trasporto e limiti SMTP — chiusa su `OCI_EMAIL_DELIVERY` | invio copia cliente | PoC OCI nella regione di Milano e stima del titolare | dominio, SPF/DKIM, mittente, autenticazione, consegna, errore, hard bounce, suppression e reinvio verificati; volume massimo stimato di 500 copie mensili sotto il margine prudenziale di 2.500 |
| HF-O08 | Retention fiscale e tecnica definitiva — chiusa | go-live | approvazione del titolare e del commercialista | durate, eccezioni e procedura di cancellazione approvate nel contratto corrente |
| HF-O09 | Direzione visiva della Brand Foundation leggera | UI definitiva | due o tre proposte minime coerenti con uso privato e accessibilità | il titolare approva `docs/brand/brand-foundation.md`, SVG canonico e asset richiesti senza ampliare il perimetro |

Qualsiasi altra scelta di routine entro i confini della matrice 14.3 è affidata all'implementatore e non richiede una nuova fase di analisi.

---

## 31. Definition of Done della 1.0

La 1.0 è conclusa quando ogni gate di §23, ogni checklist di §28 e ogni decisione di §30 sono chiusi con prove osservate e collegate dal record corrente `docs/runbooks/release-readiness.md`. Questa sezione non ripete quelle condizioni: elenca soltanto ciò che nessuna singola milestone può dichiarare da sola.

1. tutti i requisiti `HF-F01`-`HF-F37` ancora attivi sono implementati o esplicitamente riclassificati dal titolare;
2. `HF-O01`-`HF-O09` sono chiusi ciascuno con la fonte e la condizione di chiusura previste in §30, senza sostituzioni: una decisione priva della sua fonte resta bloccante e non può essere convertita in rischio accettato. L'accettazione con condizione di riapertura riguarda soltanto rischi già classificati come non bloccanti, mai una decisione fiscale;
3. la catena completa - import, raggruppamento, modifiche, comparatore, approvazione, helper assistito e automatico, fallback manuale, stati SdI, e-mail, note di credito - è stata osservata end-to-end, non provata a pezzi;
4. profilo fiscale, numerazione, XML fattura e TD04 derivano da fonti approvate e da golden test che falliscono se il profilo cambia involontariamente;
5. nessun dato reale e nessun segreto plaintext compare in repository, cronologia, CI, log, fixture o documentazione; l'unico blob sensibile ammesso è la key VPS cifrata;
6. codice, migrazioni, lockfile, documentazione e stato live descrivono lo stesso commit: `/version`, digest distribuito e ricevuta di deploy coincidono dopo uno smoke autenticato;
7. il Canary tecnico Production ha verificato il candidato completo senza selezionare, approvare, numerare, caricare o inviare documenti reali, con kill switch invariato e senza P0/P1 o stati remoti irrisolti;
8. per il solo go-live iniziale, escluso dalla pubblicazione tecnica ordinaria perché costituisce una nuova attivazione produttiva, `v1.0.0` è pubblicata sullo stesso commit e digest superati dal canary tecnico, dopo autorizzazioni separate per deploy, release e uso Production ordinario;
9. non restano P0/P1 aperti, decisioni bloccanti sospese, ordini storici approvabili senza riconciliazione o documenti Aruba ambigui che possano causare una doppia emissione;
10. backup, recovery kit, restore drill e rollback applicativo sono stati eseguiti davvero, non soltanto documentati, e l'RPO dichiarato è quello osservato.

Una checklist compilata senza risultati osservati, ID o link alle evidenze non costituisce completamento.

---

## 32. Conclusione

Hub Fatture 1.x deve restare un'applicazione piccola, affidabile e comprensibile: importa ordini, crea raggruppamenti giornalieri presentati come Preparazione fattura, confronta sorgente, bozza e proiezione XML, produce documenti semplificati nel profilo del margine, richiede sempre l'approvazione e usa il pannello Aruba Base tramite un helper locale presidiato per trasmissione, esiti e conservazione.

La priorità non è costruire un motore fiscale generale, ma impedire errori operativi: dati mancanti, doppie fatture, doppi rimborsi, numerazione errata, invii non approvati e perdita di tracciabilità.

Il primo lavoro concreto segue M1 e le milestone successive in ordine. La pagina Aruba sintetica e l'helper nascono soltanto in M5, dopo che M4 ha qualificato profilo fiscale, numerazione e XML tramite pannello read-only e documenti già accettati dallo SdI. La riconciliazione Aruba in entrata può essere realizzata in parallelo agli altri lavori del candidato M8, ma deve essere integrata e qualificata dentro M8. La prova manuale controllata sul pannello reale chiude M8 arrestandosi prima dell'invio ed è un prerequisito inderogabile di M9.
