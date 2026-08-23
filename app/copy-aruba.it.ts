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
  arubaBookmarkletTitle: "Configura una volta il preferito",
  arubaBookmarkletHelp:
    "Non devi installare nulla. Funziona con Safari, Chrome o Edge su computer.",
  arubaBookmarkletSaveTitle: "Trascina il pulsante nella barra dei preferiti",
  arubaBookmarkletSaveHelp:
    "Lo riconosci dal simbolo ↻. Il preferito resta valido e non salva credenziali Aruba né token.",
  arubaBookmarkletLabel: "↻ Sincronizza Aruba",
  arubaBookmarkletAccessibleLabel: "Sincronizza Aruba",
  arubaBookmarkletRunTitle: "Apri Aruba, accedi e usa il preferito",
  arubaBookmarkletRunHelp:
    "La lettura mostra l’avanzamento nella pagina Aruba e termina senza inviare documenti.",
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
