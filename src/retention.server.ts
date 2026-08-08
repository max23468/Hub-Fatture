import { getPool } from "./db/client.server.ts";

export const LOGIN_ATTEMPT_WINDOW_MINUTES = 15;
const INTERVAL_MS = 60 * 60 * 1000;

/**
 * Cancella i dati tecnici scaduti richiesti da 17.7: sessioni oltre la scadenza e tentativi
 * di accesso oltre la finestra, con l'`ip_hash` che portano. Deve dipendere dal tempo, non
 * dall'arrivo del prossimo login, altrimenti un'app inattiva li conserva a tempo indefinito.
 */
export async function pruneExpired(): Promise<void> {
  await getPool().query("DELETE FROM sessions WHERE expires_at <= now()");
  await getPool().query(
    `DELETE FROM login_attempts
     WHERE attempted_at <= now() - interval '${LOGIN_ATTEMPT_WINDOW_MINUTES} minutes'`,
  );
}

// ponytail: un timer di processo basta a un monolite a istanza singola; passare alla coda job
// solo quando esisteranno più processi che se ne contendono l'esecuzione.
export function startRetention(): void {
  const run = () => void pruneExpired().catch((error: unknown) => console.error(error));
  run();
  setInterval(run, INTERVAL_MS).unref();
}
