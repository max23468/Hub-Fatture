import assert from "node:assert/strict";
import test from "node:test";

import { selectOrderMatch } from "./aruba-inbound.ts";
import { arubaOrderCandidateFromSource } from "./aruba-order-candidate.ts";

test("la seconda verifica Aruba conserva il Paese del privato estero", () => {
  const candidate = arubaOrderCandidateFromSource({
    id: "42",
    provider: "SHOPIFY",
    display_number: "#1001",
    local_order_date: "2026-09-01",
    billable_amount: 3_566,
    recipient_name: "Stefan Schirmer",
    recipient_tax_identifiers: [],
    recipient_country_code: "DE",
    recipient_address: "Papenhuder Str. 26 22087 Hamburg DE",
    billing_case_id: "7",
  });
  assert.deepEqual(candidate, {
    id: "42",
    provider: "SHOPIFY",
    displayNumber: "#1001",
    localOrderDate: "2026-09-01",
    billableAmount: 3_566,
    recipientName: "Stefan Schirmer",
    recipientTaxIdentifiers: [],
    recipientCountryCode: "DE",
    recipientAddress: "Papenhuder Str. 26 22087 Hamburg DE",
    billingCaseId: "7",
  });
  assert.equal(
    arubaOrderCandidateFromSource(
      {
        id: "42",
        provider: "SHOPIFY",
        display_number: "#1001",
        local_order_date: "2026-09-01",
        billable_amount: 3_566,
        recipient_name: "Stefan Schirmer",
        recipient_tax_identifiers: [],
        recipient_country_code: "DE",
        recipient_address: "Papenhuder Str. 26 22087 Hamburg DE",
        billing_case_id: "7",
      },
      { billingCaseId: null },
    ).billingCaseId,
    null,
  );
  assert.equal(
    selectOrderMatch(
      {
        remoteId: "remote-42",
        documentType: "TD01",
        fiscalYear: 2026,
        series: "FPR",
        fiscalNumber: "42",
        documentDate: "2026-09-01",
        recipientName: "STEFAN SCHIRMER",
        recipientTaxId: "99999999999",
        recipientTaxIdentifiers: [{ type: "PARTITA_IVA", countryCode: "DE", value: "99999999999" }],
        recipientCountryCode: "DE",
        recipientAddress: "20095 Speersort 1 Hamburg DE",
        totalAmount: 3_566,
        currency: "EUR",
        status: "DELIVERED",
        providerObservedAt: null,
        xmlSha256: "a".repeat(64),
        orderReferences: [],
      },
      [candidate],
    ).status,
    "MATCHED",
  );
});
