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

// pi --provider nano-gpt --model tencent/hy3 --mode rpc
// 2. Spawn the continuous headless Pi Agent daemon
//const piProcess = spawn("pi", ["--mode", "rpc"]);
const piProcess = spawn("pi", ["--mode", "rpc", "--provider", "nano-gpt", "--model", "tencent/hy3"]);
//const piProcess = spawn("pi", ["--mode", "rpc"]);
let rpcResolveCallback = null;

// Resolve a pending tool execution once the agent finishes its turn
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

      // The `response` event with command:"prompt" is only the prompt ACK —
      // NOT the answer. Resolve only when the turn/agent completes.
      if ((response.type === "turn_end" || response.type === "agent_end") && rpcResolveCallback) {
        rpcResolveCallback(lastAssistantMessage || response);
        rpcResolveCallback = null;
        lastAssistantMessage = null;
      }
    } catch (err) {
      // Catch structural streaming fragment noises safely
    }
  }
});

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
    }
  ]
}));

// 4. Handle incoming operational requests programmatically
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name !== "pi_agent_prompt") {
    throw new Error(`Tool not found: ${request.params.name}`);
  }

  const { text } = request.params.arguments;

  // Format strict minimized single-line JSONL payloads for the underlying daemon
  const payload = { 
    type: "prompt", 
    message: text 
  };

  const result = await new Promise((resolve) => {
    rpcResolveCallback = resolve;
    piProcess.stdin.write(JSON.stringify(payload) + "\n");
  });

  return {
    content: [{ type: "text", text: result ? formatAssistantContent(result) : JSON.stringify(result, null, 2) }]
  };
});

// 5. Connect the operational standard IO pathways
const transport = new StdioServerTransport();
await server.connect(transport);
console.error("► Pi Agent MCP Server is active and routing commands...");
