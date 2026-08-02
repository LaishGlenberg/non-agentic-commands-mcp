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
  console.log("=== Integration Test: call_gemini ===\n");

  let transport;
  let client;

  try {
    // ── 1. Connect client (StdioClientTransport spawns the server) ──
    console.log("[1/3] Connecting to MCP server...");
    transport = new StdioClientTransport({
      command: "node",
      args: [SERVER_SCRIPT],
      env: { ...process.env, PI_MCP_LOG: "info", PI_MCP_LOG_DIR: "." },
    });

    client = new Client(
      { name: "test-client", version: "1.0.0" },
      { capabilities: {} }
    );

    await client.connect(transport);
    console.log("  ✓ connected\n");

    // ── 2. Wait for server to initialize ─────────────────────────────
    console.log("[2/3] Waiting for server to initialize...");
    await sleep(3000);

    // ── 3. Call call_gemini with prompt ──────────────────────────────
    console.log('[3/3] Calling call_gemini with prompt "UEFA Euro 2024 winner"...');
    const result = await client.callTool({
      name: "call_gemini",
      arguments: { prompt: "UEFA Euro 2024 winner" },
    });

    const responseText = result.content?.[0]?.text || "(empty)";
    console.log(`  Response: "${responseText}"`);

    if (!responseText || responseText === "(no response)") {
      throw new Error("No response from call_gemini");
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
