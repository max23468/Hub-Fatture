import { defineConfig, devices } from "@playwright/test";

const databaseUrl =
  process.env.TEST_DATABASE_URL ??
  "postgres://hub_fatture:hub_fatture_test@127.0.0.1:5433/hub_fatture_test";
const port = Number(process.env.E2E_PORT ?? 4173);
const baseUrl = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: baseUrl,
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "webkit",
      use: { ...devices["Desktop Safari"] },
    },
  ],
  webServer: {
    command: "node scripts/reset-test-db.mjs && npm run db:migrate && npm run start",
    env: {
      ADMIN_BOOTSTRAP_TOKEN: "synthetic-bootstrap-token-for-tests",
      APP_BASE_URL: baseUrl,
      APP_ENV: "test",
      DATABASE_URL: databaseUrl,
      DOCUMENT_STORAGE_ROOT: "storage/e2e-documents",
      PORT: String(port),
    },
    port,
    timeout: 30_000,
  },
});
