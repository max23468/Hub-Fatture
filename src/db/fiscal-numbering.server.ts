import type pg from "pg";

import { getConfig } from "../config.server.ts";

type NumberingBaseline = { lastObservedYear: number; lastObservedNumber: number };

/**
 * Fatture e note di credito condividono serie e progressivo annuale, anche quando il documento
 * nasce nel pannello Aruba. Il numero successivo supera documenti approvati, documenti Aruba di
 * entrambi i tipi in qualunque stato e saldo del profilo fiscale. Il lock vale fino al commit.
 */
export async function nextFiscalNumber(
  client: pg.PoolClient,
  series: string,
  year: number,
  baseline: NumberingBaseline,
): Promise<number> {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
    `fiscal-number:${series}:${year}`,
  ]);
  const config = getConfig();
  const sequence = await client.query<{ next: number }>(
    `SELECT greatest(
       coalesce((SELECT max(fiscal_number) FROM documents
         WHERE status = 'APPROVED' AND series = $1 AND fiscal_year = $2), 0),
       coalesce((SELECT max((btrim(fiscal_number))::integer)
         FROM aruba_remote_documents
         WHERE environment = $3 AND account_reference = $4
           AND fiscal_year = $2 AND upper(series) = upper($1)
           AND btrim(fiscal_number) ~ '^[0-9]+$'), 0),
       $5::integer
     ) + 1 AS next`,
    [
      series,
      year,
      config.APP_ENV === "production" ? "PRODUCTION" : "MOCK",
      config.ARUBA_ACCOUNT_REFERENCE,
      baseline.lastObservedYear === year ? baseline.lastObservedNumber : 0,
    ],
  );
  return Number(sequence.rows[0]!.next);
}
