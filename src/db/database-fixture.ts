import pg from "pg";

// Nessuno skip silenzioso: senza database il gate deve dirlo, non passare in verde.
function requireTestDatabase(): string {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    throw new Error(
      "TEST_DATABASE_URL assente: esegui i test tramite `npm run test:db`, che prepara PostgreSQL automaticamente.",
    );
  }
  return url;
}

const adminUrl = requireTestDatabase();

export async function withClient<T>(
  connectionString: string,
  callback: (client: pg.Client) => Promise<T>,
) {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    return await callback(client);
  } finally {
    await client.end();
  }
}

export async function temporaryDatabase(suffix: string) {
  const name = `hub_fatture_${process.pid}_${suffix}`;
  const url = new URL(adminUrl);
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  url.pathname = `/${name}`;
  return {
    connectionString: url.toString(),
    async drop() {
      const client = new pg.Client({ connectionString: adminUrl });
      await client.connect();
      await client.query(`DROP DATABASE ${name} WITH (FORCE)`);
      await client.end();
    },
  };
}
