import fs from "fs";
import path from "path";
import spawn from "cross-spawn";
import { log } from "./logger.js";
import { state } from "./state.js";
import { PI_SESSION_DIR } from "./config.js";

// ── Session number resolver ──────────────────────────────────────────────
// 0 = new session, 1 = most recent, 2 = second most recent, etc.
export function resolveSessionNumber(n) {
  if (n === 0) return null;
  if (!PI_SESSION_DIR) return null;
  let files;
  try {
    files = fs.readdirSync(PI_SESSION_DIR)
      .filter(f => f.endsWith(".jsonl"))
      .map(f => path.join(PI_SESSION_DIR, f))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  } catch {
    return null;
  }
  const idx = n - 1;
  if (idx < 0 || idx >= files.length) return null;
  return files[idx];
}

// ── Pi process lifecycle ─────────────────────────────────────────────────
function attachStdoutHandlers(proc) {
  proc.stdout.on("data", (data) => {
    const lines = data.toString().split("\n");
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const response = JSON.parse(line);
        if (response.type === "message_end" && response.message?.role === "assistant") {
          state.lastAssistantMessage = response.message;
        }
        if (state.rpcResolveCallback) state.rpcResolveCallback(response);
      } catch (e) {
        log("debug", "stdout parse failed (fragment):", e.message);
      }
    }
  });
}

export function spawnPi(extraArgs) {
  if (state.piProcess) {
    state.piProcess.kill();
    state.piProcess = null;
    state.rpcResolveCallback = null;
    state.lastAssistantMessage = null;
  }
  state.pendingRestartConfirm = false;
  log("info", "spawning pi with args:", extraArgs.join(" "));
  state.piProcess = spawn("pi", extraArgs);
  attachStdoutHandlers(state.piProcess);

  return new Promise((resolve, reject) => {
    const BOOT_TIME = 2000;
    let settled = false;
    const fail = (err) => { if (!settled) { settled = true; reject(err); } };
    const ok = () => { if (!settled) { settled = true; resolve(); } };

    state.piProcess.on("exit", (code, signal) => {
      log("warn", `pi process exited code=${code} signal=${signal}`);
      state.piProcess = null;
      state.pendingRestartConfirm = false;
      state.rpcResolveCallback = null;
      state.lastAssistantMessage = null;
      if (code !== 0) fail(new Error(`pi exited with code ${code}${signal ? ` (signal ${signal})` : ""}`));
    });
    state.piProcess.stderr.on("data", (d) => {
      log("error", "pi stderr:", d.toString());
    });
    state.piProcess.on("error", (err) => {
      log("error", "pi process error:", err.message);
      fail(err);
    });
    setTimeout(ok, BOOT_TIME);
  });
}

export function guardRestart() {
  if (state.piProcess && !state.piProcess.killed) {
    if (state.pendingRestartConfirm) {
      state.pendingRestartConfirm = false;
      return null; // proceed
    }
    state.pendingRestartConfirm = true;
    return "Session is already running. Are you sure you want to start a new session? Calling this tool again will restart it.";
  }
  return null;
}

export function ensurePiRunning() {
  if (!state.piProcess || state.piProcess.killed) {
    throw new Error("No Pi session running. Call start_session or start_session_custom first.");
  }
}
