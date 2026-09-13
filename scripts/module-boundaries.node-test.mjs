import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoots = ["app", "src"];
const sourceExtension = /\.(?:ts|tsx|mjs)$/;
const importPattern = /(?:from\s+|import\s*)["'](\.[^"']+)["']/g;

async function sourceFiles(directory) {
  const entries = await readdir(path.join(root, directory), { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const relative = path.join(directory, entry.name);
      return entry.isDirectory()
        ? sourceFiles(relative)
        : Promise.resolve(sourceExtension.test(entry.name) ? [relative] : []);
    }),
  );
  return nested.flat();
}

function localDependency(from, specifier, files) {
  const resolved = path.normalize(path.join(path.dirname(from), specifier));
  if (files.has(resolved)) return resolved;
  for (const extension of [".ts", ".tsx", ".mjs"]) {
    if (files.has(resolved + extension)) return resolved + extension;
  }
  return null;
}

test("i moduli applicativi non formano cicli di import", async () => {
  const names = (await Promise.all(sourceRoots.map(sourceFiles))).flat();
  const files = new Set(names);
  const graph = new Map();
  await Promise.all(
    names.map(async (name) => {
      const source = await readFile(path.join(root, name), "utf8");
      const dependencies = [];
      for (const match of source.matchAll(importPattern)) {
        const dependency = localDependency(name, match[1], files);
        if (dependency) dependencies.push(dependency);
      }
      graph.set(name, dependencies);
    }),
  );

  const visited = new Set();
  const active = new Set();
  const stack = [];
  const cycles = [];

  function visit(name) {
    if (active.has(name)) {
      const start = stack.indexOf(name);
      cycles.push([...stack.slice(start), name].join(" -> "));
      return;
    }
    if (visited.has(name)) return;
    visited.add(name);
    active.add(name);
    stack.push(name);
    for (const dependency of graph.get(name) ?? []) visit(dependency);
    stack.pop();
    active.delete(name);
  }

  for (const name of names) visit(name);
  assert.deepEqual(cycles, []);
});
