import assert from "node:assert/strict";
import test from "node:test";
import { changelogSection, releaseManifest } from "./prepare-production-release.mjs";

test("estrae soltanto la versione richiesta dal changelog", () => {
  assert.equal(
    changelogSection("# C\n\n## 1.2.3\n\n- Uno\n\n## 1.2.2\n\n- Due\n", "1.2.3"),
    "- Uno",
  );
});

test("costruisce un manifest completo e rifiuta digest ambigui", () => {
  const values = {
    attestation: "https://github.com/example/repository/attestations/42",
    commit: "a".repeat(40),
    imageDigest: `sha256:${"b".repeat(64)}`,
    rollbackDigest: `sha256:${"c".repeat(64)}`,
    schema: "019_example.sql",
    version: "1.2.3",
  };
  assert.deepEqual(releaseManifest(values), values);
  assert.deepEqual(releaseManifest({ ...values, rollbackDigest: null }).rollbackDigest, null);
  assert.throws(() => releaseManifest({ ...values, imageDigest: "latest" }), /Digest/);
  assert.throws(() => releaseManifest({ ...values, rollbackDigest: "latest" }), /Digest/);
});
