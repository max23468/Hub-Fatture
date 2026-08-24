export function claimArubaBridgeStart(state: { current: boolean }) {
  if (state.current) return false;
  state.current = true;
  return true;
}

interface ArubaBridgePanel {
  postMessage(message: unknown, targetOrigin: string): void;
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

export function sendArubaBridgeReady({
  panel,
  targetOrigin,
}: {
  panel: ArubaBridgePanel;
  targetOrigin: string;
}) {
  panel.postMessage({ type: "HF_ARUBA_BRIDGE_READY" }, targetOrigin);
}

export function sendArubaBridgeResponse({
  panel,
  response,
  targetOrigin,
}: {
  panel: ArubaBridgePanel;
  response: unknown;
  targetOrigin: string;
}) {
  panel.postMessage(response, targetOrigin);
}
