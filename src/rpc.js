import { log } from "./logger.js";
import { state } from "./state.js";
import { ensurePiRunning } from "./pi-process.js";

// ── RPC helpers ──────────────────────────────────────────────────────────
export function formatAssistantContent(message, includeThinking = false) {
  if (!message || !Array.isArray(message.content)) return "";
  const parts = [];
  for (const c of message.content) {
    if (c.type === "text") parts.push(c.text || "");
    else if (c.type === "toolCall") parts.push(`[tool: ${c.name}] ${JSON.stringify(c.arguments)}`);
    else if (c.type === "thinking") {
      if (includeThinking) parts.push(`[thinking] ${c.thinking || ""}`);
    }
    else parts.push(`[${c.type}]`);
  }
  return parts.join("\n");
}

function isCompletion(response) {
  return response.type === "turn_end" || response.type === "agent_end";
}

export function sendRpc(payload) {
  ensurePiRunning();
  return new Promise((resolve) => {
    state.rpcResolveCallback = (response) => {
      if (isCompletion(response)) {
        state.rpcResolveCallback = null;
        const msg = state.lastAssistantMessage;
        state.lastAssistantMessage = null;
        resolve(msg);
      }
    };
    log("debug", "sending RPC:", JSON.stringify(payload).slice(0, 200));
    state.piProcess.stdin.write(JSON.stringify(payload) + "\n");
  });
}

export function sendRpcRaw(payload) {
  ensurePiRunning();
  const captured = [];
  let debounceTimer = null;
  return new Promise((resolve) => {
    state.rpcResolveCallback = (response) => {
      captured.push(response);
      if (debounceTimer) clearTimeout(debounceTimer);
      if (isCompletion(response)) {
        state.rpcResolveCallback = null;
        resolve(captured);
      } else {
        debounceTimer = setTimeout(() => {
          state.rpcResolveCallback = null;
          resolve(captured);
        }, 500);
      }
    };
    log("debug", "sending raw RPC:", JSON.stringify(payload).slice(0, 200));
    state.piProcess.stdin.write(JSON.stringify(payload) + "\n");
  });
}
