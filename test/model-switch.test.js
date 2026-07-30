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
  console.log("=== Integration Test: model switch ===\n");

  let transport;
  let client;

  try {
    // ── 1. Connect client (StdioClientTransport spawns the server) ──
    console.log("[1/5] Connecting to MCP server...");
    transport = new StdioClientTransport({
      command: "node",
      args: [SERVER_SCRIPT],
      env: { ...process.env, PI_MCP_LOG: "debug", PI_MCP_LOG_DIR: "." },
    });

    client = new Client(
      { name: "test-client", version: "1.0.0" },
      { capabilities: {} }
    );

    await client.connect(transport);
    console.log("  ✓ connected\n");

    // ── 2. Wait for Pi to auto-initialize ──────────────────────────
    console.log("[2/5] Waiting for Pi to auto-initialize (default model)...");
    await sleep(5000);

    // ── 3. Verify default model is deepseek-v4-pro ─────────────────
    console.log("[3/5] Checking session info for default model...");
    const info1 = await client.callTool({
      name: "pi_session_info",
      arguments: {},
    });

    const info1Text = info1.content?.[0]?.text || "{}";
    console.log(`  Session info: ${info1Text}`);

    // Parse and check the model is the default (deepseek/deepseek-v4-pro)
    let info1Data;
    try { info1Data = JSON.parse(info1Text); } catch { info1Data = {}; }
    const model1 = info1Data.model?.id || info1Data.modelId || JSON.stringify(info1Data);
    if (!model1.includes("deepseek")) {
      throw new Error(`Expected default model to include "deepseek", got: ${model1}`);
    }
    console.log(`  ✓ Default model confirmed: ${model1}\n`);

    // ── 4. Switch model to tencent/hy3 ─────────────────────────────
    console.log('[4/5] Switching model to tencent/hy3...');
    const switchResult = await client.callTool({
      name: "pi_set_model",
      arguments: { provider: "nano-gpt", modelId: "tencent/hy3" },
    });

    const switchText = switchResult.content?.[0]?.text || "(no content)";
    console.log(`  → ${switchText}`);
    if (switchText.includes("cancelled")) {
      throw new Error(`Model switch was cancelled: ${switchText}`);
    }

    // Small wait for model change to take effect
    await sleep(5000);

    // ── 5. Verify model changed and send prompt ────────────────────
    console.log("[5/5] Verifying model switch and sending prompt...");
    const info2 = await client.callTool({
      name: "pi_session_info",
      arguments: {},
    });

    const info2Text = info2.content?.[0]?.text || "{}";
    console.log(`  Session info: ${info2Text}`);

    let info2Data;
    try { info2Data = JSON.parse(info2Text); } catch { info2Data = {}; }
    const model2 = info2Data.model?.id || info2Data.modelId || JSON.stringify(info2Data);
    if (!model2.includes("hy3")) {
      throw new Error(`Expected model to be "tencent/hy3", got: ${model2}`);
    }
    console.log(`  ✓ Model confirmed: ${model2}\n`);

    // Send a prompt to verify the new model works
    console.log("  Sending prompt to verify new model...");
    const promptResult = await client.callTool({
      name: "pi_agent_prompt",
      arguments: { text: "hello" },
    });

    const responseText = promptResult.content?.[0]?.text || "(empty)";
    console.log(`  Response: "${responseText}"`);

    if (!responseText || responseText === "(no response)") {
      throw new Error("No response from pi_agent_prompt after model switch");
    }

    console.log("\n=== MODEL SWITCH TEST PASSED ===");
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
