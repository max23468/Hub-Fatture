import assert from "node:assert/strict";
import test from "node:test";
import { classifyFiles } from "./change-impact.mjs";
import {
  classifyPreflightFiles,
  diffCheckCommands,
  preflightPlan,
  validateReleaseMetadata,
} from "./publish-preflight.mjs";

const scripts = (phase) => phase.map((entry) => entry.join(" "));

test("il controllo whitespace e marcatori copre anche i commit rispetto alla base", () => {
  assert.deepEqual(scripts(diffCheckCommands("origin/main")), [
    "git diff --check",
    "git diff --check origin/main HEAD",
  ]);
});

test("il preflight documentale resta minimo", () => {
  const plan = preflightPlan(classifyFiles(["docs/runbooks/production.md"]));
  assert.deepEqual(scripts(plan.setup), ["npm run check:docs"]);
  assert.deepEqual(plan.core, []);
  assert.deepEqual(plan.parallel, []);
});

test("il provider esegue Chromium e i contract test in parallelo ai gate specialistici", () => {
  const plan = preflightPlan(classifyFiles(["src/integrations/shopify.server.ts"]));
  assert.deepEqual(scripts(plan.setup), ["npm run check:docs"]);
  assert.deepEqual(scripts(plan.core), ["npm run check:standard"]);
  assert.deepEqual(scripts(plan.parallel), [
    "npm run test:provider",
    "env TEST_DATABASE_LANE=e2e_chromium PLAYWRIGHT_BASE_URL=http://127.0.0.1:4173 DOCUMENT_STORAGE_ROOT=storage/e2e-documents-chromium npm run test:e2e:chromium:prepared",
  ]);
});

test("la UI aggiunge WebKit al preflight locale", () => {
  const ui = preflightPlan(classifyFiles(["app/routes/home.tsx"]));
  assert.equal(ui.parallel.length, 2);
  assert.match(scripts(ui.parallel)[1], /TEST_DATABASE_LANE=e2e_webkit/);
});

test("migrazioni completano l'audit prima del database", () => {
  const plan = preflightPlan(classifyFiles(["migrations/999_example.sql"]));
  assert.deepEqual(scripts(plan.setup), ["npm run check:docs", "npm run audit"]);
  assert.deepEqual(scripts(plan.core), ["npm run check:standard"]);
  assert.match(scripts(plan.parallel)[0], /TEST_DATABASE_LANE=db/);
});

test("una modifica all'autorità del classificatore forza il preflight completo", () => {
  const impact = classifyPreflightFiles(["scripts/change-impact.mjs"]);
  assert.equal(impact.failClosed, true);
  assert.equal(impact.database, true);
  assert.equal(impact.provider, true);
  assert.equal(impact.e2eWebkit, true);
});

test("i metadati release runtime devono essere completi prima dei gate", () => {
  const valid = {
    baseVersion: "0.3.78",
    changelog: "# Changelog\n\n## 0.3.79\n\n- Pubblicazione proporzionata.\n",
    lockVersion: "0.3.79",
    rootLockVersion: "0.3.79",
    version: "0.3.79",
  };
  assert.doesNotThrow(() => validateReleaseMetadata(valid));
  assert.throws(
    () => validateReleaseMetadata({ ...valid, lockVersion: "0.3.78" }),
    /non allineata/,
  );
  assert.throws(
    () =>
      validateReleaseMetadata({
        ...valid,
        lockVersion: "0.3.77",
        rootLockVersion: "0.3.77",
        version: "0.3.77",
      }),
    /non incrementa/,
  );
  assert.throws(
    () => validateReleaseMetadata({ ...valid, changelog: "# Changelog\n" }),
    /changelog 0\.3\.79 assente/,
  );
});

test("un candidato runtime può essere sostituito soltanto prima del tag definitivo", () => {
  const candidate = {
    baseVersion: "1.0.1",
    changelog: "# Changelog\n\n## 1.0.1\n\n- Candidato sostitutivo.\n",
    lockVersion: "1.0.1",
    rootLockVersion: "1.0.1",
    version: "1.0.1",
  };
  assert.doesNotThrow(() => validateReleaseMetadata(candidate));
  assert.throws(
    () => validateReleaseMetadata({ ...candidate, releaseTagExists: true }),
    /già pubblicata/,
  );
});
