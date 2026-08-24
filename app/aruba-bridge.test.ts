import assert from "node:assert/strict";
import test from "node:test";

import {
  claimArubaBridgeStart,
  sendArubaBridgeReady,
  sendArubaBridgeResponse,
  sendArubaBridgeRuntime,
} from "./aruba-bridge-state.ts";

test("il ponte Aruba avvia una sola copia del lettore per finestra", () => {
  const state = { current: false };

  assert.equal(claimArubaBridgeStart(state), true);
  assert.equal(claimArubaBridgeStart(state), false);

  state.current = false;
  assert.equal(claimArubaBridgeStart(state), true);
});

test("il ponte risponde direttamente alla finestra Aruba senza canali trasferibili", () => {
  const sent: Array<{
    message: { id?: string; runtimeSource?: string; type?: string };
    targetOrigin: string;
  }> = [];
  const panel = {
    postMessage(message: unknown, targetOrigin: string) {
      sent.push({
        message: message as { id?: string; runtimeSource?: string; type?: string },
        targetOrigin,
      });
    },
  };

  sendArubaBridgeRuntime({
    panel,
    runtimeSource: "runtime-corrente",
    targetOrigin: "https://fatturazioneelettronica.aruba.it",
  });
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0], {
    message: { type: "HF_ARUBA_START", runtimeSource: "runtime-corrente" },
    targetOrigin: "https://fatturazioneelettronica.aruba.it",
  });

  sendArubaBridgeReady({
    panel,
    targetOrigin: "https://fatturazioneelettronica.aruba.it",
  });
  sendArubaBridgeResponse({
    panel,
    response: { type: "HF_ARUBA_RESPONSE", id: "1" },
    targetOrigin: "https://fatturazioneelettronica.aruba.it",
  });

  assert.deepEqual(sent.slice(1), [
    {
      message: { type: "HF_ARUBA_BRIDGE_READY" },
      targetOrigin: "https://fatturazioneelettronica.aruba.it",
    },
    {
      message: { type: "HF_ARUBA_RESPONSE", id: "1" },
      targetOrigin: "https://fatturazioneelettronica.aruba.it",
    },
  ]);
});
