import assert from "node:assert/strict";
import test from "node:test";

import {
  arubaSubmissionIsTerminal,
  arubaSubmissionJobPriority,
  arubaSubmissionTransition,
} from "./aruba-submission-state.ts";

test("le transizioni Aruba avanzano senza regressioni", () => {
  assert.equal(arubaSubmissionTransition("ARUBA_ACCEPTED", "SDI_PROCESSING"), "ADVANCE");
  assert.equal(arubaSubmissionTransition("ARUBA_ACCEPTED", "DELIVERED"), "ADVANCE");
  assert.equal(arubaSubmissionTransition("SDI_PROCESSING", "SUBMITTED"), "ADVANCE");
  assert.equal(arubaSubmissionTransition("SUBMITTED", "SDI_PROCESSING"), "STALE");
  assert.equal(arubaSubmissionTransition("DELIVERED", "REJECTED"), "CONFLICT");
  assert.equal(arubaSubmissionTransition("NOT_DELIVERED", "NOT_DELIVERED"), "SAME");
  assert.equal(arubaSubmissionIsTerminal("REJECTED"), true);
});

test("la priorità favorisce stato incerto, accettazione e non terminali", () => {
  assert.equal(arubaSubmissionJobPriority("UNKNOWN_REMOTE_STATE"), 10);
  assert.equal(arubaSubmissionJobPriority("ARUBA_ACCEPTED"), 20);
  assert.equal(arubaSubmissionJobPriority("SUBMITTED"), 30);
  assert.equal(arubaSubmissionJobPriority("DELIVERED", true), 40);
});
