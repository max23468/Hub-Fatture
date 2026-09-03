import assert from "node:assert/strict";
import test from "node:test";

import { AppError } from "./errors.ts";
import {
  activateFiscalProfileFromAcceptedXml,
  FISCAL_PROFILE_XML_MAX_BYTES,
} from "./operations/fiscal-profile-activation.ts";

const actor = { id: 1, canApprove: true, requestId: "synthetic-profile-activation" };

test("l’attivazione rifiuta XML vuoti, non UTF-8 o oltre limite prima degli effetti", async () => {
  const cases = [
    { value: new Uint8Array(), code: "FISCAL_PROFILE_SOURCE_INVALID" },
    { value: Uint8Array.of(0xff), code: "FISCAL_PROFILE_SOURCE_INVALID" },
    {
      value: new Uint8Array(FISCAL_PROFILE_XML_MAX_BYTES + 1),
      code: "REQUEST_BODY_TOO_LARGE",
    },
  ] as const;

  for (const input of cases) {
    await assert.rejects(
      activateFiscalProfileFromAcceptedXml({ profileXml: input.value, expectedVersion: 0 }, actor),
      (error) => error instanceof AppError && error.code === input.code,
    );
  }
});
