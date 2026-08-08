export const errorCatalog = {
  AUTH_INVALID_CREDENTIALS: "Username o password non validi.",
  AUTH_PASSWORD_POLICY: "La password deve contenere da 8 a 128 caratteri.",
  AUTH_RATE_LIMITED: "Troppi tentativi errati. Riprova più tardi o usa la password corretta.",
  AUTH_SETUP_DISABLED: "Gli account sono già configurati.",
  AUTH_INVALID_SETUP_TOKEN: "Token di configurazione non valido.",
  CONFLICT_REVISION: "I dati sono cambiati. Ricarica la pagina e riprova.",
  INVALID_CONTENT_TYPE: "Formato della richiesta non supportato.",
  REQUEST_BODY_TOO_LARGE: "La richiesta supera il limite consentito.",
  REQUEST_ORIGIN_INVALID: "Origine della richiesta non valida.",
  REQUEST_TIMEOUT: "La richiesta ha impiegato troppo tempo.",
  UNKNOWN: "Si è verificato un errore inatteso.",
} as const;

export type ErrorCode = keyof typeof errorCatalog;

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;

  constructor(code: ErrorCode, status: number) {
    super(errorCatalog[code]);
    this.code = code;
    this.status = status;
  }
}

export function publicError(error: unknown) {
  return error instanceof AppError
    ? { code: error.code, message: error.message, status: error.status }
    : { code: "UNKNOWN" as const, message: errorCatalog.UNKNOWN, status: 500 };
}
