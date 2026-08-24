import assert from "node:assert/strict";
import test from "node:test";

import {
  claimArubaBridgeStart,
  openArubaBridgeChannel,
  sendArubaBridgeRuntime,
} from "./aruba-bridge-state.ts";

test("il ponte Aruba avvia una sola copia del lettore per finestra", () => {
  const state = { current: false };

  assert.equal(claimArubaBridgeStart(state), true);
  assert.equal(claimArubaBridgeStart(state), false);

  state.current = false;
  assert.equal(claimArubaBridgeStart(state), true);
});

test("il ponte consegna il canale soltanto dopo che il lettore corrente è pronto", async () => {
  const sent: Array<{
    message: { port?: MessagePort; runtimeSource?: string; type?: string };
    targetOrigin: string;
    transfer?: Transferable[];
  }> = [];
  const panel = {
    postMessage(message: unknown, targetOrigin: string, transfer?: Transferable[]) {
      sent.push({
        message: message as { port?: MessagePort; runtimeSource?: string; type?: string },
        targetOrigin,
        transfer,
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
    transfer: undefined,
  });

  let received: unknown;
  const request = new Promise<void>((resolve) => {
    const port = openArubaBridgeChannel({
      onRequest: (event) => {
        received = event.data;
        port.close();
        resolve();
      },
      panel,
      targetOrigin: "https://fatturazioneelettronica.aruba.it",
    });
  });

  assert.equal(sent[1]?.message.type, "HF_ARUBA_CHANNEL");
  assert.equal(sent[1]?.targetOrigin, "https://fatturazioneelettronica.aruba.it");
  assert.deepEqual(sent[1]?.transfer, [sent[1]?.message.port]);

  const readerPort = sent[1]?.message.port;
  assert.ok(readerPort);
  const ready = new Promise<unknown>((resolve) => {
    readerPort.addEventListener("message", (event) => resolve(event.data), { once: true });
    readerPort.start();
  });
  assert.deepEqual(await ready, { type: "HF_ARUBA_CHANNEL_READY" });
  readerPort.postMessage({ id: "1", path: "/manifest" });
  await request;
  assert.deepEqual(received, { id: "1", path: "/manifest" });
});
