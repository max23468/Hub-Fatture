import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(repository, "scripts", "production-submission-mode.sh");
const commit = "a".repeat(40);
const digest = `sha256:${"b".repeat(64)}`;

async function executable(file, content) {
  await writeFile(file, content, { mode: 0o755 });
  await chmod(file, 0o755);
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "hub-fatture-submission-test-"));
  const bin = path.join(root, "bin");
  const scripts = path.join(root, "scripts");
  const operations = path.join(root, "data", "operations");
  await Promise.all([mkdir(bin), mkdir(scripts), mkdir(operations, { recursive: true })]);
  await writeFile(path.join(root, ".env"), "ARUBA_SUBMISSION_ENABLED=false\n", { mode: 0o600 });
  await writeFile(path.join(root, ".deploy.env"), "APP_VERSION=1.0.1\n", { mode: 0o600 });
  await writeFile(path.join(root, "compose.yaml"), "services: {}\n");
  await writeFile(
    path.join(operations, "deploy-receipt.json"),
    JSON.stringify({ commit, imageDigest: digest, applicationVersion: "1.0.1" }),
  );
  await executable(
    path.join(bin, "docker"),
    `#!/bin/sh
printf '%s\\n' "$*" >>"$FAKE_DOCKER_LOG"
case "$*" in
  *"exec -T app-web node build-server/operations/release-candidate-readiness.js"*)
    printf '%s\\n' '{"unsafeApprovedDocuments":0,"unreconciledHistory":0,"pendingHistoryImports":0,"openArubaBatches":0}' ;;
  *"exec -T postgres psql"*) printf '%s\\n' 0 ;;
esac
`,
  );
  await executable(path.join(bin, "stat"), "#!/bin/sh\nprintf '%s\\n' 600\n");
  await executable(path.join(bin, "flock"), "#!/bin/sh\nexit 0\n");
  await executable(path.join(bin, "chown"), "#!/bin/sh\nexit 0\n");
  await executable(
    path.join(scripts, "production-readback.sh"),
    `#!/bin/sh
expected=\${1:-false}
current=$(sed -n 's/^ARUBA_SUBMISSION_ENABLED=//p' .env)
if [ "\${FAIL_TRUE:-0}" = 1 ] && [ "$expected" = true ]; then exit 1; fi
[ "$current" = "$expected" ] || exit 1
jq -n --arg commit '${commit}' --arg digest '${digest}' --argjson enabled "$current" \
  '{status:"ok",commit:$commit,imageDigest:$digest,applicationVersion:"1.0.1",schema:"063_example.sql",arubaSubmissionEnabled:$enabled}'
`,
  );
  await chmod(source, 0o755);
  return { root, bin, dockerLog: path.join(root, "docker.log") };
}

function run({ root, bin, dockerLog }, mode, extraEnv = {}) {
  return spawnSync(source, [mode, commit], {
    cwd: repository,
    encoding: "utf8",
    env: {
      ...process.env,
      ...extraEnv,
      FAKE_DOCKER_LOG: dockerLog,
      HUB_FATTURE_ROOT: root,
      PATH: `${bin}:${process.env.PATH}`,
    },
  });
}

test("abilita il flag soltanto dopo lo stop e conserva una ricevuta sanitizzata", async () => {
  const state = await fixture();
  try {
    const result = run(state, "enable");
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      await readFile(path.join(state.root, ".env"), "utf8"),
      "ARUBA_SUBMISSION_ENABLED=true\n",
    );
    const receipt = JSON.parse(
      await readFile(
        path.join(state.root, "data", "operations", "aruba-submission-mode-receipt.json"),
        "utf8",
      ),
    );
    assert.equal(receipt.commit, commit);
    assert.equal(receipt.imageDigest, digest);
    assert.equal(receipt.arubaSubmissionEnabled, true);
    assert.equal(receipt.operation, "enable");
    const calls = await readFile(state.dockerLog, "utf8");
    assert.ok(
      calls.indexOf("stop --timeout 180 app-web app-worker") <
        calls.lastIndexOf("exec -T postgres psql"),
    );
    assert.match(calls, /up -d --wait --force-recreate app-web app-worker/);
  } finally {
    await rm(state.root, { recursive: true, force: true });
  }
});

test("ripristina false quando il readback dopo l'abilitazione fallisce", async () => {
  const state = await fixture();
  try {
    const result = run(state, "enable", { FAIL_TRUE: "1" });
    assert.equal(result.status, 1);
    assert.equal(
      await readFile(path.join(state.root, ".env"), "utf8"),
      "ARUBA_SUBMISSION_ENABLED=false\n",
    );
    assert.match(result.stderr, /Configurazione precedente ripristinata/);
  } finally {
    await rm(state.root, { recursive: true, force: true });
  }
});
