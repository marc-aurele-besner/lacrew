import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { listLacrewMcpTools, runMcpTool, type McpToolBackend } from "./index.js";

function stubBackend(calls: string[]): McpToolBackend {
  return {
    getOrgTree: async () => {
      calls.push("getOrgTree");
      return [{ account: "0x1" }];
    },
    listPendingIntents: async () => {
      calls.push("listPendingIntents");
      return [{ id: "INT-1", value: 150000000n }];
    },
    proposeIntent: async (input) => {
      calls.push(`proposeIntent:${input.agent}:${input.value}`);
      return { intentId: "INT-2", verdict: "ESCALATE" };
    },
    resolveIntent: async (intentId, approved) => {
      calls.push(`resolveIntent:${intentId}:${approved}`);
      return { escalated: false };
    },
  };
}

describe("runMcpTool with injected backend", () => {
  it("routes every tool to the backend", async () => {
    const calls: string[] = [];
    const backend = stubBackend(calls);

    await runMcpTool("lacrew_get_org_tree", {}, { backend });
    await runMcpTool(
      "lacrew_propose_intent",
      { agent: "0xa", target: "0xb", value: "75000000" },
      { backend },
    );
    await runMcpTool("lacrew_approve_intent", { intentId: "INT-2", approved: true }, { backend });

    assert.deepEqual(calls, [
      "getOrgTree",
      "proposeIntent:0xa:75000000",
      "resolveIntent:INT-2:true",
    ]);
  });

  it("stringifies bigint values in pending intents", async () => {
    const backend = stubBackend([]);
    const result = (await runMcpTool("lacrew_list_pending_intents", {}, { backend })) as Array<{
      value: unknown;
    }>;
    assert.equal(result[0]!.value, "150000000");
  });

  it("rejects unknown tools", async () => {
    await assert.rejects(runMcpTool("lacrew_nope", {}, { backend: stubBackend([]) }), /Unknown MCP tool/);
  });

  it("falls back to the SDK mock without a backend", async () => {
    const tree = (await runMcpTool("lacrew_get_org_tree", {})) as unknown[];
    assert.ok(Array.isArray(tree) && tree.length > 0);
  });

  it("lists four tools", () => {
    assert.equal(listLacrewMcpTools().length, 4);
  });
});
