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

test("il readiness pubblico non espone volumi degli ordini live", async () => {
  const readiness = await readFile(
    path.join(root, "docs", "runbooks", "release-readiness.md"),
    "utf8",
  );
  assert.doesNotMatch(readiness, /\b\d+ ordini\b/);
  assert.doesNotMatch(readiness, /\b(?:Shopify|eBay): \d/);
  assert.doesNotMatch(
    readiness,
    /\b\d+ `(?:ALREADY_INVOICED|NOT_INVOICED|LEGACY_BILLING_REVIEW|GROUPED|NEEDS_REVIEW|CANCELLED)`/,
  );
});

test("nessun riferimento a nomi storici del Master Plan", () => {
  assert.deepEqual(tracked("Hub-Fatture-Master-Plan[.]md|docs/MASTER_PLAN[.]md"), []);
});

test("il candidato esegue Chromium e WebKit in ambienti isolati", async () => {
  const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  assert.equal(
    manifest.scripts["test:e2e"],
    "node scripts/with-test-database.mjs npm run test:e2e:direct",
  );
  assert.equal(
    manifest.scripts["test:e2e:release-candidate"],
    "node scripts/with-test-database.mjs npm run test:e2e:direct",
  );
  assert.equal(
    manifest.scripts["test:e2e:direct"],
    "npm run test:e2e:chromium:direct && npm run test:e2e:webkit:direct",
  );
  assert.equal(
    manifest.scripts["test:e2e:chromium:direct"],
    "playwright test --project=chromium --workers=1",
  );
  assert.equal(
    manifest.scripts["test:e2e:webkit:direct"],
    "playwright test --project=webkit --workers=1",
  );
});

