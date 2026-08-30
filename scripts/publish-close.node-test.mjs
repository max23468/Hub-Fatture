import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("publish-close.mjs", import.meta.url));

function git(cwd, ...args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

async function fixture() {
  const sandbox = await mkdtemp(path.join(os.tmpdir(), "hub-fatture-publish-close-"));
  const remote = path.join(sandbox, "remote.git");
  const primary = path.join(sandbox, "primary");
  const maintainer = path.join(sandbox, "maintainer");
  const feature = path.join(sandbox, "feature");
  const concurrent = path.join(sandbox, "concurrent");
  const fakeBin = path.join(sandbox, "bin");

  await mkdir(remote);
  git(remote, "init", "--bare");
  await mkdir(primary);
  git(primary, "init", "-b", "main");
  git(primary, "config", "user.email", "test@example.invalid");
  git(primary, "config", "user.name", "Test sintetico");
  await writeFile(path.join(primary, ".gitignore"), "node_modules/\n");
  await writeFile(path.join(primary, "base.txt"), "base\n");
  git(primary, "add", ".gitignore", "base.txt");
  git(primary, "commit", "-m", "base");
  git(primary, "remote", "add", "origin", remote);
  git(primary, "push", "-u", "origin", "main");

  git(primary, "worktree", "add", "-b", "codex/feature", feature, "main");
  await mkdir(path.join(feature, "node_modules"));
  await writeFile(path.join(feature, "node_modules", ".fixture"), "dipendenza ignorata\n");
  await writeFile(path.join(feature, "feature.txt"), "feature\n");
  git(feature, "add", "feature.txt");
  git(feature, "commit", "-m", "feature");
  const featureSha = git(feature, "rev-parse", "HEAD");
  git(feature, "push", "-u", "origin", "codex/feature");

  git(primary, "worktree", "add", "-b", "codex/concurrent", concurrent, "main");
  await writeFile(path.join(concurrent, "concurrent.txt"), "preserva\n");

  git(sandbox, "clone", remote, maintainer);
  git(maintainer, "config", "user.email", "test@example.invalid");
  git(maintainer, "config", "user.name", "Maintainer sintetico");
  git(maintainer, "checkout", "main");
  git(maintainer, "merge", "--squash", "origin/codex/feature");
  git(maintainer, "commit", "-m", "merge sintetico");
  const mergeSha = git(maintainer, "rev-parse", "HEAD");
  git(maintainer, "push", "origin", "main");

  await mkdir(fakeBin);
  const fakeGh = path.join(fakeBin, "gh");
  await writeFile(
    fakeGh,
    `#!/bin/sh\nprintf '%s\\n' '[{"number":17,"headRefName":"codex/feature","headRefOid":"${featureSha}","baseRefName":"main","mergeCommit":{"oid":"${mergeSha}"}}]'\n`,
  );
  await chmod(fakeGh, 0o755);

  return { sandbox, primary, feature, concurrent, fakeBin, mergeSha, remote };
}

test("chiude soltanto il ciclo assorbito e preserva i worktree concorrenti", async () => {
  const value = await fixture();
  try {
    git(value.remote, "update-ref", "-d", "refs/heads/codex/feature");
    assert.equal(
      git(value.primary, "rev-parse", "refs/remotes/origin/codex/feature"),
      git(value.primary, "rev-parse", "refs/heads/codex/feature"),
    );
    const output = execFileSync("node", [script, "codex/feature", value.feature], {
      cwd: value.primary,
      env: { ...process.env, PATH: `${value.fakeBin}:${process.env.PATH}` },
      encoding: "utf8",
    });
    assert.equal(git(value.primary, "rev-parse", "HEAD"), value.mergeSha);
    assert.equal(git(value.primary, "rev-parse", "origin/main"), value.mergeSha);
    assert.notEqual(
      spawnSync("git", ["show-ref", "--verify", "refs/heads/codex/feature"], {
        cwd: value.primary,
      }).status,
      0,
    );
    assert.equal(
      git(value.primary, "ls-remote", "--heads", "origin", "refs/heads/codex/feature"),
      "",
    );
    assert.notEqual(
      spawnSync("git", ["show-ref", "--verify", "refs/remotes/origin/codex/feature"], {
        cwd: value.primary,
      }).status,
      0,
    );
    assert.match(
      git(value.primary, "worktree", "list", "--porcelain"),
      new RegExp(value.concurrent),
    );
    assert.match(await readFile(path.join(value.concurrent, "concurrent.txt"), "utf8"), /preserva/);
    assert.match(output, /Chiusura verificata per PR #17/);
    assert.match(output, /codex\/concurrent/);
  } finally {
    await rm(value.sandbox, { recursive: true, force: true });
  }
});

test("rifiuta un worktree sporco senza rimuovere branch o riferimenti remoti", async () => {
  const value = await fixture();
  try {
    await writeFile(path.join(value.feature, "feature.txt"), "modifica non salvata\n");
    const result = spawnSync("node", [script, "codex/feature", value.feature], {
      cwd: value.primary,
      env: { ...process.env, PATH: `${value.fakeBin}:${process.env.PATH}` },
      encoding: "utf8",
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /contiene modifiche locali/);
    assert.equal(git(value.primary, "rev-parse", "refs/heads/codex/feature").length, 40);
    assert.notEqual(
      git(value.primary, "ls-remote", "--heads", "origin", "refs/heads/codex/feature"),
      "",
    );
    assert.match(git(value.primary, "worktree", "list", "--porcelain"), new RegExp(value.feature));
  } finally {
    await rm(value.sandbox, { recursive: true, force: true });
  }
});
