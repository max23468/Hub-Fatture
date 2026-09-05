# Istruzioni per gli agenti

`docs/Hub_Fatture_MASTER_PLAN.md` è la fonte canonica per prodotto, UX, brand, architettura, modello commerciale, test, distribuzione e roadmap. `docs/contracts/versioning.md` è la fonte canonica per il versioning applicativo, incluse la serie stabile `1.x` e le tranche successive. Prima di agire leggi la sezione 0 (come leggere la specifica) e le sezioni che il tuo intervento tocca:

| Intervento                                   | Sezioni      |
| -------------------------------------------- | ------------ |
| Dominio ordini, raggruppamento, anagrafica   | 5, 7, 15, 25 |
| Interfaccia, terminologia, brand             | 5, 13        |
| Connettori Shopify ed eBay                   | 8, 9         |
| Aruba, SdI, e-mail al cliente                | 10, 11, 12   |
| Architettura, schema dati, job               | 14, 15, 16   |
| Sicurezza, privacy, requisiti non funzionali | 17, 21       |
| Repository, CI/CD, deployment, backup        | 18, 19, 20   |
| Test e criteri di uscita                     | 22, 31       |
| Roadmap, milestone, decisioni rinviate       | 23, 24, 30   |

In dubbio sulla sezione competente, leggi l'indice del documento invece di leggerlo tutto. Il perimetro confermato (3) e le decisioni consolidate (4) valgono sempre: verificali quando una richiesta sembra uscirne. Per procedure operative usa il runbook corrente individuato tramite `docs/INDEX.md`; per il ciclo Aruba consulta anche `docs/plans/aruba-api-integration.md` e, quando l'intervento riguarda trasmissione reale o monitoraggio SdI, `docs/plans/aruba-outbound-monitoring.md`.

La roadmap M0-M14 e la Definition of Done della `1.0.0` sono una baseline completata. Le attività correnti sono manutenzione o tranche esplicitamente approvate: non inventare nuove milestone, non riaprire quelle concluse e non dedurre lavoro dalla sola cronologia della roadmap.

- Rispondi sempre in italiano, con accenti e apostrofi corretti.
- Non sovrascrivere modifiche non tue.
- Non mantenere retrocompatibilità o implementazioni legacy: non esistono consumatori esterni da preservare.
- Se lo stesso problema ricorre due volte, correggine la causa condivisa e aggiungi il più piccolo controllo di regressione.
- Crea i worktree con `scripts/create-worktree.sh <branch> <percorso> [base]`: il comando prepara anche le dipendenze. Dopo una modifica a `package-lock.json`, esegui `npm run worktree:dependencies` prima dei gate.
- Decidi autonomamente naming, formattazione e default di routine entro i confini del Master Plan.
- Chiedi prima di azioni distruttive, deploy o release non già autorizzati da
  una richiesta di pubblicazione, attivazione degli invii Production, upload o
  invii Aruba reali, e-mail reali, modifiche all'account del provider, decisioni
  fiscali o modifiche materiali allo scope.
- Non aggiungere dipendenze, servizi o tool non approvati dal Master Plan.
- Applica `docs/contracts/versioning.md` a ogni bump: non prenotare versioni, non introdurre prerelease e distingui una patch compatibile da una nuova tranche `MINOR` esplicitamente autorizzata e da una nuova generazione `MAJOR`.
- Fuori dalla roadmap del Master Plan, descrivi capacità e gate osservabili senza duplicare date, branch, conteggi di test o sigle di milestone; lo stato corrente deriva dall’HEAD e dalla CI.
- La sigla `HF` è interna: non deve comparire nel frontend o in contenuti destinati all’utente.
- La repository è pubblica ma proprietaria: non aggiungere `LICENSE`, dati reali, segreti o configurazioni sensibili.
- Non aprire issue, discussion o project rivolti alla community.

## Significato di `Pubblica`

Quando il proprietario, riferendosi alla repository o alla modifica corrente,
dice `Pubblica` o chiede in modo affermativo e inequivocabile di pubblicare,
autorizza l'intero ciclo tecnico applicabile. Domande, ipotesi, pianificazioni e
negazioni non costituiscono autorizzazione. L'agente non si ferma a stati
intermedi e completa tutti i passaggi applicabili: preparazione e verifiche,
branch e commit, versione e changelog quando richiesti, push, PR, soli gate
bloccanti, merge, tag e GitHub Release quando previsti, deploy o promozione
tecnica e verifica live. La sequenza concreta, in particolare tra versionamento,
merge, deploy e release, è quella definita dalla policy della repository.
Per una modifica runtime, appena il merge restituisce lo SHA esatto di `main`,
l'agente avvia `scripts/dispatch-production.sh <sha>` senza attendere localmente
i check post-merge: il workflow Production conserva il proprio gate exact-SHA e
attende autonomamente gli stessi check. Questo anticipo vale soltanto dentro un
ciclo `Pubblica` già autorizzato e non trasforma ogni merge in un auto-deploy.