test("la policy Pubblica resta coerente nelle fonti canoniche", async () => {
  const [agents, masterPlan, glossary] = await Promise.all(
    ["AGENTS.md", "docs/Hub_Fatture_MASTER_PLAN.md", "docs/glossario.md"].map((file) =>
      readFile(path.join(root, file), "utf8"),
    ),
  );
  assert.match(agents, /richiesta affermativa di pubblicazione/);
  assert.match(agents, /P2\/P3 della review restano advisory e non autorizzano modifiche/);
  assert.match(agents, /stessa PR dell'implementazione/);
  assert.match(agents, /Non fondere la modifica runtime per aprire[\s\S]*seconda PR/);
  assert.match(masterPlan, /richiesta affermativa di pubblicazione autorizza (?:invece )?deploy/);
  assert.match(masterPlan, /stessa PR dell'implementazione/);
  assert.match(masterPlan, /Non aprire una seconda PR di sola versione, changelog o release/);
  assert.doesNotMatch(masterPlan, /approvazione single-owner/);
  assert.doesNotMatch(masterPlan, /soltanto dopo l'approvazione richiesta/);
  assert.doesNotMatch(masterPlan, /richiede l'approvazione del titolare/);
  assert.match(glossary, /\| Pubblica\s+\| ciclo tecnico completo\s+\|/);
});

test("la qualifica API e l'outbound senza invio precedono il Canary", async () => {
  const masterPlan = await readFile(path.join(root, "docs/Hub_Fatture_MASTER_PLAN.md"), "utf8");
  const qualification = masterPlan.indexOf(`### M${8} - Qualifica API e accordo`);
  const outbound = masterPlan.indexOf(`### M${10} - Outbound API senza invio reale`);
  const canary = masterPlan.indexOf(`### M${13} - Canary Production TD01`);
  const goLive = masterPlan.indexOf(`### M${14} - Go-live e \`1.0.0\``);
  assert.ok(qualification >= 0);
  assert.ok(outbound > qualification);
  assert.ok(canary > outbound);
  assert.ok(goLive > canary);
  assert.match(masterPlan, /nessun invio SdI reale/);
  assert.match(masterPlan, /permesso monouso/);
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

test("Development non può riconfigurare l'app Shopify Production", async () => {
  const [script, manifest, shopifyConfig] = await Promise.all(
    ["scripts/development.sh", "package.json", "shopify.app.toml"].map((file) =>
      readFile(path.join(root, file), "utf8"),
    ),
  );
  assert.match(script, /Hub Fatture Development Encryption/);
  assert.match(script, /Hub Fatture Development Bootstrap Token/);
  assert.doesNotMatch(script, /SHOPIFY_SHOP|dev:shopify/);
  assert.doesNotMatch(script, /development-bootstrap-token-change-me/);
  const shopifyCliVersion = JSON.parse(manifest).devDependencies?.["@shopify/cli"];
  assert.match(shopifyCliVersion, /^\d+\.\d+\.\d+$/);
  assert.doesNotMatch(manifest, /"dev:shopify/);
  assert.match(shopifyConfig, /application_url = "https:\/\/fatture\.opik\.net"/);
  assert.match(shopifyConfig, /automatically_update_urls_on_dev = false/);
  assert.doesNotMatch(shopifyConfig, /dev_store_url/);
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
  const [compose, dockerfile, caddy, workflow, artifact] = await Promise.all(
    [
      "compose.production.yaml",
      "Dockerfile",
      "ops/Caddyfile.production",
      ".github/workflows/production.yml",
      ".github/workflows/production-artifact.yml",
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
  assert.match(artifact, /docker\/setup-buildx-action@[0-9a-f]{40} # v4\./);
  assert.match(artifact, /docker\/login-action@[0-9a-f]{40} # v4\./);
  assert.match(artifact, /docker\/build-push-action@[0-9a-f]{40} # v7\./);
  assert.match(workflow, /git checkout --detach "\$CANDIDATE"/);
  assert.match(workflow, /ref: \$\{\{ needs\.candidate\.outputs\.commit \}\}/);
  assert.match(artifact, /subject-digest: \$\{\{ steps\.build\.outputs\.digest \}\}/);
  assert.match(
    workflow,
    /node "\$RUNNER_TEMP\/hub-fatture-production-tooling\/commit-checks\.mjs"/,
  );
  assert.match(workflow, /install -m 600 scripts\/change-impact\.mjs scripts\/commit-checks\.mjs/);
  assert.match(
    workflow,
    /node "\$RUNNER_TEMP\/hub-fatture-production-tooling\/change-impact\.mjs"/,
  );
  assert.match(workflow, /deployments\?environment=Production&task=hub-fatture-production/);
  assert.doesNotMatch(
    workflow,
    /deployments\?environment=Production&per_page=100/,
    "una baseline legacy non prova quale SHA sia stato realmente installato",
  );
  assert.match(workflow, /task:"hub-fatture-production"/);
  assert.equal(
    workflow.match(/environment:\n\s+name: Production/g)?.length,
    1,
    "soltanto il job che usa i segreti deve dichiarare l'Environment Production",
  );
  const candidate = workflow.slice(
    workflow.indexOf("\n  candidate:"),
    workflow.indexOf("\n  checks:"),
  );
  assert.doesNotMatch(candidate, /secrets\.PRODUCTION_/);
  assert.match(
    workflow,
    /live_receipt=\$\(ssh .*sudo cat \/opt\/hub-fatture\/data\/operations\/deploy-receipt\.json/,
  );
  assert.match(workflow, /Riconciliazione da ricevuta live verificata/);
  assert.ok(
    workflow.indexOf('git merge-base --is-ancestor "$live_base" "$CANDIDATE"') <
      workflow.indexOf('description="Baseline riconciliata dalla ricevuta live"'),
    "la baseline deve essere validata prima di registrare il successo",
  );
  assert.match(
    workflow,
    /elif \[ "\$ROLLBACK" = true \]; then\s+git merge-base --is-ancestor "\$CANDIDATE" "\$live_base"\s+git merge-base --is-ancestor "\$live_base" "\$EXPECTED_BASE"/,
  );
  assert.match(workflow, /for delay in 0 2 5 10 20 30/);
  assert.match(workflow, /-f state=success/);
  assert.match(workflow, /BASE: \$\{\{ needs\.candidate\.outputs\.check_base \}\}/);
  assert.match(workflow, /git merge-base --is-ancestor "\$base" "\$CANDIDATE"/);
  assert.match(workflow, /git merge-base --is-ancestor "\$CANDIDATE" "\$base"/);
  assert.match(
    workflow,
    /git merge-base --is-ancestor "\$CANDIDATE" "\$base"; then\s+check_base=0{40}/,
  );
  assert.match(workflow, /impact_base=\$CANDIDATE/);
  assert.match(workflow, /ROLLBACK: \$\{\{ needs\.candidate\.outputs\.rollback \}\}/);
  assert.match(workflow, /if \[ "\$ROLLBACK" = true \]/);
  assert.match(workflow, /fetch-depth: 0/);
  assert.match(workflow, /needs\.candidate\.outputs\.runtime == 'true'/);
  assert.match(
    workflow,
    /IMAGE: oci:\/\/ghcr\.io\/max23468\/hub-fatture@\$\{\{ needs\.image\.outputs\.digest \}\}/,
  );
  const deploy = workflow.slice(workflow.indexOf("\n  deploy:"));
  const image = workflow.slice(workflow.indexOf("\n  image:"), workflow.indexOf("\n  deploy:"));
  assert.match(deploy, /Verifica e riconcilia la baseline live/);
  assert.match(deploy, /fetch-depth: 0/);
  assert.match(image, /actions: read/);
  assert.match(image, /actions\/workflows\/production-artifact\.yml\/runs/);
  assert.match(image, /test "\$conclusion" = success/);
  assert.match(deploy, /packages: read/);
  const registryLogin = deploy.indexOf("docker/login-action@");
  assert.notEqual(registryLogin, -1);
  assert.ok(registryLogin < deploy.indexOf("Verifica attestazione"));
  const schemaPreflight = deploy.indexOf("Blocca rollback con schema divergente");
  const exactDeployment = deploy.indexOf("Crea il deployment per il candidato esatto");
  const installCandidate = deploy.indexOf("Installa artefatti e distribuisci il digest");
  assert.notEqual(schemaPreflight, -1);
  assert.ok(schemaPreflight < exactDeployment);
  assert.ok(exactDeployment < installCandidate);
  assert.match(deploy, /candidate_schema.*deployed_schema/s);
  assert.match(deploy, /test "\$candidate_schema" = "\$deployed_schema"/);
  assert.match(deploy, /customer_email_mode/);
  assert.match(deploy, /candidato non supporta la disattivazione delle e-mail/);
  assert.match(workflow, /hub-fatture-backup\.timer hub-fatture-monitor\.timer/);
  assert.match(workflow, /if \[ '\$BACKUP_REQUIRED' = true \]/);
  assert.match(workflow, /backup\.sh deploy/);
  assert.match(workflow, /backup-receipt\.json/);
  assert.match(workflow, /backup_only:/);
  assert.match(workflow, /publish_release:/);
  assert.match(workflow, /if: inputs\.backup_only/);
  assert.match(deploy, /scp scripts\/backup\.sh/);
  assert.match(workflow, /HUB_FATTURE_ROOT=\/opt\/hub-fatture '\$remote_script' readiness/);
  assert.match(workflow, /trap 'rm -f \\"\$remote_script\\"' EXIT/);
  assert.match(workflow, /deploy-receipt\.json.*= '\$CANDIDATE'.*'\$remote_script' readiness/s);
  assert.match(workflow, /\.objectName \| contains\(\$commit\)/);
  assert.match(workflow, /\.version == \$version/);
  assert.match(workflow, /\.schema == \$schema/);
  assert.match(workflow, /\.imageDigest == \.deployedImageDigest/);
  assert.match(workflow, /rollback_digest=\$rollback_digest/);
  assert.match(workflow, /live_digest=\$live_digest/);
  assert.match(
    workflow,
    /if sudo test -f \/opt\/hub-fatture\/data\/operations\/deploy-receipt\.json/,
  );
  assert.match(workflow, /Ricevuta assente: esecuzione del percorso di bootstrap Production/);
  assert.match(
    workflow,
    /needs\.candidate\.outputs\.runtime == 'true' \|\|\s+needs\.candidate\.outputs\.commit == needs\.candidate\.outputs\.base/,
  );
  assert.match(workflow, /deploy_runtime=false/);
  assert.match(workflow, /if \[ -z "\$live_receipt" \]; then[\s\S]*deploy_runtime=true/);
  assert.match(workflow, /steps\.baseline\.outputs\.deploy_runtime == 'true'/);
  assert.match(workflow, /Il candidato è già live: il redeploy viene saltato/);
  const release = workflow.slice(workflow.indexOf("\n  release:"));
  assert.match(release, /name: GitHub Release immutabile/);
  assert.match(release, /needs\.deploy\.result == 'success'/);
  assert.match(release, /needs\.candidate\.outputs\.rollback != 'true'/);
  assert.doesNotMatch(release, /needs\.candidate\.outputs\.runtime == 'true'/);
  assert.match(release, /IMAGE_DIGEST: \$\{\{ needs\.deploy\.outputs\.live_digest \}\}/);
  assert.doesNotMatch(release, /needs\.image\.outputs\.digest \|\|/);
  assert.match(release, /new URL\(process\.argv\[1\]\)\.pathname\.match/);
  assert.match(release, /prepare-production-release\.mjs/);
  assert.match(release, /publish-github-release\.sh/);
  assert.doesNotMatch(release, /environment:\s*\n\s+name: Production/);
});

test("la qualifica e-mail Production è presidiata e non espone dati sensibili", async () => {
  const qualification = await readFile(
    path.join(root, "src/operations/email-delivery-qualification.ts"),
    "utf8",
  );
  assert.match(qualification, /config\.APP_ENV !== "production"/);
  assert.match(qualification, /config\.SMTP_TRANSPORT !== "OCI_EMAIL_DELIVERY"/);
  assert.match(qualification, /EMAIL_QUALIFICATION_CONFIRM !== expectedConfirmation/);
  assert.match(qualification, /QUALIFY_EMAIL:\$\{config\.APP_COMMIT_SHA\}/);
  assert.match(qualification, /sendCanonicalEmail\(config, message, invalidPassword\)/);
  assert.match(qualification, /const retry = await sendCanonicalEmail\(config, message\)/);
  assert.match(qualification, /messageIdSha256/);
  assert.doesNotMatch(qualification, /console\.|SMTP_PASSWORD.*stdout|recipient: retry/);
});

test("i contesti required restano stabili mentre i gate costosi sono proporzionati", async () => {
  const [ci, arubaPlatform, platformCheck, codeql, dependencies, foundation, react] =
    await Promise.all(
      [
        ".github/workflows/ci.yml",
        ".github/workflows/aruba-platform.yml",
        "scripts/aruba-helper-platform-check.ts",
        ".github/workflows/codeql.yml",
        ".github/workflows/dependency-review.yml",
        ".github/workflows/foundation.yml",
        ".github/workflows/react-doctor.yml",
      ].map((file) => readFile(path.join(root, file), "utf8")),
    );
  assert.match(ci, /\n  gate:\n    name: CI\n    if: always\(\)/);
  assert.match(ci, /name: PostgreSQL e migrazioni\n    if: needs\.impact\.outputs\.database/);
  assert.match(ci, /name: E2E \$\{\{ matrix\.label \}\}\n    if: needs\.impact\.outputs\.e2e/);
  const e2e = ci.slice(ci.indexOf("\n  e2e:"), ci.indexOf("\n  aruba-helper-platform:"));
  assert.match(ci, /e2e_matrix: \$\{\{ steps\.impact\.outputs\.e2e_matrix \}\}/);
  assert.match(e2e, /fromJSON\(needs\.impact\.outputs\.e2e_matrix\)/);
  assert.ok(e2e.indexOf("npm run build") < e2e.indexOf("npx --no-install playwright test"));
  assert.match(e2e, /playwright install --with-deps \$\{\{ matrix\.install \}\}/);
  assert.match(
    e2e,
    /npx --no-install playwright test --project=\$\{\{ matrix\.browser \}\} --workers=1/,
  );
  assert.match(ci, /"browser":"webkit","label":"WebKit","install":"webkit chromium"/);
  assert.doesNotMatch(ci, /- run: npm ci$/m);
  assert.match(ci, /name: Helper Aruba .*\n    if: needs\.impact\.outputs\.aruba-platform/);
  assert.doesNotMatch(ci, /workflow_dispatch:/);
  assert.match(
    ci,
    /BASE_SHA: \$\{\{ github\.event\.pull_request\.base\.sha \|\| github\.event\.before \}\}/,
  );
  assert.match(arubaPlatform, /repository_dispatch:\n    types: \[aruba-platform-candidate\]/);
  assert.doesNotMatch(arubaPlatform, /workflow_dispatch:/);
  assert.match(arubaPlatform, /ref: \$\{\{ github\.event\.client_payload\.commit \}\}/);
  assert.match(
    arubaPlatform,
    /name: Esegui helper Aruba \(\$\{\{ matrix\.browser \}\} \/ \$\{\{ matrix\.os \}\}\)/,
  );
  assert.match(arubaPlatform, /npm run test:aruba:platform -- \$\{\{ matrix\.browser \}\}/);
  assert.match(platformCheck, /runArubaReadHelper/);
  assert.match(platformCheck, /requestedFiles/);
  assert.doesNotMatch(arubaPlatform, /inputs\.commit/);
  assert.match(arubaPlatform, /\[\[ "\$CANDIDATE" =~ \^\[0-9a-f\]\{40\}\$ \]\]/);
  assert.match(arubaPlatform, /test "\$\(git rev-parse HEAD\)" = "\$CANDIDATE"/);
  assert.match(arubaPlatform, /git merge-base --is-ancestor "\$CANDIDATE" origin\/main/);
  assert.match(arubaPlatform, /permissions:\n  checks: write\n  contents: read/);
  assert.match(arubaPlatform, /if: always\(\)\n        shell: bash/);
  assert.match(
    arubaPlatform,
    /RECEIPT_NAME: Helper Aruba \(\$\{\{ matrix\.browser \}\} \/ \$\{\{ matrix\.os \}\}\)/,
  );
  assert.doesNotMatch(
    arubaPlatform,
    /name: Helper Aruba \(\$\{\{ matrix\.browser \}\} \/ \$\{\{ matrix\.os \}\}\)/,
  );
  assert.match(arubaPlatform, /gh api --method POST "repos\/\$\{GITHUB_REPOSITORY\}\/check-runs"/);
  assert.match(arubaPlatform, /-f head_sha="\$CANDIDATE"/);
  assert.match(arubaPlatform, /-f conclusion="\$CONCLUSION"/);
  assert.doesNotMatch(arubaPlatform, /name: CI\b/);
  assert.doesNotMatch(arubaPlatform, /E2E Chromium/);
  assert.match(codeql, /if: steps\.impact\.outputs\.standard == 'true'/);
  assert.match(dependencies, /if: steps\.impact\.outputs\.dependencies == 'true'/);
  assert.match(foundation, /if: steps\.impact\.outputs\.image == 'true'/);
  assert.match(react, /if: steps\.impact\.outputs\.react == 'true'/);
});

test("i thread Codex advisory non duplicano il blocco delle conversazioni", async () => {
  const [workflow, gate] = await Promise.all(
    [".github/workflows/codex-review-gate.yml", "scripts/codex-review-gate.mjs"].map((file) =>
      readFile(path.join(root, file), "utf8"),
    ),
  );
  assert.match(workflow, /pull-requests: write/);
  assert.match(gate, /resolveReviewThread/);
  assert.match(gate, /advisoryThreadIds\(threads, headSha\)/);
  assert.match(gate, /\["P0", "P1"\]/);
});

test("la riconciliazione Aruba non tronca i candidati fiscali", async () => {
  const inbound = await readFile(path.join(root, "src/db/aruba-inbound.server.ts"), "utf8");
  assert.doesNotMatch(inbound, /LIMIT 500/);
  assert.match(inbound, /jsonb_array_elements_text\([\s\S]*candidate -> 'orderIds'/);
  assert.match(inbound, /remote\.remote_status <> 'REJECTED'/);
});

test("il job PostgreSQL installa il validatore XML usato dalle suite DB", async () => {
  const [workflow, packageJson] = await Promise.all([
    readFile(path.join(root, ".github", "workflows", "ci.yml"), "utf8"),
    readFile(path.join(root, "package.json"), "utf8"),
  ]);
  const database = workflow.slice(
    workflow.indexOf("\n  database:"),
    workflow.indexOf("\n  security:"),
  );
  assert.match(database, /apt-get install --yes libxml2-utils/);
  assert.match(database, /npm run test:db/);
  const scripts = JSON.parse(packageJson).scripts;
  assert.equal(scripts["test:db"], "node scripts/with-test-database.mjs npm run test:db:direct");
  assert.equal(scripts["test:db:direct"], "node --test --test-concurrency=4 src/db/*.test.ts");
});

test("la modifica del classificatore forza i gate senza eseguirlo come autorità", async () => {
  const workflows = [
    "ci.yml",
    "dependency-review.yml",
    "codeql.yml",
    "react-doctor.yml",
    "foundation.yml",
    "production-artifact.yml",
  ];
  for (const name of workflows) {
    const workflow = await readFile(path.join(root, ".github", "workflows", name), "utf8");
    assert.match(
      workflow,
      /git diff --name-only --no-renames "\$BASE_SHA" "\$HEAD_SHA" -- scripts\/change-impact\.mjs/,
      `${name} deve rilevare il classificatore senza fidarsi del suo output`,
    );
  }
});

test("gli script Production sono sintatticamente validi e conservano i gate di continuità", async () => {
  const scripts = [
    "ops/provision-production.sh",
    "scripts/backup.sh",
    "scripts/monitor-local.sh",
    "scripts/production-deploy.sh",
    "scripts/production-preflight.sh",
    "scripts/production-readback.sh",
    "scripts/production-release-candidate-readback.sh",
    "scripts/dispatch-production.sh",
    "scripts/publish-github-release.sh",
    "scripts/read-env.sh",
    "scripts/restore.sh",
  ];
  for (const script of scripts) {
    const result = spawnSync("sh", ["-n", script], { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 0, `${script}: ${result.stderr}`);
  }
  const [backup, deploy, monitor, readback, candidateReadback, restore, workflow] =
    await Promise.all(
      [
        "scripts/backup.sh",
        "scripts/production-deploy.sh",
        "scripts/monitor-local.sh",
        "scripts/production-readback.sh",
        "scripts/production-release-candidate-readback.sh",
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
  assert.match(backup, /version:\$version/);
  assert.match(backup, /imageDigest:\$imageDigest/);
  assert.match(backup, /schema:\$schema/);
  assert.match(
    candidateReadback,
    /historical_reconciliation_outcome IS NULL\s+AND \(trigger_status <> 'LEGACY_BILLING_REVIEW'\s+OR historical_reconciled_at IS NOT NULL\s+OR billing_case_id IS NOT NULL\s+OR EXISTS \(\s+SELECT 1 FROM document_orders\s+WHERE document_orders\.order_id = orders\.id\)\)/,
  );
  assert.match(
    candidateReadback,
    /historical_reconciliation_outcome = 'ALREADY_INVOICED'\s+AND NOT EXISTS \(\s+SELECT 1 FROM document_orders\s+JOIN documents ON documents\.id = document_orders\.document_id\s+WHERE document_orders\.order_id = orders\.id\s+AND documents\.origin = 'ARUBA_HISTORY'/,
  );
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
  assert.match(
    backup,
    /unpause app-web app-worker.*writers_paused=0.*SECONDS \+ 60.*until new_healthy_probe.*sleep 2/s,
  );
  const probe = backup.match(/new_healthy_probe\(\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(probe, "il predicato della nuova sonda health deve essere isolabile");
  const probeStatus = (start, exitCode = 0) =>
    spawnSync(
      "bash",
      [
        "-c",
        `${probe}\ndocker() { printf '%s\\n' "$HEALTH_JSON"; }\nnew_healthy_probe app "$UNPAUSED_AT"`,
      ],
      {
        cwd: root,
        env: {
          ...process.env,
          HEALTH_JSON: JSON.stringify([
            {
              State: {
                Health: { Status: "healthy", Log: [{ Start: start, ExitCode: exitCode }] },
              },
            },
          ]),
          UNPAUSED_AT: "2026-08-11T20:00:00.000000000Z",
        },
      },
    ).status;
  assert.equal(probeStatus("2026-08-11T19:59:59.999999999Z"), 1);
  assert.equal(probeStatus("2026-08-11T20:00:00.000000001Z", 1), 1);
  assert.equal(probeStatus("2026-08-11T20:00:00.000000001Z"), 0);
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
  assert.match(candidateReadback, /status = 'APPROVED'/);
  assert.match(candidateReadback, /historical_reconciliation_outcome IS NULL/);
  assert.match(candidateReadback, /VALUES \('SHOPIFY'\), \('EBAY'\)/);
  assert.match(candidateReadback, /connections\.environment = 'PRODUCTION'/);
  assert.match(candidateReadback, /connections\.status = 'CONNECTED'/);
  assert.match(candidateReadback, /sync_cursors\.stream = 'history_import'/);
  assert.match(candidateReadback, /status NOT IN \('RECONCILED', 'CANCELLED'\)/);
  assert.doesNotMatch(candidateReadback, /aruba_send_permits/);
  assert.match(workflow, /compose\.yaml\.next/);
  assert.match(workflow, /Caddyfile\.next/);
  assert.match(
    workflow,
    /test -f \/opt\/hub-fatture\/\.deploy\.env && sudo test -f \/opt\/hub-fatture\/data\/operations\/deploy-receipt\.json; then sudo env HUB_FATTURE_ROOT=\/opt\/hub-fatture \/opt\/hub-fatture\/scripts\/backup\.sh pre-deploy/,
  );
  assert.doesNotMatch(workflow, /'\$target\/backup\.sh' pre-deploy/);
  const preDeployBackup = workflow.indexOf("/opt/hub-fatture/scripts/backup.sh pre-deploy");
  const candidateDeploy = workflow.indexOf("HUB_FATTURE_CANDIDATE_DIR='$target'");
  const operationalInstall = workflow.indexOf("sudo install -m 750 '$target/backup.sh'");
  assert.match(
    workflow.slice(operationalInstall),
    /'\$target\/production-release-candidate-readback\.sh'.*\/opt\/hub-fatture\/scripts\//,
  );
  assert.ok(
    preDeployBackup >= 0 &&
      preDeployBackup < candidateDeploy &&
      candidateDeploy < operationalInstall,
    "il bundle operativo candidato va installato solo dopo il readback del deploy",
  );
  assert.match(monitor, /app-web app-worker caddy postgres/);
  assert.match(monitor, /for service in app-web postgres/);
  assert.match(monitor, /jq -r '\.Health \/\/ empty'/);
  assert.match(monitor, /\[ "\$health" = "healthy" \]/);
  assert.match(monitor, /OCI_BACKUP_WARNING_BYTES:-15000000000/);
  assert.match(monitor, /oci os object list --auth instance_principal/);
  const sumObjectBytes = monitor.match(/sum_object_bytes\(\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(sumObjectBytes, "il calcolo dell’uso Object Storage deve essere isolabile");
  const summed = spawnSync(
    "sh",
    [
      "-c",
      `${sumObjectBytes}\nprintf '%s' '{"data":[{"size":12},{"size":30}]}' | sum_object_bytes`,
    ],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(summed.status, 0, summed.stderr);
  assert.equal(summed.stdout.trim(), "42");
  const addProblem = monitor.match(/add_problem\(\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(addProblem, "il monitor deve aggregare guasti concorrenti");
  const aggregated = spawnSync(
    "sh",
    [
      "-c",
      `problem=\n${addProblem}\nadd_problem worker\nadd_problem bucket\nprintf '%s' "$problem"`,
    ],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(aggregated.status, 0, aggregated.stderr);
  assert.equal(aggregated.stdout, "worker\nbucket");
  assert.doesNotMatch(monitor, /problem=\$\{problem:-/);
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

test("il dispatch Production richiede una decisione esplicita per 1.0.0", async () => {
  const dispatch = await readFile(path.join(root, "scripts/dispatch-production.sh"), "utf8");
  assert.match(dispatch, /contents\/package\.json\?ref=\$commit/);
  assert.match(dispatch, /if \[ "\$version" = "1\.0\.0" \]/);
  assert.match(dispatch, /il secondo argomento true\|false è obbligatorio/);
  assert.match(dispatch, /publish_release=true/);
});

test("la release usa sempre il nome canonico prima di diventare immutabile", async () => {
  const release = await readFile(path.join(root, "scripts/publish-github-release.sh"), "utf8");
  assert.match(release, /install -m 600 "\$manifest" "\$stage_dir\/release-manifest[.]json"/);
  assert.match(release, /gh release create "\$tag" "\$stage_dir\/release-manifest[.]json"/);
  assert.match(release, /--draft >\/dev\/null/);
  assert.match(release, /\.isDraft == true/);
  assert.match(release, /gh release edit "\$tag" --repo "\$repository" --draft=false --latest/);
  assert.match(release, /gh api -X DELETE "repos\/\$repository\/releases\/\$release_id"/);
  assert.match(release, /\[\.assets\[\][.]name\] == \["release-manifest[.]json"\]/);
  assert.doesNotMatch(release, /#["']?release-manifest[.]json/);
  const resolveTag = release.indexOf("if remote_tag_commit=$(resolve_remote_tag)");
  const createRelease = release.indexOf('gh release create "$tag"');
  const verifyDraft = release.indexOf("draft_release=$(gh release view");
  const publishRelease = release.indexOf('gh release edit "$tag"');
  const releaseVerified = release.indexOf("release_id=\nprintf");
  assert.ok(resolveTag >= 0 && resolveTag < createRelease);
  assert.ok(createRelease < verifyDraft && verifyDraft < publishRelease);
  assert.ok(publishRelease < releaseVerified);
  assert.match(release, /\[ "\$remote_tag_commit" = "\$commit" \]/);
  assert.match(release, /\[ "\$\(resolve_remote_tag\)" = "\$commit" \]/);
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

test("le approvazioni rileggono l'inventario Aruba sotto lock prima degli ordini", async () => {
  const [documents, refunds] = await Promise.all(
    ["src/db/documents.server.ts", "src/db/refunds.server.ts"].map((file) =>
      readFile(path.join(root, file), "utf8"),
    ),
  );
  const invoiceStart = documents.indexOf("export async function approveInvoice");
  const invoiceEnd = documents.indexOf("export async function", invoiceStart + 1);
  const invoiceApproval = documents.slice(invoiceStart, invoiceEnd);
  assert.ok(invoiceApproval.indexOf("getLockedArubaInventoryHealth") >= 0);
  assert.ok(invoiceApproval.indexOf("inventory.blocking") >= 0);
  assert.ok(
    invoiceApproval.indexOf("withTransaction") <
      invoiceApproval.indexOf("getLockedArubaInventoryHealth"),
  );
  assert.ok(
    invoiceApproval.indexOf("getLockedArubaInventoryHealth") <
      invoiceApproval.indexOf("serializeOrderMutations"),
  );
  assert.doesNotMatch(invoiceApproval, /(?:ensure|consume)ArubaPreflight/);

  const massStart = documents.indexOf("export async function approveInvoices");
  const massEnd = documents.indexOf("export async function", massStart + 1);
  const massApproval = documents.slice(massStart, massEnd < 0 ? undefined : massEnd);
  assert.ok(massApproval.indexOf("approveInvoice") >= 0);
  assert.doesNotMatch(massApproval, /requestArubaPreflight/);

  const creditStart = refunds.indexOf("export async function approveCreditNote");
  const creditEnd = refunds.indexOf("export async function", creditStart + 1);
  const creditApproval = refunds.slice(creditStart, creditEnd);
  assert.ok(creditApproval.indexOf("consumeArubaPreflight") >= 0);
  assert.ok(creditApproval.indexOf("consumeArubaPreflight") < creditApproval.indexOf("loadCredit"));
});
