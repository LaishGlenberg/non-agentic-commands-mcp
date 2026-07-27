import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import spawn from "cross-spawn";
import fs from "fs";
import path from "path";

const server = new Server(
  { name: "non-agentic-commands-mcp", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

const RPC_CWD = process.cwd();
const PI_SESSION_DIR = process.env.PI_SESSION_DIR;

let piProcess = null;
let rpcResolveCallback = null;
let lastAssistantMessage = null;

// Default args used by start_session
const DEFAULT_PI_ARGS = ["--mode", "rpc", "--provider", "nano-gpt", "--model", "tencent/hy3"];

// ── Session number resolver ──────────────────────────────────────────────
// 0 = new session, 1 = most recent, 2 = second most recent, etc.
function resolveSessionNumber(n) {
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
          lastAssistantMessage = response.message;
        }
        if (rpcResolveCallback) rpcResolveCallback(response);
      } catch { /* streaming fragment noise */ }
    }
  });
}

function spawnPi(extraArgs) {
  if (piProcess) {
    piProcess.kill();
    piProcess = null;
    rpcResolveCallback = null;
    lastAssistantMessage = null;
  }
  piProcess = spawn("pi", extraArgs, { cwd: RPC_CWD });
  attachStdoutHandlers(piProcess);
  return piProcess;
}

function ensurePiRunning() {
  if (!piProcess || piProcess.killed) {
    throw new Error("No Pi session running. Call start_session or start_session_custom first.");
  }
}

// ── RPC helpers ──────────────────────────────────────────────────────────
function formatAssistantContent(message) {
  if (!message || !Array.isArray(message.content)) return "";
  const parts = [];
  for (const c of message.content) {
    if (c.type === "text") parts.push(c.text || "");
    else if (c.type === "toolCall") parts.push(`[tool: ${c.name}] ${JSON.stringify(c.arguments)}`);
    else if (c.type === "thinking") parts.push(`[thinking] ${c.thinking || ""}`);
    else parts.push(`[${c.type}]`);
  }
  return parts.join("\n");
}

function isCompletion(response) {
  return response.type === "turn_end" || response.type === "agent_end";
}

function sendRpc(payload) {
  ensurePiRunning();
  return new Promise((resolve) => {
    rpcResolveCallback = (response) => {
      if (isCompletion(response)) {
        rpcResolveCallback = null;
        const msg = lastAssistantMessage;
        lastAssistantMessage = null;
        resolve(msg);
      }
    };
    piProcess.stdin.write(JSON.stringify(payload) + "\n");
  });
}

function sendRpcRaw(payload) {
  ensurePiRunning();
  const captured = [];
  let debounceTimer = null;
  return new Promise((resolve) => {
    rpcResolveCallback = (response) => {
      captured.push(response);
      if (debounceTimer) clearTimeout(debounceTimer);
      if (isCompletion(response)) {
        rpcResolveCallback = null;
        resolve(captured);
      } else {
        debounceTimer = setTimeout(() => {
          rpcResolveCallback = null;
          resolve(captured);
        }, 500);
      }
    };
    piProcess.stdin.write(JSON.stringify(payload) + "\n");
  });
}

// ── Tool definitions ─────────────────────────────────────────────────────
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "start_session",
      description: "Start a Pi session with default settings (nano-gpt/tencent/hy3). " +
        "Optionally reconnect to a previous session by number: 0 = new session (default), " +
        "1 = most recent, 2 = second most recent, etc. Requires PI_SESSION_DIR env var for numbered lookups.",
      inputSchema: {
        type: "object",
        properties: {
          session_number: {
            type: "number",
            description: "Session: 0 = new (default), 1 = most recent, 2 = second most recent, etc."
          }
        }
      }
    },
    {
      name: "start_session_custom",
      description: "Start a Pi session with custom CLI arguments. " +
        "Optionally reconnect to a previous session by number: 0 = new session (default), " +
        "1 = most recent, 2 = second most recent, etc. Requires PI_SESSION_DIR env var for numbered lookups.",
      inputSchema: {
        type: "object",
        properties: {
          args: {
            type: "string",
            description: "Custom arguments (e.g. '--provider openai --model gpt-4o --name \"refactor session\"')"
          },
          session_number: {
            type: "number",
            description: "Session: 0 = new (default), 1 = most recent, 2 = second most recent, etc."
          }
        },
        required: ["args"]
      }
    },
    {
      name: "pi_agent_prompt",
      description: "Send a prompt to the running Pi session (start_session must be called first).",
      inputSchema: {
        type: "object",
        properties: {
          text: { type: "string", description: "The prompt to send." }
        },
        required: ["text"]
      }
    },
    {
      name: "pi_agent_rpc",
      description: "Send a raw RPC command to the running Pi session (start_session must be called first).",
      inputSchema: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "Raw RPC JSON payload to forward verbatim."
          }
        },
        required: ["command"]
      }
    },
    {
      name: "pi_session_info",
      description: "Get current session state from the running Pi daemon (session ID, file path, model, etc.).",
      inputSchema: { type: "object", properties: {} }
    },
    {
      name: "pi_session_switch",
      description: "Reconnect to a different session file at runtime. Accepts a path or session number (requires PI_SESSION_DIR).",
      inputSchema: {
        type: "object",
        properties: {
          sessionPath: {
            type: "string",
            description: "Path to a session .jsonl file to switch to."
          },
          session_number: {
            type: "number",
            description: "Alternative: session number 1 = most recent, 2 = second most recent, etc. Ignored if sessionPath is set."
          }
        }
      }
    },
    {
      name: "pi_session_new",
      description: "Start a fresh session in the running Pi daemon.",
      inputSchema: { type: "object", properties: {} }
    }
  ]
}));

