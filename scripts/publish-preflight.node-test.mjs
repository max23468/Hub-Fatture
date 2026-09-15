import assert from "node:assert/strict";
import test from "node:test";
import { classifyFiles } from "./change-impact.mjs";
import {
  classifyPreflightFiles,
  diffCheckCommands,
  findDisallowedActions,
  preflightPlan,
  validateReleaseMetadata,
  workflowActionReferences,
} from "./publish-preflight.mjs";

const scripts = (phase) => phase.map((entry) => entry.join(" "));

test("il controllo whitespace e marcatori copre anche i commit rispetto alla base", () => {
  assert.deepEqual(scripts(diffCheckCommands("origin/main")), [
    "git diff --check",
    "git diff --check origin/main HEAD",
  ]);
});

test("un'Action esclusa dalle Action consentite blocca il preflight prima della PR", () => {
  const workflow = `
jobs:
  verify:
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7
      - uses: ./.github/actions/local
      - uses: docker/login-action@dbcb813823bdd20940b903addbd779551569679f # v4.6.0
      - id: doctor
        uses: "millionco/react-doctor@013f7373f91a3b9e68bd1dc7d4d354f4b041b117" # v2.2.9
      - uses: millionco/react-doctor@01820bb4fd4d0a4aebcd8df2b2a143a098649cb2 # v2.2.8
      - uses: jdx/mise-action@v4
`;
  const references = workflowActionReferences(workflow);
  assert.equal(references.includes("./.github/actions/local"), false);

  const permissions = { allowed_actions: "selected", sha_pinning_required: true };
  const selected = {
    github_owned_allowed: true,
    patterns_allowed: [
      "millionco/react-doctor@01820bb4fd4d0a4aebcd8df2b2a143a098649cb2",
      "docker/login-action@*",
      "jdx/mise-action@*",
    ],
  };
  assert.deepEqual(findDisallowedActions(references, permissions, selected), [
    "millionco/react-doctor@013f7373f91a3b9e68bd1dc7d4d354f4b041b117: non ammessa dalle Action consentite della repository",
    "jdx/mise-action@v4: non fissata a uno SHA completo",
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
