export const arubaSettingsCopy = {
  arubaTitle: "Aruba",
  arubaHelp:
    "Mantiene aggiornati documenti e stati tramite le API Aruba. Questa funzione non invia documenti.",
  arubaInventoryTitle: "Inventario",
  arubaExternalDocuments: "Senza ordine Shopify/eBay",
  arubaConnectionActive: "Sincronizzazione in corso",
  arubaConnectionActiveHelp: "La lettura API prosegue automaticamente in background.",
  arubaConnectionReady: "Pronto per l’aggiornamento",
  arubaConnectionReadyHelp: "L’inventario viene mantenuto aggiornato automaticamente tramite API.",
  arubaConnectionAttention: "Aggiornamento necessario",
  arubaConnectionAttentionHelp:
    "L’inventario è vecchio o l’ultima lettura non è riuscita. Avvia una nuova sincronizzazione.",
  arubaConnectionConflict: "Sincronizzazione completata · verifiche richieste",
  arubaConnectionConflictHelp:
    "L’inventario è aggiornato. Alcuni documenti devono essere verificati prima delle operazioni fiscali.",
  arubaLastUpdate: (value: string) => `Ultimo aggiornamento: ${value}`,
  arubaSyncOwnerOnly: "Solo il titolare può richiedere una sincronizzazione immediata.",
  arubaConnectionBlockTitle: "Connessione",
  arubaAccountBlockTitle: "Account",
  arubaAccountDetails: "Dati account e servizio",
  arubaServiceBlockTitle: "Servizio",
  arubaServiceBlockHelp:
    "Scadenza, spazio di conservazione e utilizzo delle trasmissioni del mese.",
  arubaSyncBlockTitle: "Sincronizzazione",
  arubaManageConnection: "Gestisci collegamento",
  arubaAccountUnavailableHelp:
    "I dati dell’account saranno mostrati dopo la prima verifica completata.",
  arubaApiEnvironment: "Ambiente Aruba",
  arubaApiEnvironmentDemo: "Demo",
  arubaApiEnvironmentProduction: "Produzione",
  arubaServiceExpiration: "Scadenza del servizio",
  arubaServiceSpaceUsed: "Spazio utilizzato",
  arubaServiceSpaceValue: (used: number, maximum: number) =>
    `${used.toLocaleString("it-IT")} KB su ${maximum.toLocaleString("it-IT")} KB`,
  arubaApiHelp:
    "Legge inventario, file e stati. Non carica, non prepara e non invia documenti ad Aruba.",
  arubaApiConfigured: "Credenziale verificata",
  arubaApiNotConfigured: "Credenziale non configurata",
  arubaApiPaused: "API in pausa",
  arubaApiRunning: "Connessa",
  arubaApiAttention: "Attenzione",
  arubaApiBlocked: "Bloccata",
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
  arubaConnectionDetails: "Dettagli e controlli",
  arubaSession: "Lettura in corso",
  arubaSessionActive: "Sì",
  arubaSessionInactive: "No",
  arubaDiagnostic: "Ultimo errore",
  arubaNoError: "Nessuno",
  arubaPotentialMatches: "Abbinamenti da confermare",
  arubaAmbiguousMatches: "Abbinamenti ambigui",
  arubaBlockingConflicts: "Conflitti bloccanti",
  arubaActionableFailures: "Errori operativi attuali",
  arubaAccountActive: "Operativo",
  arubaAccountUnavailable: "Scaduto o sospeso",
  arubaAccountUsername: "Username",
  arubaAccountPec: "PEC",
  arubaAccountCountry: "Paese",
  arubaAccountVat: "Partita IVA",
  arubaAccountFiscalCode: "Codice fiscale",
  arubaAccountExpiration: "Scadenza",
  arubaAccountStorage: "Spazio di conservazione",
  arubaAccountStorageValue: (percent: number) => `${percent}% utilizzato`,
  arubaAccountCheckedAt: (value: string) => `Verificato ${value}`,
  arubaAccountExpirationWarning: (days: number) =>
    days === 0
      ? "L’account Aruba scade oggi."
      : `L’account Aruba scade tra ${days} ${days === 1 ? "giorno" : "giorni"}.`,
  arubaApiSafetyPauseUntil: (value: string) => `Attiva fino al ${value}`,
  arubaDiagnosticValue: (code: string) =>
    code === "ARUBA_ACCOUNT_MISMATCH"
      ? "L’account Aruba aperto non coincide con quello già collegato"
      : code === "ARUBA_REMOTE_STATUS_UNRECOGNIZED"
        ? "Aruba mostra troppi stati non riconosciuti; la lettura è stata fermata"
        : code === "READ_SYNC_FAILED"
          ? "La lettura si è interrotta prima del completamento"
          : "Errore di sincronizzazione non disponibile",
  arubaAdvancedRecovery: "Recupero avanzato",
  arubaAdvancedRecoveryHelp:
    "Usa l’inserimento manuale soltanto quando l’API non può completare una lettura necessaria.",
  arubaOpenManualRecovery: "Avvia recupero manuale",
  arubaTransmissionTitle: "Trasmissione dei documenti",
  arubaTransmissionHelp:
    "Questa impostazione riguarda il caricamento e l’ultimo passaggio in Aruba, non la sincronizzazione dell’inventario. L’invio automatico parte solo dopo l’approvazione.",
} as const;
