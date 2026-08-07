import { getConfig } from "../config.server.ts";
import { runMigrations } from "./migrations.server.ts";

const applied = await runMigrations({ connectionString: getConfig().DATABASE_URL });
process.stdout.write(
  applied.length ? `Migrazioni applicate: ${applied.join(", ")}\n` : "Schema aggiornato.\n",
);
