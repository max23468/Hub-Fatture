import assert from "node:assert/strict";
import test from "node:test";

import { AppError, publicError } from "./errors.ts";

test("espone gli errori applicativi e propaga le Response", () => {
  assert.deepEqual(publicError(new AppError("ORDER_INVALID_INPUT", 422)), {
    code: "ORDER_INVALID_INPUT",
    message: "I dati dell’ordine non sono validi.",
    status: 422,
  });
  assert.deepEqual(publicError(new AppError("BILLING_CASE_EMPTY", 409)), {
    code: "BILLING_CASE_EMPTY",
    message: "Una preparazione senza ordini resta archiviata e non può essere riattivata.",
    status: 409,
  });
  const redirect = new Response(null, { status: 302, headers: { location: "/login" } });
  assert.throws(
    () => publicError(redirect),
    (error) => error === redirect,
  );
});
