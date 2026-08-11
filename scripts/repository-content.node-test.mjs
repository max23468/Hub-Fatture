import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const textExtensions = new Set([
  ".css",
  ".js",
  ".json",
  ".md",
  ".mjs",
  ".ts",
  ".tsx",
  ".yaml",
  ".yml",
]);

async function collect(relativePath) {
  const absolutePath = path.join(root, relativePath);
  // Una cartella nasce con la milestone che la usa: la sua assenza è uno zero, non un errore.
  const entries = await readdir(absolutePath, { withFileTypes: true }).catch(() => []);
  const files = [];

  for (const entry of entries) {
    const child = path.join(relativePath, entry.name);
    if (entry.isDirectory()) files.push(...(await collect(child)));
    else if (textExtensions.has(path.extname(entry.name))) files.push(child);
  }

  return files;
}

async function contents(files) {
  return Promise.all(
    files.map(async (file) => ({ file, text: await readFile(path.join(root, file), "utf8") })),
  );
}

// `git grep` esce 0 con match, 1 senza match e 2 in errore: `!` in shell trasformerebbe
// anche l'errore in successo, quindi la guardia vive qui dove lo stato è ispezionabile.
function tracked(pattern) {
  const result = spawnSync("git", ["grep", "-nIE", pattern], { cwd: root, encoding: "utf8" });
  assert.equal(result.error, undefined);
  assert.ok(result.status === 0 || result.status === 1, `git grep fallito: ${result.stderr}`);
  return result.status === 0 ? result.stdout.trim().split("\n") : [];
}

test("nessuna chiave privata in chiaro è tracciata", () => {
  assert.deepEqual(tracked("BEGIN ([A-Z0-9 ]+ )?PRIVATE KEY"), []);
  const keys = spawnSync("git", ["ls-files", "*.key"], { cwd: root, encoding: "utf8" });
  assert.equal(keys.status, 0);
  assert.equal(keys.stdout.trim(), "");
});

test("nessun riferimento a nomi storici del Master Plan", () => {
  assert.deepEqual(tracked("Hub-Fatture-Master-Plan[.]md|docs/MASTER_PLAN[.]md"), []);
});

test("la policy Pubblica resta coerente nelle fonti canoniche", async () => {
  const [agents, masterPlan, glossary] = await Promise.all(
    ["AGENTS.md", "docs/Hub_Fatture_MASTER_PLAN.md", "docs/glossario.md"].map((file) =>
      readFile(path.join(root, file), "utf8"),
    ),
  );
  assert.match(agents, /richiesta affermativa di pubblicazione/);
  assert.match(agents, /P2\/P3 della review restano advisory e non autorizzano modifiche/);
  assert.match(masterPlan, /richiesta affermativa di pubblicazione autorizza (?:invece )?deploy/);
  assert.match(glossary, /\| Pubblica\s+\| ciclo tecnico completo\s+\|/);
});

test("la prova Aruba reale chiude il collaudo prima del Canary", async () => {
  const masterPlan = await readFile(path.join(root, "docs/Hub_Fatture_MASTER_PLAN.md"), "utf8");
  const collaudo = `M${8}`;
  const canary = `M${9}`;
  const integrazione = `M${5}`;
  assert.match(
    masterPlan,
    new RegExp(`### 11\\.4 ${collaudo} - prova manuale controllata come gate di uscita`),
  );
  assert.match(
    masterPlan,
    new RegExp(`senza questa prova ${collaudo} resta aperta e ${canary} non può iniziare`),
  );
  assert.doesNotMatch(
    masterPlan,
    new RegExp(`prova manuale controllata sul pannello reale chiude ${integrazione}`),
  );
});

test("la sigla interna non compare nella superficie utente", async () => {
  const files = [...(await collect("app")), "src/errors.ts", "src/db/auth.server.ts"];
  const offenders = (await contents(files))
    .filter(({ text }) => /\bhf\b/i.test(text))
    .map(({ file }) => file);
  assert.deepEqual(offenders, []);
});

