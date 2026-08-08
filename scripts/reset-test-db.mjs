// Azzera lo schema del database E2E prima delle migrazioni: senza questo passaggio
// il container di test conserva le migrazioni di un altro branch e il gate si blocca.
import pg from "pg";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL assente");
if (!new URL(connectionString).pathname.endsWith("_test")) {
  throw new Error("Reset consentito soltanto su un database il cui nome termina con _test");
}

const client = new pg.Client({ connectionString });
await client.connect();
await client.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
await client.end();
process.stdout.write("Schema di test azzerato.\n");
