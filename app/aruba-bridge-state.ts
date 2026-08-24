export function claimArubaBridgeStart(state: { current: boolean }) {
  if (state.current) return false;
  state.current = true;
  return true;
}
