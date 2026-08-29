import assert from "node:assert/strict";
import test from "node:test";
import { classifyFiles } from "./change-impact.mjs";
import {
  classifyPreflightFiles,
  preflightPlan,
  validateReleaseMetadata,
} from "./publish-preflight.mjs";

const scripts = (phase) => phase.map((entry) => entry.join(" "));

test("il preflight documentale resta minimo", () => {
  const plan = preflightPlan(classifyFiles(["docs/runbooks/production.md"]));
  assert.deepEqual(scripts(plan.core), ["npm run check:docs"]);
  assert.deepEqual(plan.parallel, []);
  assert.deepEqual(plan.browser, []);
});

test("il provider esegue Chromium e i contract test in parallelo ai gate specialistici", () => {
  const plan = preflightPlan(classifyFiles(["src/integrations/shopify.server.ts"]));
  assert.deepEqual(scripts(plan.core), ["npm run check:docs", "npm run check:standard"]);
  assert.deepEqual(scripts(plan.parallel), ["npm run test:provider"]);
  assert.deepEqual(scripts(plan.browser), ["npm run test:e2e:chromium"]);
});

test("la UI aggiunge WebKit al preflight locale", () => {
  const ui = preflightPlan(classifyFiles(["app/routes/home.tsx"]));
  assert.deepEqual(scripts(ui.browser), ["npm run test:e2e:chromium", "npm run test:e2e:webkit"]);
});

test("migrazioni attivano audit e database senza serializzarli", () => {
  const plan = preflightPlan(classifyFiles(["migrations/999_example.sql"]));
  assert.deepEqual(scripts(plan.parallel), ["npm run audit", "npm run test:db"]);
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
        lockVersion: "0.3.78",
        rootLockVersion: "0.3.78",
        version: "0.3.78",
      }),
    /non incrementa/,
  );
  assert.throws(
    () => validateReleaseMetadata({ ...valid, changelog: "# Changelog\n" }),
    /changelog 0\.3\.79 assente/,
  );
});
