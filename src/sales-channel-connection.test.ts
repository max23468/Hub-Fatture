import assert from "node:assert/strict";
import test from "node:test";

import {
  salesChannelConnectionState,
  salesChannelIsConnected,
} from "./sales-channel-connection.ts";

test("un errore di sincronizzazione non scollega il canale di vendita", () => {
  const state = salesChannelConnectionState("ERROR");
  assert.equal(state, "SYNC_FAILED");
  assert.equal(salesChannelIsConnected(state), true);
});

test("solo una credenziale utilizzabile conferma il collegamento", () => {
  assert.equal(salesChannelIsConnected(salesChannelConnectionState("CONNECTED")), true);
  assert.equal(salesChannelIsConnected(salesChannelConnectionState("REAUTH_REQUIRED")), false);
  assert.equal(salesChannelIsConnected(salesChannelConnectionState("REVOKED")), false);
  assert.equal(salesChannelIsConnected(salesChannelConnectionState(null)), false);
});
