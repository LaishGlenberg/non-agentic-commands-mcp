import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { log, logStream, LOG_FILE_PATH } from "./src/logger.js";
import { state } from "./src/state.js";
import {
  AGENT_SYSTEM_PROMPT, PROVIDERS, MODELS, DEFAULT_PI_ARGS, flattenPrompt, sanitizeText,
} from "./src/config.js";
import { spawnPi, guardRestart, ensurePiRunning, resolveSessionNumber } from "./src/pi-process.js";
import { sendRpc, sendRpcRaw, formatAssistantContent } from "./src/rpc.js";

const server = new Server(
  { name: "non-agentic-commands-mcp", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

// ── Tool definitions ─────────────────────────────────────────────────────
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "start_session",
      description: "Optional: restart the Pi session with different settings or reconnect to a previous one. " +
        "Pi starts automatically with defaults on server boot, so this is only needed for overrides. " +
        "Session number: 0 = new (default), 1 = most recent, 2 = second most recent, etc. " +
        "Requires PI_SESSION_DIR env var for numbered lookups.",
      inputSchema: {
        type: "object",
        properties: {
          session_number: {
            type: "number",
            description: "Session: 0 = new (default), 1 = most recent, 2 = second most recent, etc."
          },
          model_list_index: {
            type: "array",
            items: { type: "number" },
            description: "[provider_index, model_index] into PROVIDERS/MODELS arrays (default: [1, 2] = tencent/tencent/hy3) [0,0]=deepseek-v4-pro [0,1]=ds-v4-flash"
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
      description: "Send a prompt to the running Pi session (auto-started on server boot).",
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
      description: "Send a raw RPC command to the running Pi session (auto-started on server boot).",
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
      name: "pi_set_model",
      description: "Change the model/provider in the running Pi session.",
      inputSchema: {
        type: "object",
        properties: {
          provider: {
            type: "string",
            description: "Provider name (e.g. anthropic, openai, deepseek)"
          },
          modelId: {
            type: "string",
            description: "Model ID (e.g. claude-sonnet-4-20250514, gpt-4o)"
          }
        },
        required: ["provider", "modelId"]
      }
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
    const [pIdx, mIdx] = args.model_list_index ?? [0, 0];
    const provider = PROVIDERS[pIdx] ?? PROVIDERS[0];
    const model = MODELS[mIdx] ?? MODELS[0];
    const systemPrompt = args.system_prompt ? sanitizeText(args.system_prompt) : flattenPrompt(AGENT_SYSTEM_PROMPT);
    const extraArgs = [
      "--mode", "rpc",
      "--provider", provider,
      "--model", model,
      "--no-tools", "--no-extensions", "--no-skills", "--no-context-files",
      "--system-prompt", systemPrompt
    ];
    if (args.no_session) extraArgs.push("--no-session");
    if (sessionPath) extraArgs.push("--session", sessionPath);
    try {
      await spawnPi(extraArgs);
    } catch (err) {
      return { content: [{ type: "text", text: `Failed to start Pi: ${err.message}` }], isError: true };
    }
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
    const userArgs = sanitizeText(callArgs.args || "");
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
    try {
      await spawnPi(extraArgs);
    } catch (err) {
      return { content: [{ type: "text", text: `Failed to start Pi: ${err.message}` }], isError: true };
    }
    const info = sessionPath
      ? `reconnected to session ${sessionNumber} (${sessionPath})`
      : "fresh session";
    return { content: [{ type: "text", text: `Pi started — ${info}` }] };
  }

  // All tools below require pi to be already running
  if (request.params.name === "pi_agent_prompt") {
    const { text, include_thinking = false } = request.params.arguments;
    const result = await sendRpc({ type: "prompt", message: sanitizeText(text) });
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

  if (request.params.name === "pi_set_model") {
    const { provider, modelId } = request.params.arguments;
    const stream = await sendRpcRaw({ type: "set_model", provider, modelId });
    const responseEvent = stream.find(e => e.type === "response" && e.command === "set_model");
    const cancelled = responseEvent?.data?.cancelled;
    return {
      content: [{ type: "text", text: cancelled ? "Model change cancelled." : `Model set to ${provider}/${modelId}` }]
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
log("info", "MCP server connected, starting Pi session...");
logStream.write("► Pi Agent MCP Server is active. Auto-starting Pi session...\n");

// Auto-start Pi session so agents can prompt immediately
spawnPi(DEFAULT_PI_ARGS).catch((err) => {
  log("error", "auto-start Pi failed:", err.message);
  logStream.write(`[pi-mcp:error] Auto-start Pi session failed: ${err.message}\n`);
});
