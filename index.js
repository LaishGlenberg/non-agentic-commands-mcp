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

// pi --provider nano-gpt --model tencent/hy3 --mode rpc
// 2. Spawn the continuous headless Pi Agent daemon
//const piProcess = spawn("pi", ["--mode", "rpc"], { cwd: RPC_CWD });
const piProcess = spawn("pi", ["--mode", "rpc", "--provider", "nano-gpt", "--model", "tencent/hy3"], { cwd: RPC_CWD });
//const piProcess = spawn("pi", ["--mode", "rpc"], { cwd: RPC_CWD });

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
        }, 8000);
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

  throw new Error(`Tool not found: ${request.params.name}`);
});

// 5. Connect the operational standard IO pathways
const transport = new StdioServerTransport();
await server.connect(transport);
console.error("► Pi Agent MCP Server is active and routing commands...");
