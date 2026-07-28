import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import spawn from "cross-spawn";
import fs from "fs";
import path from "path";



// ── Logger ──────────────────────────────────────────────────────────────────
// Enable via PI_MCP_LOG=error|warn|info|debug. Logs to stderr to avoid
// interfering with the MCP stdio protocol. Default: off.
const LOG_LEVELS = { off: 0, error: 1, warn: 2, info: 3, debug: 4 };
const LOG_LEVEL = LOG_LEVELS[process.env.PI_MCP_LOG] ?? LOG_LEVELS.off;

function log(level, ...args) {
  if (LOG_LEVELS[level] <= LOG_LEVEL) {
    console.error(`[pi-mcp:${level}]`, ...args);
  }
}

const server = new Server(
  { name: "non-agentic-commands-mcp", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

const RPC_CWD = process.cwd();
const PI_SESSION_DIR = process.env.PI_SESSION_DIR;

let piProcess = null;
let rpcResolveCallback = null;
let lastAssistantMessage = null;
let pendingRestartConfirm = false;

// Using one line version passed directly to spawn.sync since this version didn't work.
const AGENT_SYSTEM_PROMPT = `
  You are a helpful assitant for another model. Your job is to assist this model when it 
  comes to planning and implementation details. You are using a more powerful llm model than the
  worker agent so you should be the one it relies on for important details like patterns, architecture,
  high level implementation, etc. 
  
  ## Your Job

  The worker agent will summarize the problem, context, and its plan. Your job is to recieve its plan,
  analyze it, think back in your training data to concepts referenced in the workers plan
  and respond with what you think. You can either agree with the worker agent, or propose updates
  to its plan, or flat out disagree with the agent and tell it do it or another way.

  ## What not to do

  Your purpose is not project specific, or to be a code validator, you shouldn't need to worry about direct implementation 
  details like which files to edit. It is to act as a senior engineer, and nudge the worker in the
  right direction. Make sure they are using concepts properly, aren't overcomplicating things. It's
  to make sure there plan is correct and idiomatic, not that their code is correct.

  ## Last Notes

  You should analyze each step of the worker agent's plan, when you respond, make sure you reference
  each step, whether it needs to be changed or remain the same and give your reasoning + evidence.
`;

// ── Model registry ──────────────────────────────────────────────────
// Index into these arrays to swap providers/models without retyping in DEFAULT_PI_ARGS.
const PROVIDERS = [
  "deepseek", // 0
  "nano-gpt", // 1
];
const MODELS = [
  "deepseek/deepseek-v4-pro", // 0
  "deepseek/deepseek-v4-flash", // 1
  "tencent/hy3",              // 2
];

// ── Prompt helpers ───────────────────────────────────────────────────
// Flatten a multi-line template-string prompt into a single line by
// replacing newlines (and collapsing runs of whitespace) with spaces.
function flattenPrompt(prompt) {
  return prompt
    .replace(/\r?\n/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Default args used by start_session
const DEFAULT_PI_ARGS = [ //"tencent/hy3"  //"deepseek/deepseek-v4-pro"
  "--mode", "rpc", "--provider", PROVIDERS[2], "--model", MODELS[3], 
  "--no-tools", "--no-extensions", "--no-skills", "--no-context-files",
  "--system-prompt",
  flattenPrompt(AGENT_SYSTEM_PROMPT)
];

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
      } catch (e) {
        log("debug", "stdout parse failed (fragment):", e.message);
      }
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
  pendingRestartConfirm = false;
  log("info", "spawning pi with args:", extraArgs.join(" "));
  piProcess = spawn("pi", extraArgs, /* { cwd: RPC_CWD } */);
  attachStdoutHandlers(piProcess);
  piProcess.on("exit", (code, signal) => {
    log("warn", `pi process exited code=${code} signal=${signal}`);
    piProcess = null;
    pendingRestartConfirm = false;
    rpcResolveCallback = null;
    lastAssistantMessage = null;
  });
  piProcess.stderr.on("data", (d) => {
    log("error", "pi stderr:", d.toString());
  });
  piProcess.on("error", (err) => {
    log("error", "pi process error:", err.message);
  });
  return piProcess;
}

function guardRestart() {
  if (piProcess && !piProcess.killed) {
    if (pendingRestartConfirm) {
      pendingRestartConfirm = false;
      return null; // proceed
    }
    pendingRestartConfirm = true;
    return "Session is already running. Are you sure you want to start a new session? Calling this tool again will restart it.";
  }
  return null;
}

function ensurePiRunning() {
  if (!piProcess || piProcess.killed) {
    throw new Error("No Pi session running. Call start_session or start_session_custom first.");
  }
}

// ── RPC helpers ──────────────────────────────────────────────────────────
function formatAssistantContent(message, includeThinking = false) {
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
    log("debug", "sending RPC:", JSON.stringify(payload).slice(0, 200));
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
    log("debug", "sending raw RPC:", JSON.stringify(payload).slice(0, 200));
    piProcess.stdin.write(JSON.stringify(payload) + "\n");
  });
}

