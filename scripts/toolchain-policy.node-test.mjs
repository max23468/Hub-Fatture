import assert from "node:assert/strict";
import test from "node:test";

import { findForbiddenPackages } from "./toolchain-policy.mjs";

test("blocca pacchetti ESLint e Prettier in ogni sezione", () => {
  assert.deepEqual(
    findForbiddenPackages({
      dependencies: { eslint: "1", "@typescript-eslint/parser": "1" },
      devDependencies: { prettier: "1", "prettier-plugin-example": "1", oxlint: "1" },
    }),
    ["eslint", "@typescript-eslint/parser", "prettier", "prettier-plugin-example"],
  );
});
