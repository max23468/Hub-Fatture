# Recupero della pubblicazione 0.3.63

## Deroga una tantum

La modifica runtime della Preparazione fattura è stata fusa con la PR #184
prima di includere versione e changelog. Riscrivere o annullare quel merge dopo
la pubblicazione su `main` sarebbe un'azione distruttiva e produrrebbe ulteriore
rumore nella cronologia.

Su indicazione esplicita del titolare di correggere l'errore e impedirne la
ripetizione, la PR #185 è mantenuta come unico recupero per completare versione,
changelog e regole operative già autorizzati. Questa deroga vale soltanto per
questa release e non costituisce un precedente: ogni successiva modifica
runtime destinata a Production deve includere i metadati di release nella
propria PR prima del merge, come stabilito da `AGENTS.md` e dalla sezione 18.4
del Master Plan.
