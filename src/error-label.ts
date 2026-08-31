import { errorCatalog, type ErrorCode } from "./errors.ts";

export function errorCodeLabel(code: string | null): string {
  return code && Object.hasOwn(errorCatalog, code)
    ? errorCatalog[code as ErrorCode]
    : "Errore non disponibile";
}
