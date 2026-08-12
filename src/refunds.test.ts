import assert from "node:assert/strict";
import test from "node:test";

import { creditableRemainder, preIssueRefund } from "./refunds.ts";

test("residuo accreditabile e rimborsi prima dell’emissione", () => {
  assert.equal(creditableRemainder(10_000, 2_500), 7_500);
  assert.throws(() => creditableRemainder(10_000, 10_001), /superano/);
  assert.deepEqual(preIssueRefund(10_000, [{ status: "COMPLETED", amount: 2_500 }]), {
    state: "PARTIAL",
    billableAmount: 7_500,
  });
  assert.deepEqual(preIssueRefund(10_000, [{ status: "COMPLETED", amount: 10_000 }]), {
    state: "TOTAL",
    billableAmount: 0,
  });
  assert.deepEqual(preIssueRefund(10_000, [{ status: "PENDING", amount: 2_500 }]), {
    state: "UNCHANGED",
    billableAmount: 10_000,
  });
  assert.deepEqual(preIssueRefund(10_000, [{ status: "PENDING", amount: null }]), {
    state: "UNCHANGED",
    billableAmount: 10_000,
  });
  assert.deepEqual(preIssueRefund(10_000, [{ status: "FAILED", amount: null }]), {
    state: "UNCHANGED",
    billableAmount: 10_000,
  });
  assert.deepEqual(
    preIssueRefund(10_000, [
      { status: "COMPLETED", amount: 2_500 },
      { status: "PENDING", amount: 1_000 },
    ]),
    { state: "PARTIAL", billableAmount: 7_500 },
  );
  assert.deepEqual(preIssueRefund(10_000, [{ status: "AMBIGUOUS", amount: null }]), {
    state: "NEEDS_REVIEW",
    billableAmount: 10_000,
  });
  assert.deepEqual(preIssueRefund(10_000, [{ status: "COMPLETED", amount: 2_500 }], 9_500), {
    state: "PARTIAL",
    billableAmount: 7_000,
  });
  assert.deepEqual(preIssueRefund(10_000, [{ status: "COMPLETED", amount: 9_600 }], 9_500), {
    state: "NEEDS_REVIEW",
    billableAmount: 9_500,
  });
});
