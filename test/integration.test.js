import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_SCRIPT = path.resolve(__dirname, "..", "index.js");

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function runTest() {
  console.log("=== Integration Test: non-agentic-commands-mcp ===\n");

  let transport;
  let client;

  try {
    // ── 1. Connect client (StdioClientTransport spawns the server) ──
    console.log("[1/4] Connecting to MCP server...");
    transport = new StdioClientTransport({
      command: "node",
      args: [SERVER_SCRIPT],
      env: { ...process.env, PI_MCP_LOG: "info" },
    });

    client = new Client(
      { name: "test-client", version: "1.0.0" },
      { capabilities: {} }
    );

    await client.connect(transport);
    console.log("  ✓ connected\n");

    // ── 2. Start session with tencent/hy3 ───────────────────────────
    console.log('[2/4] Starting Pi session (tencent/hy3)...');
    const startResult = await client.callTool({
      name: "start_session",
      arguments: {
        //model: "tencent/hy3",
        system_prompt: "you are a test agent, respond with hello only, no thinking",
        session_number: 0,
        no_session: true,
        model_list_index: [2,3]
      },
    });

    const startText = startResult.content?.[0]?.text || "(no content)";
    console.log(`  → ${startText}`);
    if (!startText.includes("Pi started")) {
      throw new Error(`start_session failed: ${startText}`);
    }
    console.log("  ✓ session started\n");

    // ── 3. Wait for Pi to initialize ────────────────────────────────
    console.log("[3/4] Waiting for Pi to initialize...");
    await sleep(5000);

    // ── 4. Send prompt and check response ───────────────────────────
    console.log('[4/4] Sending prompt "hello"...');
    const promptResult = await client.callTool({
      name: "pi_agent_prompt",
      arguments: { text: "hello" },
    });

    const responseText = promptResult.content?.[0]?.text || "(empty)";
    console.log(`  Response: "${responseText}"`);

    if (!responseText || responseText === "(no response)") {
      throw new Error("No response from pi_agent_prompt");
    }

    console.log("\n=== TEST PASSED ===");
  } finally {
    // Always clean up
    if (client) {
      try { await client.close(); } catch {}
    }
    if (transport) {
      try { transport.close(); } catch {}
    }
    // Force exit after 2s regardless of pending handles
    setTimeout(() => process.exit(0), 2000);
  }
}

runTest().catch((err) => {
  console.error("\n✗ TEST FAILED:", err.message);
  console.error(err.stack);
  setTimeout(() => process.exit(1), 2000);
});