Prima di aprire una PR di pubblicazione, completa i gate locali applicabili e
presenta un HEAD coerente e pronto alla review. Classifica l'impatto sul
diff cumulativo fra l'ultimo commit distribuito e il candidato finale, non sulla
sola ultima PR. Modifiche esclusivamente documentali, di test o di governance
non richiedono immagine, deploy o release; più modifiche runtime correlate già
assorbite in `main` vengono distribuite insieme una sola volta sul candidato
finale.

Il titolo della PR usa sempre il formato Conventional Commit accettato da
Foundation (`tipo(scope)!: descrizione` oppure `tipo: descrizione`). Di default
coincide con il subject Conventional dell'HEAD già validato; non sostituirlo con
un titolo descrittivo privo del prefisso prima dell'apertura della PR.

Quando una modifica runtime deve essere pubblicata, il bump di versione e la
voce di changelog appartengono alla stessa PR dell'implementazione e devono
essere completati prima del merge. Non fondere la modifica runtime per aprire
poi una seconda PR dedicata soltanto a versione, changelog o release. Se questi
elementi non sono pronti, la PR di implementazione non è pronta al merge. Una
deroga richiede una richiesta esplicita del proprietario riferita al caso
specifico.

La pulizia finale si esegue dal checkout pulito di `main` con
`node scripts/publish-close.mjs <branch-temporaneo> <percorso-worktree>`: il comando
fallisce se la PR e l'HEAD del branch non risultano assorbiti, allinea `main`,
rimuove soltanto il branch e il worktree indicati e inventaria stash, branch e
worktree preservati. L'agente riporta quell'inventario nel riepilogo finale. Se
non esiste un branch/worktree temporaneo, esegue comunque la rilettura manuale
equivalente di `main`, branch, worktree e stash e ne dichiara l'esito. Se un
passaggio non è applicabile, lo dichiara e prosegue con gli altri. La richiesta
affermativa di pubblicazione vale come autorizzazione a PR, merge, deploy tecnico
e release previsti dal ciclo, senza una seconda conferma. Un deploy ordinario
preserva la modalità invii Production già autorizzata, ma `Pubblica` non
autorizza il passaggio da disabilitata ad abilitata, upload o invii Aruba reali,
e-mail reali, modifiche all'account Aruba, restore o eliminazioni distruttive,
né decisioni fiscali: queste azioni richiedono una richiesta esplicita separata.
Una richiesta riferita soltanto a una di queste azioni non avvia la
pubblicazione della repository. Non dichiarare `pubblicato` finché il ciclo
applicabile e la rilettura finale di PR, check, deploy, release e stato Git non
sono completi; l'esecuzione riuscita del gate di chiusura applicabile è parte
dello stato Git.

## Prompting e conduzione del lavoro con Astra

- Interpreta le richieste operative come incarichi da completare, usando intento
  e contesto della sessione. Risolvi i dettagli ordinari con assunzioni ragionevoli;
  chiedi solo quando la risposta cambia materialmente il risultato.
- Prima di una conferma necessaria, completa il lavoro indipendente già autorizzato
  e prepara un risultato concreto da valutare. Non richiedere consensi già concessi;
  conserva i confini di pubblicazione, dati e operazioni esterne definiti qui.
  Un ordine esplicito di attesa o arresto interrompe il lavoro interessato.
- Le istruzioni esplicite dell'utente prevalgono sulle linee guida delle skill,
  nel rispetto delle istruzioni di sistema e sviluppatore. Verifica pertinenza,
  gerarchia e conflitti di AGENTS, override e skill prima di dedurne un blocco;
  non trasformare raccomandazioni generiche in nuovi gate.
- Se una skill causa una pausa, una richiesta di permesso o lavoro incompleto,
  cita e collega il preciso `SKILL.md`, riporta l'istruzione rilevante e distingui
  il requisito esplicito dalla tua interpretazione.
- Integra correzioni e nuovi vincoli durante il lavoro; rispondi alle domande
  laterali senza perdere l'obiettivo, salvo annullamento o cambio di scope esplicito.
- Scrivi in italiano semplice, con esito per primo e paragrafi brevi. Usa elenchi
  solo quando aiutano; evita formule ricorrenti, gergo superfluo e aggiornamenti
  che ripetono lo stesso stato. Riporta prove, limiti e prossima azione reale.
- Calibra la verifica sul rischio del diff e completa i gate applicabili. Riusa
  test esistenti; aggiungine solo per un comportamento o rischio concreto, non
  per replicare modifiche banali. Dopo un esito verde ripeti o amplia i controlli
  solo per nuove modifiche, errori o dubbi irrisolti. Verifica il diff effettivo,
  senza trattare il messaggio di successo di uno strumento come prova sufficiente.
- Quando la sessione e le regole del progetto consentono subagent, delega solo
  filoni consistenti e indipendenti, con ownership disgiunta, risultato atteso e
  verifiche espliciti. Il coordinatore integra; niente delega per microtask o
  semplice ricontrollo. Scrivi messaggi leggibili anche tra agenti.

Esempio e fonti: [prompting con Astra](CONTRIBUTING.md#prompting-con-gpt-6-astra).
