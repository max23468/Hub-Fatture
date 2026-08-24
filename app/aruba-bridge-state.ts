export function claimArubaBridgeStart(state: { current: boolean }) {
  if (state.current) return false;
  state.current = true;
  return true;
}

interface ArubaBridgePanel {
  postMessage(message: unknown, targetOrigin: string, transfer?: Transferable[]): void;
}

export function sendArubaBridgeRuntime({
  panel,
  runtimeSource,
  targetOrigin,
}: {
  panel: ArubaBridgePanel;
  runtimeSource: string;
  targetOrigin: string;
}) {
  panel.postMessage({ type: "HF_ARUBA_START", runtimeSource }, targetOrigin);
}

export function openArubaBridgeChannel({
  onRequest,
  panel,
  targetOrigin,
}: {
  onRequest: (event: MessageEvent) => void;
  panel: ArubaBridgePanel;
  targetOrigin: string;
}) {
  const channel = new MessageChannel();
  channel.port1.addEventListener("message", onRequest);
  channel.port1.start();
  panel.postMessage({ type: "HF_ARUBA_CHANNEL", port: channel.port2 }, targetOrigin, [
    channel.port2,
  ]);
  channel.port1.postMessage({ type: "HF_ARUBA_CHANNEL_READY" });
  return channel.port1;
}
