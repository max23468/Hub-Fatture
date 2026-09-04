import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(repository, "scripts", "production-release-candidate-readback.sh");

async function fixture(blockingArubaBatches) {
  const root = await mkdtemp(path.join(os.tmpdir(), "hub-fatture-candidate-readback-"));
  const bin = path.join(root, "bin");
  const scripts = path.join(root, "scripts");
  await Promise.all([mkdir(bin), mkdir(scripts)]);
  await writeFile(
    path.join(scripts, "production-readback.sh"),
    '#!/bin/sh\nprintf \'%s\\n\' \'{"status":"ok","arubaSubmissionEnabled":false}\'\n',
    { mode: 0o755 },
  );
  await writeFile(
    path.join(bin, "docker"),
    `#!/bin/sh
printf '%s\\n' '{"unreconciledDryRunAttempts":0,"unreconciledHistory":0,"pendingHistoryImports":0,"openArubaBatches":1,"blockingArubaBatches":${blockingArubaBatches}}'
`,
    { mode: 0o755 },
  );
  await chmod(source, 0o755);
  return { root, bin };
}

function run({ root, bin }) {
  return spawnSync(source, [], {
    cwd: repository,
    encoding: "utf8",
    env: { ...process.env, HUB_FATTURE_ROOT: root, PATH: `${bin}:${process.env.PATH}` },
  });
}

test("ammette un batch DOCUMENT_ONLY riconciliato ma ancora aperto", async () => {
  const state = await fixture(0);
  try {
    const result = run(state);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).openArubaBatches, 1);
  } finally {
    await rm(state.root, { recursive: true, force: true });
  }
});

test("blocca un batch Aruba realmente outbound", async () => {
  const state = await fixture(1);
  try {
    const result = run(state);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Batch Aruba outbound bloccanti presenti/);
  } finally {
    await rm(state.root, { recursive: true, force: true });
  }
});
