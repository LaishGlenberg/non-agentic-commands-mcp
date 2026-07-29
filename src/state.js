// ── Shared mutable state ─────────────────────────────────────────────
// These values are set and read across multiple modules (pi-process, rpc).
export const state = {
  piProcess: null,
  rpcResolveCallback: null,
  lastAssistantMessage: null,
  pendingRestartConfirm: false,
};
