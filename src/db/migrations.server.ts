import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import pg from "pg";

import { sortedMigrationFileNames } from "../migration-files.ts";

const MIGRATION_LOCK = 1_214_606_389;

export interface MigrationOptions {
  connectionString: string;
  directory?: string;
}

export async function runMigrations({
  connectionString,
  directory = path.resolve("migrations"),
}: MigrationOptions): Promise<string[]> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  const applied: string[] = [];
  try {
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name text PRIMARY KEY,
        checksum text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    const files = sortedMigrationFileNames(await readdir(directory));
    const existing = await client.query<{ name: string; checksum: string }>(
      "SELECT name, checksum FROM schema_migrations ORDER BY name",
    );
    const checksums = new Map(existing.rows.map((row) => [row.name, row.checksum]));
    const fileNames = new Set(files);
    for (const name of checksums.keys()) {
      if (!fileNames.has(name)) throw new Error(`Migrazione applicata rimossa: ${name}`);
    }
    const lastApplied = existing.rows.at(-1)?.name;
    const inserted = files.find(
      (name) => !checksums.has(name) && lastApplied && name <= lastApplied,
    );
    if (inserted) throw new Error(`Migrazione fuori ordine: ${inserted}`);

    for (const name of files) {
      const sql = await readFile(path.join(directory, name), "utf8");
      const checksum = createHash("sha256").update(sql).digest("hex");
      const previous = checksums.get(name);
      if (previous && previous !== checksum)
        throw new Error(`Migrazione applicata modificata: ${name}`);
      if (previous) continue;

      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)", [
          name,
          checksum,
        ]);
        await client.query("COMMIT");
        applied.push(name);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
    return applied;
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK]).catch(() => undefined);
    await client.end();
  }
}