// ── Tool handlers ────────────────────────────────────────────────────────
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  // start_session — spawn pi with defaults, optional session number
  if (request.params.name === "start_session") {
    const sessionNumber = request.params.arguments?.session_number ?? 0;
    const sessionPath = resolveSessionNumber(sessionNumber);
    const extraArgs = [...DEFAULT_PI_ARGS];
    if (sessionPath) extraArgs.push("--session", sessionPath);
    spawnPi(extraArgs);
    const info = sessionPath
      ? `reconnected to session ${sessionNumber} (${sessionPath})`
      : "fresh session";
    return { content: [{ type: "text", text: `Pi started — ${info}` }] };
  }

  // start_session_custom — spawn pi with user-supplied args, optional session number
  if (request.params.name === "start_session_custom") {
    const userArgs = (request.params.arguments?.args || "").trimStart();
    const sessionNumber = request.params.arguments?.session_number ?? 0;
    const sessionPath = resolveSessionNumber(sessionNumber);
    // Split on whitespace, respecting quoted strings
    const parsedArgs = [];
    const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
    let m;
    while ((m = re.exec(userArgs)) !== null) {
      parsedArgs.push(m[1] ?? m[2] ?? m[3]);
    }
    const extraArgs = ["--mode", "rpc", ...parsedArgs];
    if (sessionPath) extraArgs.push("--session", sessionPath);
    spawnPi(extraArgs);
    const info = sessionPath
      ? `reconnected to session ${sessionNumber} (${sessionPath})`
      : "fresh session";
    return { content: [{ type: "text", text: `Pi started — ${info}` }] };
  }

  // All tools below require pi to be already running
  if (request.params.name === "pi_agent_prompt") {
    const { text } = request.params.arguments;
    const result = await sendRpc({ type: "prompt", message: text });
    return {
      content: [{ type: "text", text: result ? formatAssistantContent(result) : "(no response)" }]
    };
  }

  if (request.params.name === "pi_agent_rpc") {
    const { command } = request.params.arguments;
    let payload;
    try { payload = JSON.parse(command); } catch (err) {
      throw new Error(`Invalid JSON in 'command': ${err.message}`);
    }
    const stream = await sendRpcRaw(payload);
    return { content: [{ type: "text", text: JSON.stringify(stream, null, 2) }] };
  }

  if (request.params.name === "pi_session_info") {
    const stream = await sendRpcRaw({ type: "get_state" });
    const responseEvent = stream.find(e => e.type === "response" && e.command === "get_state");
    return { content: [{ type: "text", text: JSON.stringify(responseEvent?.data || {}, null, 2) }] };
  }

  if (request.params.name === "pi_session_switch") {
    let sessionPath = request.params.arguments?.sessionPath;
    const sessionNumber = request.params.arguments?.session_number;
    if (!sessionPath && sessionNumber > 0) {
      sessionPath = resolveSessionNumber(sessionNumber);
      if (!sessionPath) throw new Error(`No session found for number ${sessionNumber}`);
    }
    if (!sessionPath) throw new Error("Provide sessionPath or session_number");
    const stream = await sendRpcRaw({ type: "switch_session", sessionPath });
    const cancelled = stream.find(e => e.type === "response" && e.command === "switch_session")?.data?.cancelled;
    return {
      content: [{ type: "text", text: cancelled ? "Session switch cancelled." : `Switched to: ${sessionPath}` }]
    };
  }

  if (request.params.name === "pi_session_new") {
    const stream = await sendRpcRaw({ type: "new_session" });
    const cancelled = stream.find(e => e.type === "response" && e.command === "new_session")?.data?.cancelled;
    return {
      content: [{ type: "text", text: cancelled ? "New session cancelled." : "Started a fresh session." }]
    };
  }

  throw new Error(`Tool not found: ${request.params.name}`);
});

// ── Bootstrap ────────────────────────────────────────────────────────────
const transport = new StdioServerTransport();
await server.connect(transport);
console.error("► Pi Agent MCP Server is active. Call start_session to begin.");
