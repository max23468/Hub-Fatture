import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const digest = (character) => `sha256:${character.repeat(64)}`;

test("rimuove soltanto immagini Hub Fatture non live, rollback o in uso", () => {
  const root = mkdtempSync(path.join(tmpdir(), "hub-fatture-image-retention-"));
  const bin = path.join(root, "bin");
  const operations = path.join(root, "data", "operations");
  const removals = path.join(root, "removed-images");
  const liveDigest = digest("a");
  const rollbackDigest = digest("b");
  const liveId = digest("1");
  const rollbackId = digest("2");
  const runningId = digest("3");
  const staleId = digest("4");
  const foreignId = digest("5");

  mkdirSync(bin, { recursive: true });
  mkdirSync(operations, { recursive: true });
  writeFileSync(path.join(root, ".deploy.env"), `APP_IMAGE_DIGEST=${liveDigest}\n`);
  writeFileSync(path.join(operations, "rollback.env"), `APP_IMAGE_DIGEST=${rollbackDigest}\n`);
  writeFileSync(
    path.join(bin, "docker"),
    `#!/bin/sh
set -eu
live_ref='ghcr.io/max23468/hub-fatture@${liveDigest}'
rollback_ref='ghcr.io/max23468/hub-fatture@${rollbackDigest}'
live_id='${liveId}'
rollback_id='${rollbackId}'
running_id='${runningId}'
stale_id='${staleId}'
foreign_id='${foreignId}'
case "$1 $2" in
  'image inspect')
    if [ "\${3:-}" = --format ]; then
      format=$4
      target=$5
      case "$format" in
        *'.Id'*)
          case "$target" in
            "$live_ref"|"$live_id") printf '%s\\n' "$live_id" ;;
            "$rollback_ref"|"$rollback_id") printf '%s\\n' "$rollback_id" ;;
            *) printf '%s\\n' "$target" ;;
          esac
          ;;
        *'org.opencontainers.image.source'*)
          [ "$target" = "$foreign_id" ] || printf '%s\\n' 'https://github.com/max23468/Hub-Fatture'
          ;;
      esac
    fi
    ;;
  'image ls') printf '%s\\n' "$live_id" "$rollback_id" "$running_id" "$stale_id" "$foreign_id" ;;
  'image rm') printf '%s\\n' "$3" >> '${removals}' ;;
  'ps -aq') printf '%s\\n' running-container ;;
  'inspect --format') printf '%s\\n' "$running_id" ;;
  *) echo "Comando Docker inatteso: $*" >&2; exit 1 ;;
esac
`,
  );
  writeFileSync(path.join(bin, "flock"), "#!/bin/sh\nexit 0\n");
  chmodSync(path.join(bin, "docker"), 0o755);
  chmodSync(path.join(bin, "flock"), 0o755);

  const environment = {
    ...process.env,
    HUB_FATTURE_ROOT: root,
    SHARED_DOCKER_LOCK: path.join(root, "shared.lock"),
    PATH: `${bin}:${process.env.PATH}`,
  };

  try {
    const dryRun = execFileSync("sh", ["scripts/prune-docker-images.sh", "--dry-run"], {
      cwd: process.cwd(),
      env: environment,
      encoding: "utf8",
    });
    assert.match(dryRun, new RegExp(staleId));
    assert.doesNotMatch(dryRun, new RegExp(liveId));
    assert.doesNotMatch(dryRun, new RegExp(rollbackId));
    assert.doesNotMatch(dryRun, new RegExp(runningId));

    execFileSync("sh", ["scripts/prune-docker-images.sh"], {
      cwd: process.cwd(),
      env: environment,
    });
    assert.equal(readFileSync(removals, "utf8"), `${staleId}\n`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("la selezione richiede ID Docker completi", () => {
  const script = readFileSync("scripts/prune-docker-images.sh", "utf8");
  assert.match(script, /docker image ls --no-trunc -aq/);
  assert.doesNotMatch(script, /docker image ls -aq/);
});
