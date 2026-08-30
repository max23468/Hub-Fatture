# Design QA — Controlli e Dashboard

## Riferimenti

- Interfaccia corrente di Hub Fatture, catturata dal checkout `main` nello stesso stato dati e viewport desktop: `/Users/Matteo/.codex/visualizations/2026/08/30/01a0536f-1d47-7883-9ac7-e3b4e3a7e8b6/controls-implementation/dashboard-source.png`
- Confronto affiancato fra Dashboard corrente e nuova Dashboard: `/Users/Matteo/.codex/visualizations/2026/08/30/01a0536f-1d47-7883-9ac7-e3b4e3a7e8b6/controls-implementation/dashboard-comparison-final.png`
- Dashboard implementata, viewport desktop: `/Users/Matteo/.codex/visualizations/2026/08/30/01a0536f-1d47-7883-9ac7-e3b4e3a7e8b6/controls-implementation/dashboard-final-refined.png`
- Dashboard implementata, viewport mobile 390 × 844: `/Users/Matteo/.codex/visualizations/2026/08/30/01a0536f-1d47-7883-9ac7-e3b4e3a7e8b6/controls-implementation/dashboard-final-mobile-refined.png`
- Controlli implementati, viewport desktop: `/Users/Matteo/.codex/visualizations/2026/08/30/01a0536f-1d47-7883-9ac7-e3b4e3a7e8b6/controls-implementation/controls-final.png`
- Controlli implementati, viewport mobile 390 × 844: `/Users/Matteo/.codex/visualizations/2026/08/30/01a0536f-1d47-7883-9ac7-e3b4e3a7e8b6/controls-implementation/controls-final-mobile-refined.png`
- Confronto affiancato prima/dopo dell’allineamento Dashboard, viewport 1280 × 720: `/Users/Matteo/.codex/visualizations/2026/08/30/01a0536f-1d47-7883-9ac7-e3b4e3a7e8b6/controls-implementation/dashboard-refinement-comparison.png`
- Confronto affiancato prima/dopo della barra Controlli, viewport 1280 × 720: `/Users/Matteo/.codex/visualizations/2026/08/30/01a0536f-1d47-7883-9ac7-e3b4e3a7e8b6/controls-implementation/controls-refinement-comparison.png`
- Dashboard rifinita, viewport desktop 1280 × 720: `/Users/Matteo/.codex/visualizations/2026/08/30/01a0536f-1d47-7883-9ac7-e3b4e3a7e8b6/controls-implementation/dashboard-refinement-final.png`
- Controlli rifiniti, viewport desktop 1280 × 720: `/Users/Matteo/.codex/visualizations/2026/08/30/01a0536f-1d47-7883-9ac7-e3b4e3a7e8b6/controls-implementation/controls-refinement-final.png`
- Controlli rifiniti, viewport mobile 390 × 844: `/Users/Matteo/.codex/visualizations/2026/08/30/01a0536f-1d47-7883-9ac7-e3b4e3a7e8b6/controls-implementation/controls-refinement-mobile.png`
- Fascia riepilogativa Controlli allineata, viewport desktop 1280 × 720: `/Users/Matteo/.codex/visualizations/2026/08/30/01a0536f-1d47-7883-9ac7-e3b4e3a7e8b6/controls-implementation/controls-overview-aligned.png`
- Riferimento segnalato dal titolare, ritaglio 654 × 926 della coda in tema chiaro: `/var/folders/rh/fszhhk4s54qbkpq6p61p18s80000gn/T/codex-clipboard-31de50fc-1cd1-4b44-880e-39dfcdec84b8.png`
- Controlli dopo l’ultima rifinitura, viewport CSS 1280 × 666 in tema chiaro, densità 2×: `/Users/Matteo/.codex/visualizations/2026/08/30/01a0536f-1d47-7883-9ac7-e3b4e3a7e8b6/controls-implementation/controls-border-refinement-after-light.png`
- Confronto affiancato fra il ritaglio segnalato e la stessa area rifinita: `/Users/Matteo/.codex/visualizations/2026/08/30/01a0536f-1d47-7883-9ac7-e3b4e3a7e8b6/controls-implementation/controls-border-reference-comparison.png`

## Confronto visivo

La nuova Dashboard conserva tipografia, palette, icone Lucide, raggi, bordi, profondità e densità dell’interfaccia corrente. Il contenuto operativo passa da due pannelli concorrenti a una lettura verticale più chiara: tre sole azioni in alto, stato tecnico su tutta la larghezza e collegamenti esterni separati sotto.

Il pannello Stato operativo utilizza lo spazio libero a destra con tre domini tecnici. L’icona e il riepilogo sono centrati nella colonna sinistra; non compaiono né ultimo/prossimo controllo né un duplicato dei servizi esterni.