test("il frontend usa Preparazione fattura al posto dei vecchi nomi", async () => {
  const files = await contents(await collect("app"));
  const offenders = files
    .filter(({ text }) => /\b(?:Scheda|Schede|Pratica|Pratiche)\b/.test(text))
    .map(({ file }) => file);
  assert.deepEqual(offenders, []);
});

test("le sigle della roadmap restano fuori da codice e documenti operativi", async () => {
  const roots = ["app", "src", "tests", "scripts", ".github/workflows", "docs"];
  const files = (await Promise.all(roots.map(collect)))
    .flat()
    .filter((file) => file !== "docs/Hub_Fatture_MASTER_PLAN.md");
  const offenders = (await contents(files))
    .filter(({ text }) => /\bM\d+(?:-M\d+)?\b/.test(text))
    .map(({ file }) => file);
  assert.deepEqual(offenders, []);
});

test("i documenti evergreen non duplicano date di avanzamento", async () => {
  const rootDocuments = [
    "AGENTS.md",
    "CHANGELOG.md",
    "CONTRIBUTING.md",
    "README.md",
    "SECURITY.md",
  ];
  const docs = (await collect("docs")).filter(
    (file) => !file.startsWith("docs/evidence/") && file !== "docs/Hub_Fatture_MASTER_PLAN.md",
  );
  const dates = [
    /\b\d{1,2} (?:gennaio|febbraio|marzo|aprile|maggio|giugno|luglio|agosto|settembre|ottobre|novembre|dicembre) 20\d{2}\b/i,
    /\b20\d{2}-\d{2}-\d{2}\b/,
  ];
  const offenders = (await contents([...rootDocuments, ...docs]))
    .filter(({ text }) => dates.some((date) => date.test(text)))
    .map(({ file }) => file);
  assert.deepEqual(offenders, []);
});

test("le fixture usano soltanto host sintetici .invalid", async () => {
  const offenders = (await contents(await collect("tests/fixtures"))).flatMap(({ file, text }) =>
    [...text.matchAll(/(?:@|https?:\/\/)([a-z0-9.-]+\.[a-z]{2,})/gi)]
      .filter(([, host]) => !host.endsWith(".invalid"))
      .map(([, host]) => `${file}: ${host}`),
  );
  assert.deepEqual(offenders, []);
});

test("il proxy locale resta accessibile soltanto dal Mac", async () => {
  const compose = await readFile(path.join(root, "compose.yaml"), "utf8");
  assert.match(compose, /"127\.0\.0\.1:8080:80"/);
  assert.match(compose, /"127\.0\.0\.1:5432:5432"/);
});

test("Shopify CLI riusa database e chiave dello stack Development", async () => {
  const [script, manifest] = await Promise.all(
    ["scripts/development.sh", "package.json"].map((file) =>
      readFile(path.join(root, file), "utf8"),
    ),
  );
  assert.match(script, /Hub Fatture Development Encryption/);
  assert.match(script, /Hub Fatture Development Bootstrap Token/);
  assert.match(script, /127\.0\.0\.1:5432\/hub_fatture/);
  assert.match(script, /syncbay-dev\.myshopify\.com/);
  assert.match(script, /npm run dev:shopify:cli/);
  assert.doesNotMatch(script, /development-bootstrap-token-change-me/);
  assert.match(manifest, /"@shopify\/cli": "4\.6\.0"/);
  assert.match(manifest, /"dev:shopify:cli": "npm exec -- @shopify\/cli app dev --no-color"/);
});

