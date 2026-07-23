import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runMcpTool } from "@lacrew/adapter-agents-mcp";
import { CrewRuntime } from "./runtime.js";
import { createRuntimeMcpBackend } from "./mcpBackend.js";
import { createLacrewClient } from "@lacrew/sdk/testing";

describe("createRuntimeMcpBackend", () => {
  it("MCP propose lands in the same runtime the server reads", async () => {
    const runtime = new CrewRuntime({ client: createLacrewClient({ useMock: true }), mode: "mock" });
    const backend = createRuntimeMcpBackend(runtime);

    // 150 USDC exceeds the mock worker cap → escalation intent.
    const proposed = (await runMcpTool(
      "lacrew_propose_intent",
      {
        agent: "0x3333333333333333333333333333333333333333",
        target: "0x4444444444444444444444444444444444444444",
        value: "150000000",
      },
      { backend },
    )) as { intentId: string; verdict: string };
    assert.equal(proposed.verdict, "ESCALATE");
    assert.ok(proposed.intentId);

    // Same intent visible through the tool AND the runtime (shared state).
    const viaTool = (await runMcpTool("lacrew_list_pending_intents", {}, { backend })) as Array<{
      id: string;
      value: string;
    }>;
    const viaRuntime = await runtime.listPending();
    assert.ok(viaTool.some((i) => i.id === proposed.intentId));
    assert.ok(viaRuntime.some((i) => i.id === proposed.intentId));
    assert.equal(typeof viaTool.find((i) => i.id === proposed.intentId)!.value, "string");

    // Approve through the tool; the runtime no longer lists it.
    const resolved = (await runMcpTool(
      "lacrew_approve_intent",
      { intentId: proposed.intentId, approved: true },
      { backend },
    )) as { intent: { resolved: boolean } };
    assert.equal(resolved.intent.resolved, true);
    const after = await runtime.listPending();
    assert.ok(!after.some((i) => i.id === proposed.intentId));
  });

  it("forwards the scope's window and rate onto propose", async () => {
    // The last link of the flow-scope → session-key thread: a flow's scope
    // window/rate ride the actor into every propose the run makes.
    let captured: { window?: unknown; rate?: unknown; ceiling?: unknown } | undefined;
    const fakeRuntime = {
      propose: async (input: { window?: unknown; rate?: unknown; ceiling?: unknown }) => {
        captured = input;
        return { intentId: "1", verdict: "ESCALATE" };
      },
    } as unknown as CrewRuntime;
    const backend = createRuntimeMcpBackend(fakeRuntime, {
      ceiling: "0x2222222222222222222222222222222222222222",
      window: { start: 32400, end: 61200 },
      rate: { maxProposals: 5, ratePeriod: 3600 },
    });
    await backend.proposeIntent({
      agent: "0x3333333333333333333333333333333333333333",
      target: "0x4444444444444444444444444444444444444444",
      value: 1n,
    });
    assert.deepEqual(captured?.window, { start: 32400, end: 61200 });
    assert.deepEqual(captured?.rate, { maxProposals: 5, ratePeriod: 3600 });
    assert.equal(captured?.ceiling, "0x2222222222222222222222222222222222222222");
  });
});
