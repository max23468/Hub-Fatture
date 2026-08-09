// Il valore di questo file è che Node lo esegua così com'è: se il type stripping non
// fosse disponibile, l'annotazione qui sotto sarebbe un errore di sintassi e lo script
// non arriverebbe mai alla stampa. Nessun controllo a runtime può dire di più.
const runtime: string = "node-type-stripping";

console.log(`${runtime}: ok`);
