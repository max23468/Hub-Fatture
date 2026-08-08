import { data } from "react-router";

import { publicError } from "../src/errors.ts";

/**
 * Traduce ogni errore di un'azione nel codice stabile del registro.
 * Senza questo passaggio React Router degrada l'errore a 500 opaco e perde lo status dichiarato.
 */
export async function actionResult<T>(run: () => Promise<T>) {
  try {
    return await run();
  } catch (error) {
    if (error instanceof Response) throw error;
    const result = publicError(error);
    return data(result, { status: result.status });
  }
}
