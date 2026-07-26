import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
//import { spawn } from "child_process";
import spawn from "cross-spawn";
// 1. Initialize the official MCP server layer
const server = new Server(
  { name: "non-agentic-commands-mcp", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

// Working directory the headless Pi daemon runs in. Change as needed.
const RPC_CWD = process.cwd();

// 2. Spawn the continuous headless Pi Agent daemon.
// If PI_AGENT_SESSION env var is set, pass --session to resume that session.
const sessionArg = process.env.PI_AGENT_SESSION
  ? ["--session", process.env.PI_AGENT_SESSION]
  : [];
const piProcess = spawn("pi", [
  "--mode", "rpc",
  "--provider", "nano-gpt",
  "--model", "tencent/hy3",
  ...sessionArg
], { cwd: RPC_CWD });

// Single shared resolver. Each RPC call installs its own handler so concurrent
// tools don't clobber each other.
let rpcResolveCallback = null;
let lastAssistantMessage = null;

// Turn an assistant message into readable text for the MCP response
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

// Cleanly capture standard output streams from the agent loop
piProcess.stdout.on("data", (data) => {
  const lines = data.toString().split("\n");
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const response = JSON.parse(line);

      // Track the latest assistant message (the actual generated content)
      if (response.type === "message_end" && response.message?.role === "assistant") {
        lastAssistantMessage = response.message;
      }

      // Hand every parsed event to the active resolver (if any)
      if (rpcResolveCallback) rpcResolveCallback(response);
    } catch (err) {
      // Catch structural streaming fragment noises safely
    }
  }
});

// Resolve when the turn/session completes
function isCompletion(response) {
  return response.type === "turn_end" || response.type === "agent_end";
}

// Send a structured prompt and resolve with the formatted assistant answer
function sendRpc(payload) {
  return new Promise((resolve, reject) => {
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

// Send a raw/bespoke RPC command and return the full raw JSONL event stream.
// Resolves on turn_end/agent_end (prompt-based commands) OR after 500ms of
// inactivity (non-turn commands like export/config that don't create turns).
function sendRpcRaw(payload) {
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
        // Debounce: if no more events arrive within 500ms, consider it done.
        // This handles non-turn commands (export, config, etc.) that don't
        // emit turn_end/agent_end.
        debounceTimer = setTimeout(() => {
          rpcResolveCallback = null;
          resolve(captured);
        }, 500);
      }
    };
    piProcess.stdin.write(JSON.stringify(payload) + "\n");
  });
}

// 3. Define available tools to the MCP client ecosystem
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "pi_agent_prompt",
      description: "Send structural coding prompts down to the headless stateful Pi process.",
      inputSchema: {
        type: "object",
        properties: {
          text: { type: "string", description: "The architectural task or prompt instructions." }
        },
        required: ["text"]
      }
    },
    {
      name: "pi_agent_rpc",
      description: "Send a raw, bespoke RPC command straight to the headless Pi process, verbatim. " +
        "Pass a JSON string payload (e.g. '{\"id\":\"req-1\",\"type\":\"prompt\",\"message\":\"Hello, world!\"}'). " +
        "Returns the raw JSONL event stream captured until the turn/session ends.",
      inputSchema: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "Raw RPC JSON payload to forward verbatim to the Pi daemon's stdin."
          }
        },
        required: ["command"]
      }
    },
    {
      name: "pi_session_info",
      description: "Get current session state from the headless Pi daemon (session ID, file path, model, etc.).",
      inputSchema: {
        type: "object",
        properties: {}
      }
    },
    {
      name: "pi_session_switch",
      description: "Reconnect to a different session file at runtime. Loads a previous session so prompts continue from that context.",
      inputSchema: {
        type: "object",
        properties: {
          sessionPath: {
            type: "string",
            description: "Path to the session .jsonl file to switch to (e.g. /home/user/.pi/agent/sessions/.../session.jsonl)"
          }
        },
        required: ["sessionPath"]
      }
    },
    {
      name: "pi_session_new",
      description: "Start a fresh session in the headless Pi daemon.",
      inputSchema: {
        type: "object",
        properties: {}
      }
    }
  ]
}));

// 4. Handle incoming operational requests programmatically
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === "pi_agent_prompt") {
    const { text } = request.params.arguments;
    const payload = { type: "prompt", message: text };
    const result = await sendRpc(payload);
    return {
      content: [{ type: "text", text: result ? formatAssistantContent(result) : "(no response)" }]
    };
  }

  if (request.params.name === "pi_agent_rpc") {
    const { command } = request.params.arguments;
    let payload;
    try {
      payload = JSON.parse(command);
    } catch (err) {
      throw new Error(`Invalid JSON in 'command': ${err.message}`);
    }
    const stream = await sendRpcRaw(payload);
    return {
      content: [{ type: "text", text: JSON.stringify(stream, null, 2) }]
    };
  }

  if (request.params.name === "pi_session_info") {
    const stream = await sendRpcRaw({ type: "get_state" });
    const responseEvent = stream.find(e => e.type === "response" && e.command === "get_state");
    const data = responseEvent?.data || {};
    return {
      content: [{ type: "text", text: JSON.stringify(data, null, 2) }]
    };
  }

  if (request.params.name === "pi_session_switch") {
    const { sessionPath } = request.params.arguments;
    const stream = await sendRpcRaw({ type: "switch_session", sessionPath });
    const responseEvent = stream.find(e => e.type === "response" && e.command === "switch_session");
    const cancelled = responseEvent?.data?.cancelled;
    if (cancelled) {
      return {
        content: [{ type: "text", text: "Session switch was cancelled by an extension." }]
      };
    }
    return {
      content: [{ type: "text", text: `Switched to session: ${sessionPath}` }]
    };
  }

  if (request.params.name === "pi_session_new") {
    const stream = await sendRpcRaw({ type: "new_session" });
    const responseEvent = stream.find(e => e.type === "response" && e.command === "new_session");
    const cancelled = responseEvent?.data?.cancelled;
    if (cancelled) {
      return {
        content: [{ type: "text", text: "New session was cancelled by an extension." }]
      };
    }
    return {
      content: [{ type: "text", text: "Started a fresh session." }]
    };
  }

  throw new Error(`Tool not found: ${request.params.name}`);
});

// 5. Connect the operational standard IO pathways
const transport = new StdioServerTransport();
await server.connect(transport);
console.error("► Pi Agent MCP Server is active and routing commands...");
