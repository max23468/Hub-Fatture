export const arubaCanaryCopy = {
  canaryAuthorized:
    "L’invio pilota è stato autorizzato per il solo documento selezionato. Il permesso non abilita altri invii.",
  authorizeCanary: "Autorizza un solo invio reale",
  confirmCanary: (fiscalLabel: string) =>
    `Confermo l’invio fiscale reale di ${fiscalLabel} tramite una sola chiamata Aruba con dryRun=false. Ho verificato documento, destinatario, importo e numerazione.`,
};