test("lo stack Development mantiene nome e riavvio stabili", async () => {
  const [compose, script] = await Promise.all(
    ["compose.yaml", "scripts/development.sh"].map((file) =>
      readFile(path.join(root, file), "utf8"),
    ),
  );
  assert.match(compose, /^name: hub-fatture-development$/m);
  assert.equal(compose.match(/^    restart: unless-stopped$/gm)?.length, 4);
  assert.match(compose, /- app_node_modules:\/workspace\/node_modules/);
  assert.match(compose, /- worker_node_modules:\/workspace\/node_modules/);
  assert.match(compose, /- worker_build_server:\/workspace\/build-server/);
  for (const setting of [
    "SMTP_FROM",
    "SMTP_HOST",
    "SMTP_PASSWORD",
    "SMTP_PORT",
    "SMTP_SECURE",
    "SMTP_TRANSPORT",
    "SMTP_USERNAME",
  ]) {
    assert.ok(compose.includes("  " + setting + ": ${" + setting + ":-"));
  }
  assert.match(script, /docker compose up -d --build --wait app app-worker caddy/);
});

test("la baseline Production usa un solo digest senza esporre PostgreSQL", async () => {
  const [compose, dockerfile, caddy, workflow] = await Promise.all(
    [
      "compose.production.yaml",
      "Dockerfile",
      "ops/Caddyfile.production",
      ".github/workflows/production.yml",
    ].map((file) => readFile(path.join(root, file), "utf8")),
  );
  assert.equal(compose.match(/^    image: \$\{APP_IMAGE:\?\}$/gm)?.length, 2);
  const postgres = compose.slice(compose.indexOf("\n  postgres:"), compose.indexOf("\nnetworks:"));
  assert.doesNotMatch(postgres, /\n    ports:/);
  assert.match(postgres, /user: "999:999"/);
  assert.match(postgres, /cap_drop: \[ALL\]/);
  assert.match(postgres, /read_only: true/);
  assert.match(postgres, /no-new-privileges:true/);
  assert.match(compose, /ARUBA_SUBMISSION_ENABLED: "false"/);
  assert.match(compose, /read_only: true/);
  assert.match(compose, /cap_drop: \[ALL\]/);
  assert.equal(compose.match(/logging: \*default-logging/g)?.length, 4);
  assert.match(compose, /max-size: 10m/);
  assert.match(dockerfile, /USER 10001:10001/);
  assert.match(dockerfile, /test ! -e node_modules\/typescript/);
  assert.match(dockerfile, /rm -rf \/usr\/local\/lib\/node_modules\/npm/);
  assert.doesNotMatch(dockerfile, /CMD \["npm"/);
  assert.doesNotMatch(compose, /npm start/);
  assert.match(compose, /node node_modules\/@react-router\/serve\/bin\.cjs/);
  assert.match(dockerfile, /COPY --chown=hub-fatture:hub-fatture schemas \.\/schemas/);
  assert.match(caddy, /fatture\.opik\.net/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.match(workflow, /git checkout --detach "\$CANDIDATE"/);
  assert.match(workflow, /ref: \$\{\{ needs\.image\.outputs\.commit \}\}/);
  assert.match(workflow, /subject-digest: \$\{\{ steps\.build\.outputs\.digest \}\}/);
  assert.match(
    workflow,
    /IMAGE: oci:\/\/ghcr\.io\/max23468\/hub-fatture@\$\{\{ needs\.image\.outputs\.digest \}\}/,
  );
  const deploy = workflow.slice(workflow.indexOf("\n  deploy:"));
  assert.match(deploy, /packages: read/);
  const registryLogin = deploy.indexOf("docker/login-action@");
  assert.notEqual(registryLogin, -1);
  assert.ok(registryLogin < deploy.indexOf("Verifica attestazione"));
  assert.match(workflow, /hub-fatture-backup\.timer hub-fatture-monitor\.timer/);
  assert.match(workflow, /backup\.sh deploy/);
});

test("gli script Production sono sintatticamente validi e conservano i gate di continuità", async () => {
  const scripts = [
    "ops/provision-production.sh",
    "scripts/backup.sh",
    "scripts/monitor-local.sh",
    "scripts/production-deploy.sh",
    "scripts/production-preflight.sh",
    "scripts/production-readback.sh",
    "scripts/read-env.sh",
    "scripts/restore.sh",
  ];
  for (const script of scripts) {
    const result = spawnSync("sh", ["-n", script], { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 0, `${script}: ${result.stderr}`);
  }
  const [backup, deploy, monitor, readback, restore, workflow] = await Promise.all(
    [
      "scripts/backup.sh",
      "scripts/production-deploy.sh",
      "scripts/monitor-local.sh",
      "scripts/production-readback.sh",
      "scripts/restore.sh",
      ".github/workflows/production.yml",
    ].map((file) => readFile(path.join(root, file), "utf8")),
  );
  assert.match(backup, /jq -r '\."content-length" \/\/ empty'/);
  assert.match(backup, /jq -r '\."opc-meta-sha256" \/\/ empty'/);
  assert.doesNotMatch(backup, /\.data\."(?:content-length|opc-meta-sha256)"/);
  assert.match(backup, /exec 9>\.\/backup\.lock/);
  assert.match(backup, /flock -n 9/);
  assert.match(backup, /^#!\/bin\/bash\nset -euo pipefail/m);
  assert.ok(
    backup.indexOf("trap notify_failure EXIT HUP INT TERM") <
      backup.indexOf("exec 9>./backup.lock"),
    "la contesa del lock deve attraversare il trap di notifica",
  );
  const pauseWriters = backup.lastIndexOf("\n  pause app-web app-worker");
  const reconcileStorage = backup.indexOf("reconcileDocumentStorage", pauseWriters);
  const databaseDump = backup.indexOf("pg_dump", reconcileStorage);
  const documentArchive = backup.indexOf(
    "data/documents data/operations/deploy-receipt.json",
    databaseDump,
  );
  const resumeWriters = backup.lastIndexOf("\nresume_writers\n");
  assert.ok(
    pauseWriters >= 0 &&
      pauseWriters < reconcileStorage &&
      reconcileStorage < databaseDump &&
      databaseDump < documentArchive &&
      documentArchive < resumeWriters,
    "lo storage deve essere riconciliato e le scritture sospese durante lo snapshot",
  );
  assert.match(deploy, /data\/operations\/rollback\.env/);
  assert.match(deploy, /data\/operations\/rollback\.compose\.yaml/);
  assert.match(deploy, /data\/operations\/rollback\.Caddyfile/);
  assert.match(deploy, /\.deploy\.env.*! -f data\/operations\/deploy-receipt\.json/);
  assert.match(deploy, /ps --all -q/);
  assert.match(deploy, /Container residui dal primo deploy fallito/);
  assert.match(deploy, /exec 9>\.\/backup\.lock/);
  assert.doesNotMatch(deploy, /deploy\.lock/);
  assert.match(deploy, /HUB_FATTURE_CANDIDATE_DIR/);
  assert.match(deploy, /"\$candidate_dir\/production-preflight\.sh"/);
  assert.match(deploy, /"\$candidate_dir\/production-readback\.sh"/);
  assert.match(deploy, /current_schema.*previous_schema/);
  assert.match(deploy, /rollback automatico vietato.*forward-fix/);
  assert.match(deploy, /cp "\$previous_compose" compose\.yaml/);
  assert.match(deploy, /cp "\$previous_caddy" Caddyfile/);
  assert.match(deploy, /rm -f \.deploy\.env compose\.yaml Caddyfile/);
  assert.match(deploy, /if ! docker compose .* down; then/);
  assert.match(deploy, /return 1/);
  assert.match(deploy, /--force-recreate/);
  assert.match(deploy, /production-readback\.sh >\/dev\/null/);
  assert.match(readback, /--retry-max-time 180 --retry-all-errors/);
  assert.match(workflow, /compose\.yaml\.next/);
  assert.match(workflow, /Caddyfile\.next/);
  assert.match(
    workflow,
    /test -f \/opt\/hub-fatture\/\.deploy\.env.*test -x \/opt\/hub-fatture\/scripts\/backup\.sh/,
  );
  const candidateDeploy = workflow.indexOf("HUB_FATTURE_CANDIDATE_DIR='$target'");
  const operationalInstall = workflow.indexOf("sudo install -m 750 '$target/backup.sh'");
  assert.ok(
    candidateDeploy >= 0 && candidateDeploy < operationalInstall,
    "il bundle operativo candidato va installato solo dopo il readback del deploy",
  );
  assert.match(monitor, /app-web app-worker caddy postgres/);
  assert.match(monitor, /for service in app-web postgres/);
  assert.match(monitor, /jq -r '\.Health \/\/ empty'/);
  assert.match(monitor, /\[ "\$health" = "healthy" \]/);
  assert.match(monitor, /\[ "\$current" != "\$previous" \]/);
  assert.match(restore, /sha256sum "\$archive"/);
  assert.match(restore, /^#!\/bin\/bash\nset -euo pipefail/m);
  const preflight = await readFile(path.join(root, "scripts/production-preflight.sh"), "utf8");
  assert.match(preflight, /for command in age bash curl docker flock jq oci/);
  assert.match(preflight, /OCI_NOTIFICATIONS_TOPIC_OCID/);
  assert.match(preflight, /\^ocid1\\\.onstopic\\\.oc1\\\./);
  assert.match(preflight, /dns_ip.*expected_public_ip/);
  assert.doesNotMatch(preflight, /^\.\s+(?:\.\/)?\.env(?:\s|$)/m);
  assert.doesNotMatch(preflight, /\beval\b/);
  for (const file of ["scripts/backup.sh", "scripts/monitor-local.sh"]) {
    const content = await readFile(path.join(root, file), "utf8");
    assert.doesNotMatch(content, /^\.\s+(?:\.\/)?\.env(?:\s|$)/m);
    assert.doesNotMatch(content, /\beval\b/);
  }
  assert.match(
    await readFile(path.join(root, "ops/provision-production.sh"), "utf8"),
    /mask rpcbind\.socket rpcbind\.service/,
  );
});

test("il worker riconferma la lease dopo errori transitori di heartbeat", async () => {
  const worker = await readFile(path.join(root, "src/worker.ts"), "utf8");
  assert.doesNotMatch(worker, /leaseLost/);
  assert.match(worker, /connector_job_heartbeat_failed/);
  assert.match(worker, /if \(!\(await jobLeaseCurrent\(job\)\)\)/);
});

test("i webhook Shopify sono dichiarati nella configurazione dell'app", async () => {
  const [config, connector] = await Promise.all(
    ["shopify.app.toml", "src/integrations/shopify.server.ts"].map((file) =>
      readFile(path.join(root, file), "utf8"),
    ),
  );
  for (const topic of [
    "app/uninstalled",
    "customers/data_request",
    "customers/redact",
    "fulfillments/create",
    "fulfillments/update",
    "orders/cancelled",
    "orders/create",
    "orders/paid",
    "orders/updated",
    "refunds/create",
    "shop/redact",
  ]) {
    assert.match(config, new RegExp(`"${topic}"`));
  }
  assert.match(config, /scopes = "read_customers,read_fulfillments,read_orders"/);
  assert.match(
    connector,
    /SHOPIFY_SCOPES = \["read_orders", "read_customers", "read_fulfillments"\]/,
  );
  assert.doesNotMatch(connector, /webhooks\.register/);
});

test("l'applicazione accede a PostgreSQL soltanto tramite il livello dati", async () => {
  const files = [
    ...(await collect("app")),
    ...(await collect("src")).filter((file) => !file.startsWith("src/db/")),
  ];
  const offenders = (await contents(files))
    .filter(({ text }) =>
      /import\s*\{[^}]*\b(?:getPool|withTransaction)\b[^}]*\}\s*from\s*["'][^"']*db\/client\.server|from ["']pg["']/.test(
        text,
      ),
    )
    .map(({ file }) => file);
  assert.deepEqual(offenders, []);
});
