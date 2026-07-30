import fs from "fs";
import path from "path";
import envPaths from "env-paths";

// ── Log file ──────────────────────────────────────────────────────────────
// Logs are written to a local file to avoid interfering with the MCP stdio
// protocol. Set PI_MCP_LOG=error|warn|info|debug to enable levels.
//
// Log directory resolution:
//   1. PI_MCP_LOG_DIR env var (set to "." for cwd, or any absolute path)
//   2. Fallback: OS-appropriate log dir via env-paths
const LOG_FILE_DIR = "c:/Users/lglen/tmp/non-agentic-commands-mcp"
  ? path.resolve(process.env.PI_MCP_LOG_DIR)
  : envPaths("non-agentic-commands-mcp").log;
const LOG_FILE_PATH = path.join(LOG_FILE_DIR, "output.log");
try { fs.mkdirSync(LOG_FILE_DIR, { recursive: true }); } catch {}
const logStream = fs.createWriteStream(LOG_FILE_PATH, { flags: "a" });

const LOG_LEVELS = { off: 0, error: 1, warn: 2, info: 3, debug: 4 };
const LOG_LEVEL = LOG_LEVELS[process.env.PI_MCP_LOG] ?? LOG_LEVELS.off;

export function log(level, ...args) {
  if (LOG_LEVELS[level] <= LOG_LEVEL) {
    const msg = args.map(a => typeof a === "string" ? a : JSON.stringify(a)).join(" ");
    logStream.write(`[pi-mcp:${level}] ${msg}\n`);
  }
}

// ── Crash guard ─────────────────────────────────────────────────────────────
// Prevent uncaught errors from killing the server, which would cause pi to
// spawn a fresh process on the next tool call (losing the pi subprocess).
process.on("uncaughtException", (err) => {
  logStream.write(`[pi-mcp:fatal] UNCAUGHT EXCEPTION: ${err.message}\n`);
  if (err.stack) logStream.write(`[pi-mcp:fatal] STACK: ${err.stack.split("\n").slice(0, 6).join(" | ")}\n`);
});
process.on("unhandledRejection", (err) => {
  logStream.write(`[pi-mcp:fatal] UNHANDLED REJECTION: ${err instanceof Error ? err.message : String(err)}\n`);
});

export { LOG_FILE_PATH, logStream };
