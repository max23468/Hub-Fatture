import assert from "node:assert/strict";
import test from "node:test";
import { classifyFiles } from "./change-impact.mjs";
import { classifyPreflightFiles, preflightPlan } from "./publish-preflight.mjs";

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

test("UI ed Aruba aggiungono WebKit e la ricevuta della piattaforma locale", () => {
  const ui = preflightPlan(classifyFiles(["app/routes/home.tsx"]));
  assert.deepEqual(scripts(ui.browser), ["npm run test:e2e:chromium", "npm run test:e2e:webkit"]);

  const aruba = preflightPlan(classifyFiles(["scripts/aruba-helper.ts"]), "darwin");
  assert.deepEqual(scripts(aruba.browser), [
    "npm run test:e2e:chromium",
    "npm run test:e2e:webkit",
    "npm run test:aruba:platform -- chrome",
  ]);
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
  assert.equal(impact.arubaPlatform, true);
});
