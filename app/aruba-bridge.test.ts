import assert from "node:assert/strict";
import test from "node:test";

import { claimArubaBridgeStart, openArubaBridgeChannel } from "./aruba-bridge-state.ts";

test("il ponte Aruba avvia una sola copia del lettore per finestra", () => {
  const state = { current: false };

  assert.equal(claimArubaBridgeStart(state), true);
  assert.equal(claimArubaBridgeStart(state), false);

  state.current = false;
  assert.equal(claimArubaBridgeStart(state), true);
});

test("il ponte consegna al lettore un canale dedicato dopo il codice corrente", async () => {
  const sent: Array<{
    message: { port?: MessagePort; runtimeSource?: string; type?: string };
    targetOrigin: string;
    transfer?: Transferable[];
  }> = [];
  let received: unknown;
  const request = new Promise<void>((resolve) => {
    const port = openArubaBridgeChannel({
      onRequest: (event) => {
        received = event.data;
        port.close();
        resolve();
      },
      panel: {
        postMessage(message, targetOrigin, transfer) {
          sent.push({
            message: message as { port?: MessagePort; runtimeSource?: string; type?: string },
            targetOrigin,
            transfer,
          });
        },
      },
      runtimeSource: "runtime-corrente",
      targetOrigin: "https://fatturazioneelettronica.aruba.it",
    });
  });

  assert.deepEqual(sent[0], {
    message: { type: "HF_ARUBA_START", runtimeSource: "runtime-corrente" },
    targetOrigin: "https://fatturazioneelettronica.aruba.it",
    transfer: undefined,
  });
  assert.equal(sent[1]?.message.type, "HF_ARUBA_CHANNEL");
  assert.equal(sent[1]?.targetOrigin, "https://fatturazioneelettronica.aruba.it");
  assert.deepEqual(sent[1]?.transfer, [sent[1]?.message.port]);

  sent[1]?.message.port?.postMessage({ id: "1", path: "/manifest" });
  await request;
  assert.deepEqual(received, { id: "1", path: "/manifest" });
});
