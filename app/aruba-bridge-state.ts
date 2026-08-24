export function claimArubaBridgeStart(state: { current: boolean }) {
  if (state.current) return false;
  state.current = true;
  return true;
}

interface ArubaBridgePanel {
  postMessage(message: unknown, targetOrigin: string, transfer?: Transferable[]): void;
}

export function openArubaBridgeChannel({
  onRequest,
  panel,
  runtimeSource,
  targetOrigin,
}: {
  onRequest: (event: MessageEvent) => void;
  panel: ArubaBridgePanel;
  runtimeSource: string;
  targetOrigin: string;
}) {
  const channel = new MessageChannel();
  channel.port1.addEventListener("message", onRequest);
  channel.port1.start();
  panel.postMessage({ type: "HF_ARUBA_START", runtimeSource }, targetOrigin);
  panel.postMessage({ type: "HF_ARUBA_CHANNEL", port: channel.port2 }, targetOrigin, [
    channel.port2,
  ]);
  return channel.port1;
}
