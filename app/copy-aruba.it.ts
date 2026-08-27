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
  arubaConnectionConflict: "Sincronizzazione completata · verifiche richieste",
  arubaConnectionConflictHelp:
    "L’inventario è aggiornato. Alcuni documenti devono essere verificati prima delle operazioni fiscali.",
  arubaLastUpdate: (value: string) => `Ultimo aggiornamento: ${value}`,
  arubaOpenPanel: "Apri Aruba",
  arubaSyncOwnerOnly: "Solo il titolare può avviare la sincronizzazione Aruba.",
  arubaApiTitle: "Lettura automatica da Aruba",
  arubaApiStatus: "Stato",
  arubaApiHelp:
    "Legge inventario, file e stati. Non carica, non prepara e non invia documenti ad Aruba.",
  arubaApiConfigured: "Credenziale verificata",
  arubaApiNotConfigured: "Credenziale non configurata",
  arubaApiPaused: "API in pausa",
  arubaApiRunning: "Connessa",
  arubaApiAttention: "Attenzione",
  arubaApiBlocked: "Bloccata",
  arubaApiIdentityVerified: "Identità verificata",
  arubaApiIdentityNotVerified: "Identità non ancora verificata",
  arubaApiCredentialsTitle: "Credenziali di Fatturazione Elettronica",
  arubaApiCredentialsHelp:
    "Usa le stesse credenziali con cui accedi al pannello Aruba Fatturazione Elettronica. Non servono credenziali API separate.",
  arubaApiCredentialsConnected:
    "Collegamento verificato. Apri il modulo soltanto se devi cambiare i dati di accesso.",
  arubaApiEditCredentials: "Aggiorna credenziali",
  arubaApiCancelCredentials: "Annulla",
  arubaApiUsername: "Nome utente del pannello Aruba",
  arubaApiUsernameHelp:
    "È il nome utente del pannello, non l’account Aruba del tipo nome@aruba.it.",
  arubaApiPassword: "Password del pannello Aruba",
  arubaApiPasswordHelp: "È la password associata allo stesso nome utente del pannello.",
  arubaApiExpectedTaxId: "P.IVA o codice fiscale dell’attività",
  arubaApiExpectedTaxIdHelp:
    "Il collegamento viene interrotto se Aruba restituisce un’identità diversa.",
  arubaApiSaveCredentials: "Verifica e collega Aruba",
  arubaApiRotateCredentials: "Verifica e aggiorna l’accesso",
  arubaApiSecretHelp: "La password viene cifrata e non può essere riletta dall’interfaccia.",
  arubaApiPauseControl: "Mantieni in pausa la lettura API",
  arubaApiInboundControl: "Abilita la sincronizzazione in entrata",
  arubaApiSaveControls: "Salva controlli API",
  arubaApiSyncNow: "Sincronizza ora",
  arubaApiAuthority: "Fonte dei dati in entrata",
  arubaApiAuthorityBrowser: "Preferito nel browser",
  arubaApiAuthorityApi: "API Aruba",
  arubaApiParity: "Confronto API–pannello",
  arubaApiParityLabels: {
    MATCHED: "Allineata",
    DIVERGENT: "Divergenze da risolvere",
    INCOMPLETE: "Confronto incompleto",
  },
  arubaApiNoParity: "Non ancora verificata",
  arubaApiLatestRun: "Ultima lettura API",
  arubaApiBackfill: "Copertura dello storico",
  arubaApiBackfillComplete: "Backfill completo",
  arubaApiBackfillPending: "Backfill da completare",
  arubaApiBackfillRunning: (percent: number) =>
    `Backfill in corso · ${percent.toLocaleString("it-IT")}%`,
  arubaApiBackfillProgressLabel: "Avanzamento del backfill Aruba",
  arubaApiBackfillCoveredThrough: (value: string) => `Storico consolidato fino al ${value}`,
  arubaApiBackfillRemaining: (windows: number, estimatedMinutes: number | null) => {
    const estimate =
      estimatedMinutes === null
        ? "stima in calcolo"
        : estimatedMinutes < 60
          ? `circa ${estimatedMinutes} min`
          : estimatedMinutes < 1_440
            ? `circa ${Math.ceil(estimatedMinutes / 60)} ore`
            : `circa ${Math.ceil(estimatedMinutes / 1_440)} giorni`;
    return `${windows} finestre da 48 ore rimanenti · ${estimate}`;
  },
  arubaApiCheckpoint: "Checkpoint",
  arubaApiLimits: "Limiti di lettura API",
  arubaApiLimitValue: (inventory: number, notifications: number) =>
    `${inventory}/min inventario · ${notifications}/min notifiche`,
  arubaApiRunKinds: {
    BACKFILL: "Backfill",
    INCREMENTAL: "Incrementale",
    TARGETED: "Stati aperti",
    FULL: "Completo",
  },
  arubaApiRunStatuses: {
    RUNNING: "in corso",
    COMPLETED: "completato",
    FAILED: "fallito",
    INCOMPLETE: "incompleto",
    CANCELLED: "annullato",
  },
  arubaApiRunCounts: (documents: number, files: number, notifications: number) =>
    `${documents} documenti · ${files} file · ${notifications} notifiche`,
  arubaApiRunRequests: (requests: number, limit: number) =>
    `${requests}/${limit} richieste autorizzate`,
  arubaApiCheckpointValue: (value: string, page: number) => `${value} · pagina ${page}`,
  arubaApiRevoke: "Revoca credenziale API",
  arubaApiRevokeConfirmation: "Confermo di voler revocare la credenziale e fermare l’API",
  arubaApiSavedNotice: "Impostazioni API Aruba aggiornate.",
  arubaApiCodexHelp:
    "Puoi consultare lo stato e richiedere una sincronizzazione; credenziale, arresti e autorità sono riservati al titolare.",
  arubaConnectionDetails: "Dettagli sincronizzazione",
  arubaLastReadback: "Ultima sincronizzazione",
  arubaSession: "Lettura in corso",
  arubaSessionActive: "Sì",
  arubaSessionInactive: "No",
  arubaDiagnostic: "Ultimo errore",
  arubaNoError: "Nessuno",
  arubaPotentialMatches: "Abbinamenti da confermare",
  arubaAmbiguousMatches: "Abbinamenti ambigui",
  arubaBlockingConflicts: "Conflitti bloccanti",
  arubaActionableFailures: "Errori operativi attuali",
  arubaHistoricalFailures: "Errori già superati",
  arubaApiSafetyPause: "Pausa di sicurezza API",
  arubaApiSafetyPauseInactive: "Non attiva",
  arubaApiSafetyPauseUntil: (value: string) => `Attiva fino al ${value}`,
  arubaParityDossierSummary: (parity: {
    apiDocuments: number;
    browserDocuments: number;
    matchedDocuments: number;
    missingInApi: number;
    missingInBrowser: number;
    statusMismatches: number;
    fileMismatches: number;
    unresolvedBrowserConflicts: number;
    apiFileCoverage: { xml: number; p7m: number; pdf: number; notifications: number };
  }) =>
    `Dossier di parità: ${parity.matchedDocuments}/${parity.apiDocuments} documenti API allineati; ` +
    `${parity.browserDocuments} nel pannello, ${parity.missingInApi} mancanti nell’API, ` +
    `${parity.missingInBrowser} mancanti nel pannello, ${parity.statusMismatches} stati e ` +
    `${parity.fileMismatches} file divergenti, ${parity.unresolvedBrowserConflicts} conflitti browser. ` +
    `Copertura API: ${parity.apiFileCoverage.xml} XML, ${parity.apiFileCoverage.p7m} P7M, ` +
    `${parity.apiFileCoverage.pdf} PDF e ${parity.apiFileCoverage.notifications} notifiche.`,
  arubaDiagnosticValue: (code: string) =>
    code === "ARUBA_ACCOUNT_MISMATCH"
      ? "L’account Aruba aperto non coincide con quello già collegato"
      : code === "ARUBA_REMOTE_STATUS_UNRECOGNIZED"
        ? "Aruba mostra troppi stati non riconosciuti; la lettura è stata fermata"
        : code === "DOM_UNRECOGNIZED"
          ? "La pagina Aruba non ha completato il caricamento previsto"
          : code === "READ_SYNC_FAILED"
            ? "La lettura si è interrotta prima del completamento"
            : code === "HUB_RESPONSE_TIMEOUT"
              ? "Hub Fatture non ha risposto alla richiesta"
              : code === "HUB_TIMEOUT"
                ? "Il collegamento con Hub Fatture è scaduto"
                : code === "HUB_BRIDGE_TIMEOUT"
                  ? "La finestra Hub Fatture non ha completato il collegamento"
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