La schermata Controlli riusa navigazione, top bar, tipografia, controlli form e colori semantici esistenti. Desktop usa una coda a sinistra e il dettaglio azionabile a destra; mobile mantiene prima stato e filtri, poi la coda, senza overflow orizzontale.

## Problemi rilevati e correzioni

- P1: il primo controllo selezionato non è necessariamente la richiesta privacy. I percorsi automatici ora selezionano la riga per identità stabile, non per posizione.
- P1: alcuni test assumevano un solo account con capacità di approvazione. Le verifiche distinguono ora l’identità nominale quando serve attribuire l’azione, mantenendo la parità operativa.
- P2: il filtro Tipo mostrava etichette duplicate per categorie diverse. Le categorie rimborsi e Aruba hanno ora nomi distinti.
- P2: il badge numerico di `Controlli` usava il marrone di avviso e risultava estraneo alla navigazione. Ora è neutro, trasparente e ad alto contrasto.
- P2: la colonna di riepilogo in `Stato operativo` era leggermente più larga delle colonne adiacenti. Ora misura esattamente un terzo del riquadro, come le colonne dei box sopra e sotto.
- P2: i tre collegamenti del primo riquadro ereditavano regole di altezza diverse. Ora hanno tutti altezza esplicita pari al controllo standard.
- P2: una verifica geometrica del menu mobile dipendeva da `elementFromPoint` e risultava instabile in WebKit. Il controllo è stato sostituito dalla prova funzionale del click e dell’apertura del menu.
- P2: il confronto responsive ha evidenziato che la coda resta leggibile a 390 px; i tre filtri diventano campi a larghezza piena e il dettaglio non forza scorrimento laterale.
- P1: la selezione di un controllo provocava il reset della pagina in cima. I collegamenti della coda preservano ora lo scroll; la prova browser passa da `260 px` a `267 px`, senza ritorno a `0`.
- P2: le diverse quantità di testo nelle tre card della Dashboard spostavano verticalmente i pulsanti. Le card condividono ora una griglia con riga azione stabile; i tre pulsanti hanno quota e altezza coincidenti.
- P2: il riepilogo `Bloccanti · Importanti · Ordinari` occupava una colonna elastica e lasciava spazio vuoto a destra. Ora ha larghezza intrinseca, mentre i filtri usano lo spazio residuo e vanno a capo come gruppo quando necessario.
- P2: la barra Controlli poteva comprimere etichette, pulsante e bordo di focus fino a sovrapporli. La barra usa una griglia con minimi espliciti, il pulsante non spezza il testo e il focus resta contenuto nella riga selezionata.
- P2: la verifica mobile a 390 × 844 conferma assenza di overflow orizzontale e riepilogo compatto; la console del browser non riporta errori o avvisi.
- Regressioni automatiche aggiunte per geometria dei tre pulsanti, compattezza/separazione della barra filtri e mantenimento dello scroll tra controlli.
- P2: stato della coda (`Da risolvere`, `In attesa`) e riepilogo per gravità erano su fasce separate. Ora condividono una riga con asse centrale coincidente; sotto 48 rem si impilano senza overflow orizzontale.
- P2: il riepilogo `Bloccanti · Importanti · Ordinari` era alto 56 px e il margine negativo lo avvicinava troppo al testo introduttivo. Ora misura 44 px come la navigazione affiancata e mantiene 16 px reali di separazione dal testo.
- P2: ogni riga della coda sommava barra colorata a tutta altezza, separatore orizzontale e bordo interno azzurro della selezione. Le barre e il bordo interno sono stati rimossi; la gravità resta nell’icona su fondo semantico leggero e la selezione usa soltanto un fondo neutro.
- P2: i separatori della coda erano visivamente più forti del contenuto. Ora resta un solo separatore neutro attenuato fra le righe e il bordo esterno condiviso con il dettaglio.

## Iterazioni dell’ultimo controllo

1. Il confronto iniziale ha confermato due cause: riepilogo alto 56 px con spazio superiore annullato e tre segnali di gravità concorrenti nella coda.
2. La prima implementazione ha portato navigazione e riepilogo a 44 px, ripristinato 16 px di spazio e rimosso barre laterali e bordo di selezione.
3. Il confronto finale affiancato usa il ritaglio originale e la stessa regione in tema chiaro; icone Lucide, tipografia, palette e contenuti restano quelli dell’app. Non sono stati introdotti asset o testi nuovi.
4. Il controllo responsive non rileva overflow orizzontale; Chromium e WebKit passano entrambi 10/10 scenari, compresa la regressione geometrica appena aggiunta.

## Esito finale

passed
