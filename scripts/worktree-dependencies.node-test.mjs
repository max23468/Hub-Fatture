import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("worktree-dependencies.sh", import.meta.url));
const createScript = fileURLToPath(new URL("create-worktree.sh", import.meta.url));

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

test("il bootstrap condivide dipendenze compatibili e isola un lockfile diverso", async () => {
  const sandbox = await mkdtemp(path.join(os.tmpdir(), "hub-fatture-worktree-"));
  const primary = path.join(sandbox, "primary");
  const worktree = path.join(sandbox, "feature");
  const fakeBin = path.join(sandbox, "bin");
  try {
    await mkdir(primary);
    git(primary, "init", "-b", "main");
    git(primary, "config", "user.email", "test@example.invalid");
    git(primary, "config", "user.name", "Test sintetico");
    await writeFile(path.join(primary, "package.json"), '{"name":"fixture","private":true}\n');
    await writeFile(path.join(primary, "package-lock.json"), '{"lockfileVersion":3}\n');
    await mkdir(path.join(primary, "node_modules"));
    await writeFile(path.join(primary, "node_modules", ".fixture"), "ok\n");
    await mkdir(path.join(primary, "scripts"));
    await writeFile(
      path.join(primary, "scripts", "create-worktree.sh"),
      await readFile(createScript),
    );
    await writeFile(
      path.join(primary, "scripts", "worktree-dependencies.sh"),
      await readFile(script),
    );
    await chmod(path.join(primary, "scripts", "create-worktree.sh"), 0o755);
    await chmod(path.join(primary, "scripts", "worktree-dependencies.sh"), 0o755);
    git(primary, "add", "package.json", "package-lock.json", "scripts");
    git(primary, "commit", "-m", "fixture");

    execFileSync(
      "sh",
      [path.join(primary, "scripts", "create-worktree.sh"), "feature", worktree, "main"],
      { cwd: primary, stdio: "pipe" },
    );
    assert.equal((await lstat(path.join(worktree, "node_modules"))).isSymbolicLink(), true);
    assert.equal(
      await realpath(path.join(worktree, "node_modules")),
      await realpath(path.join(primary, "node_modules")),
    );
    await writeFile(
      path.join(worktree, "package-lock.json"),
      '{"lockfileVersion":3,"changed":true}\n',
    );
    await mkdir(fakeBin);
    const fakeNpm = path.join(fakeBin, "npm");
    await writeFile(
      fakeNpm,
      "#!/bin/sh\nset -eu\nmkdir -p node_modules\ntouch node_modules/.installed\n",
    );
    await chmod(fakeNpm, 0o755);
    execFileSync("sh", [path.join(worktree, "scripts", "worktree-dependencies.sh"), worktree], {
      env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}` },
      stdio: "pipe",
    });
    assert.equal((await lstat(path.join(worktree, "node_modules"))).isSymbolicLink(), false);
    assert.equal((await lstat(path.join(worktree, "node_modules", ".installed"))).isFile(), true);
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});
