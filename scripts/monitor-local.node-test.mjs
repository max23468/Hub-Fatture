import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

test("la sola segnalazione conserva l'allarme senza retrocedere un deploy verificato", () => {
  const root = mkdtempSync(path.join(tmpdir(), "hub-fatture-monitor-report-only-"));
  const bin = path.join(root, "bin");
  const scripts = path.join(root, "scripts");
  const operations = path.join(root, "data", "operations");

  mkdirSync(bin, { recursive: true });
  mkdirSync(scripts, { recursive: true });
  mkdirSync(operations, { recursive: true });
  copyFileSync("scripts/read-env.sh", path.join(scripts, "read-env.sh"));
  writeFileSync(
    path.join(root, ".env"),
    "OCI_NOTIFICATIONS_TOPIC_OCID=\nOCI_BACKUP_BUCKET=synthetic\nOCI_NAMESPACE=synthetic\n",
  );
  writeFileSync(path.join(root, ".deploy.env"), "APP_VERSION=synthetic\n");
  writeFileSync(
    path.join(operations, "backup-receipt.json"),
    `${JSON.stringify({
      status: "ok",
      completedAt: new Date().toISOString(),
      objectName: "hub-fatture/current/latest.tar.age",
      archiveObjectName: "hub-fatture/archive/synthetic-database.tar.age",
      archiveKind: "DATABASE_JOURNAL",
      sha256: "a".repeat(64),
      archiveSha256: "b".repeat(64),
      sizeBytes: 1_000,
      archiveSizeBytes: 100,
    })}\n`,
  );
  writeFileSync(
    path.join(bin, "docker"),
    `#!/bin/sh
case "$*" in
  *'ps --status running --services') printf '%s\\n' app-web app-worker caddy postgres ;;
  *'ps --format json app-web'|*'ps --format json postgres') printf '%s\\n' '{"Health":"healthy"}' ;;
  *) echo "Comando Docker inatteso: $*" >&2; exit 1 ;;
esac
`,
  );
  writeFileSync(
    path.join(bin, "df"),
    "#!/bin/sh\nprintf '%s\\n' 'Filesystem 1024-blocks Used Available Capacity Mounted on' 'synthetic 100 10 90 10% /'\n",
  );
  writeFileSync(
    path.join(bin, "oci"),
    "#!/bin/sh\nprintf '%s\\n' '{\"data\":[{\"size\":16000000000}]}'\n",
  );
  writeFileSync(
    path.join(bin, "date"),
    `#!/bin/sh
case "$*" in
  '-u +%s') printf '%s\\n' 2000000001 ;;
  '-u -d '*'+%s') printf '%s\\n' 2000000000 ;;
  *) echo "Comando date inatteso: $*" >&2; exit 1 ;;
esac
`,
  );
  for (const command of ["docker", "df", "oci", "date"]) chmodSync(path.join(bin, command), 0o755);

  const environment = {
    ...process.env,
    HUB_FATTURE_ROOT: root,
    PATH: `${bin}:${process.env.PATH}`,
  };

  try {
    const blocking = spawnSync("sh", ["scripts/monitor-local.sh"], {
      cwd: process.cwd(),
      env: environment,
      encoding: "utf8",
    });
    assert.equal(blocking.status, 1);
    assert.match(blocking.stderr, /bucket backup oltre soglia prudenziale/);

    const reportOnly = spawnSync("sh", ["scripts/monitor-local.sh", "--report-only"], {
      cwd: process.cwd(),
      env: environment,
      encoding: "utf8",
    });
    assert.equal(reportOnly.status, 0, reportOnly.stderr);
    assert.match(reportOnly.stderr, /bucket backup oltre soglia prudenziale/);
    assert.match(reportOnly.stdout, /il readback del deploy resta valido/);
    assert.equal(
      readFileSync(path.join(operations, "monitor-state"), "utf8"),
      "bucket backup oltre soglia prudenziale\n",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
