import * as assert from "assert";
import * as vscode from "vscode";
import type { OpencodeBridge } from "../../opencode";

// Integration test: proves the extension's opencode bridge actually talks to the
// real engine (loaded from ~/.config/opencode). These may fail in CI without a
// configured opencode, but they are the ground truth for a live environment.

suite("LLMcode Engine Bridge", () => {
  let bridge: OpencodeBridge;

  suiteSetup(async function () {
    this.timeout(60000);
    const ext = vscode.extensions.getExtension("llmcode.llmcode");
    assert.ok(ext, "extension not found");
    bridge = (await ext!.activate()) as unknown as OpencodeBridge;
    // Wait up to 30s for the managed engine to come online in the background.
    const deadline = Date.now() + 30000;
    while (!bridge.isConnected() && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 250));
    }
  });

  test("bridge connects to the engine", function () {
    assert.ok(bridge.isConnected(), "engine did not connect within timeout");
  });

  test("lists sessions", async function () {
    this.timeout(20000);
    const sessions = await bridge.listSessions();
    assert.ok(Array.isArray(sessions), "sessions should be an array");
  });

  test("lists agents", async function () {
    this.timeout(30000);
    // Agents load asynchronously after the server starts; poll briefly.
    let agents: Awaited<ReturnType<typeof bridge.listAgents>> = [];
    const deadline = Date.now() + 20000;
    do {
      agents = await bridge.listAgents();
      if (agents.length > 0) break;
      await new Promise((r) => setTimeout(r, 300));
    } while (Date.now() < deadline);
    assert.ok(Array.isArray(agents), "agents should be an array");
    assert.ok(agents.length > 0, "expected at least one agent (build/plan/general…)");
  });

  test("lists providers", async function () {
    this.timeout(20000);
    const providers = await bridge.listProviders();
    assert.ok(Array.isArray(providers), "providers should be an array");
  });

  test("lists MCP servers", async function () {
    this.timeout(20000);
    const servers = await bridge.listMcp();
    assert.ok(Array.isArray(servers), "mcp should be an array");
  });
});
