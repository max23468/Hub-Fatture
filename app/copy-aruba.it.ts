export const arubaSettingsCopy = {
  arubaTitle: "Aruba",
  arubaHelp:
    "Aggiorna documenti e stati dal pannello Aruba. Questa funzione non carica e non invia documenti.",
  arubaInventoryTitle: "Inventario",
  arubaExternalDocuments: "Senza ordine Shopify/eBay",
  arubaSyncTitle: "Sincronizzazione Aruba",
  arubaConnectionActive: "Sincronizzazione in corso",
  arubaConnectionActiveHelp: "Tieni aperte le finestre Aruba e Hub Fatture fino al completamento.",
  arubaConnectionReady: "Pronto per l’aggiornamento",
  arubaConnectionReadyHelp:
    "Apri Aruba e avvia il preferito Sincronizza Aruba quando vuoi aggiornare l’inventario.",
  arubaConnectionAttention: "Aggiornamento necessario",
  arubaConnectionAttentionHelp:
    "L’inventario è vecchio o l’ultima lettura non è riuscita. Avvia una nuova sincronizzazione.",
  arubaLastUpdate: (value: string) => `Ultimo aggiornamento: ${value}`,
  arubaOpenPanel: "Apri Aruba",
  arubaSyncOwnerOnly: "Solo il titolare può avviare la sincronizzazione Aruba.",
  arubaConnectionDetails: "Dettagli sincronizzazione",
  arubaLastReadback: "Ultima sincronizzazione",
  arubaSession: "Lettura in corso",
  arubaSessionActive: "Sì",
  arubaSessionInactive: "No",
  arubaDiagnostic: "Ultimo errore",
  arubaNoError: "Nessuno",
  arubaDiagnosticValue: (code: string) =>
    code === "ARUBA_ACCOUNT_MISMATCH"
      ? "L’account Aruba aperto non coincide con quello già collegato"
      : code === "DOM_UNRECOGNIZED"
        ? "La pagina Aruba non ha completato il caricamento previsto"
        : code === "READ_SYNC_FAILED"
          ? "La lettura si è interrotta prima del completamento"
          : code === "HUB_CHANNEL_TIMEOUT"
            ? "La finestra Hub Fatture non ha completato il collegamento"
            : code === "HUB_RESPONSE_TIMEOUT"
              ? "Hub Fatture non ha risposto alla richiesta"
              : code === "HUB_TIMEOUT" || code === "HUB_BRIDGE_TIMEOUT"
                ? "Il collegamento con Hub Fatture è scaduto"
                : "Errore di sincronizzazione non disponibile",
  arubaBookmarkletTitle: "Configura una volta il preferito",
  arubaBookmarkletHelp:
    "Non devi installare nulla. Funziona con Safari, Chrome o Edge su computer.",
  arubaBookmarkletSaveTitle: "Trascina il pulsante nella barra dei preferiti",
  arubaBookmarkletSaveHelp:
    "Il preferito si aggiorna automaticamente e non salva credenziali Aruba né token.",
  arubaBookmarkletLabel: "Sincronizza Aruba",
  arubaBookmarkletAccessibleLabel: "Sincronizza Aruba",
  arubaBookmarkletRunTitle: "Apri Aruba, accedi e usa il preferito",
  arubaBookmarkletRunHelp:
    "Puoi avviarlo anche dalla Home: quando richiesto seleziona Fatture inviate nel menu Aruba. La lettura mostra l’avanzamento e non invia documenti.",
  arubaAdvancedRecovery: "Recupero avanzato",
  arubaAdvancedRecoveryHelp:
    "Usa l’inserimento manuale soltanto se il preferito non riesce a completare la lettura.",
  arubaOpenManualRecovery: "Avvia recupero manuale",
  arubaTransmissionTitle: "Trasmissione dei documenti",
  arubaTransmissionHelp:
    "Questa impostazione riguarda il caricamento e l’ultimo passaggio in Aruba, non la sincronizzazione dell’inventario.",
  arubaBridgeTitle: "Sincronizzazione protetta",
  arubaBridgeHelp:
    "Questa finestra collega temporaneamente Aruba a Hub Fatture senza condividere le credenziali.",
  arubaBridgeWaiting: "In attesa del comando dalla pagina Aruba…",
  arubaBridgeActive: "Collegamento attivo. Non chiudere questa finestra.",
  arubaBridgeMissingPanel: "Apri questa finestra usando il preferito dalla pagina Aruba.",
  arubaBridgeFailed:
    "Non è stato possibile avviare la sessione. Torna alle impostazioni e riprova.",
} as const;