// ── Tool definitions ─────────────────────────────────────────────────────
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "start_session",
      description: "Start a Pi session. " +
        "Optionally reconnect to a previous session by number: 0 = new session (default), " +
        "1 = most recent, 2 = second most recent, etc. Requires PI_SESSION_DIR env var for numbered lookups.",
      inputSchema: {
        type: "object",
        properties: {
          session_number: {
            type: "number",
            description: "Session: 0 = new (default), 1 = most recent, 2 = second most recent, etc."
          },
          provider: {
            type: "string",
            description: "LLM provider (default: tencent)"
          },
          model: {
            type: "string",
            description: "Model identifier (default: tencent/hy3)"
          },
          system_prompt: {
            type: "string",
            description: "Custom system prompt (overrides default)"
          },
          no_session: {
            type: "boolean",
            description: "Don't persist session to disk (ephemeral)"
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
          },
          no_session: {
            type: "boolean",
            description: "Don't persist session to disk (ephemeral)"
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
          text: { type: "string", description: "The prompt to send." },
          include_thinking: {
            type: "boolean",
            description: "Include the model's thinking/reasoning blocks in the response. Default false (stripped)."
          }
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
    },
    {
      name: "export_html",
      description: "Export the current Pi session as an HTML file. " +
        "Optionally provide an output path; defaults to /tmp/session.html. ",
      inputSchema: {
        type: "object",
        properties: {
          outputPath: {
            type: "string",
            description: "Path to write the HTML export. Defaults to /tmp/session.html."
          }
        }
      }
    }
  ]
}));

// ── Tool handlers ────────────────────────────────────────────────────────
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  // start_session — spawn pi with defaults, optional overrides
  if (request.params.name === "start_session") {
    const warning = guardRestart();
    if (warning) return { content: [{ type: "text", text: warning }] };
    const args = request.params.arguments || {};
    const sessionNumber = args.session_number ?? 0;
    const sessionPath = resolveSessionNumber(sessionNumber);
    const provider = args.provider || PROVIDERS[0];
    const model = args.model || MODELS[0];
    const systemPrompt = args.system_prompt || flattenPrompt(AGENT_SYSTEM_PROMPT);
    const extraArgs = [
      "--mode", "rpc",
      "--model", model,
      "--no-tools", "--no-extensions", "--no-skills", "--no-context-files",
      "--system-prompt", systemPrompt
    ];
    // Only pass --provider if model doesn't already contain a '/' (provider/model format)
    if (!model.includes("/")) {
      extraArgs.splice(2, 0, "--provider", provider);
    }
    if (args.no_session) extraArgs.push("--no-session");
    if (sessionPath) extraArgs.push("--session", sessionPath);
    spawnPi(extraArgs);
    const info = sessionPath
      ? `reconnected to session ${sessionNumber} (${sessionPath})`
      : "fresh session";
    return { content: [{ type: "text", text: `Pi started — ${info}` }] };
  }

  // start_session_custom — spawn pi with user-supplied args, optional session number
  if (request.params.name === "start_session_custom") {
    const warning = guardRestart();
    if (warning) return { content: [{ type: "text", text: warning }] };
    const callArgs = request.params.arguments || {};
    const userArgs = (callArgs.args || "").trimStart();
    const sessionNumber = callArgs.session_number ?? 0;
    const sessionPath = resolveSessionNumber(sessionNumber);
    // Split on whitespace, respecting quoted strings
    const parsedArgs = [];
    const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
    let m;
    while ((m = re.exec(userArgs)) !== null) {
      parsedArgs.push(m[1] ?? m[2] ?? m[3]);
    }
    const extraArgs = ["--mode", "rpc", ...parsedArgs];
    if (callArgs.no_session) extraArgs.push("--no-session");
    if (sessionPath) extraArgs.push("--session", sessionPath);
    spawnPi(extraArgs);
    const info = sessionPath
      ? `reconnected to session ${sessionNumber} (${sessionPath})`
      : "fresh session";
    return { content: [{ type: "text", text: `Pi started — ${info}` }] };
  }

  // All tools below require pi to be already running
  if (request.params.name === "pi_agent_prompt") {
    const { text, include_thinking = false } = request.params.arguments;
    const result = await sendRpc({ type: "prompt", message: text });
    return {
      content: [{ type: "text", text: result ? formatAssistantContent(result, include_thinking) : "(no response)" }]
    };
  }

  if (request.params.name === "pi_agent_rpc") {
    const { command } = request.params.arguments;
    let payload;
    try { payload = JSON.parse(command); } catch (err) {
      log("error", "invalid JSON in pi_agent_rpc command:", err.message);
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

  if (request.params.name === "export_html") {
    const outputPath = request.params.arguments?.outputPath || "/tmp/session.html";
    const stream = await sendRpcRaw({ type: "export_html", outputPath });
    const cancelled = stream.find(e => e.type === "response" && e.command === "export_html")?.data?.cancelled;
    return {
      content: [{ type: "text", text: cancelled ? "HTML export cancelled." : `Session exported to: ${outputPath}` }]
    };
  }

  log("error", `tool not found: ${request.params.name}`);
  throw new Error(`Tool not found: ${request.params.name}`);
});

// ── Bootstrap ────────────────────────────────────────────────────────────
const transport = new StdioServerTransport();
await server.connect(transport);
log("info", "MCP server connected, awaiting tool calls");
console.error("► Pi Agent MCP Server is active. Call start_session to begin.");
