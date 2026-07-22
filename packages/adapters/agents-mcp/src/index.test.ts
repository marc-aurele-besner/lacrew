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

  it("refuses to answer without a backend", async () => {
    // This used to serve the sample org tree. A model asking "who is in my
    // org?" got Human Root / Manager A / Worker 1 with no marker saying so.
    await assert.rejects(
      runMcpTool("lacrew_get_org_tree", {}),
      /No LaCrew backend configured/,
    );
  });

  it("serves the demo client only when it is asked for", async () => {
    const tree = (await runMcpTool("lacrew_get_org_tree", {}, { useMock: true })) as unknown[];
    assert.ok(Array.isArray(tree) && tree.length > 0);
  });

  it("refuses a propose that names no backend", async () => {
    // The worst of the set: a returned intentId and verdict for a spend that
    // never reached a chain.
    await assert.rejects(
      runMcpTool("lacrew_propose_intent", {
        agent: "0x1111111111111111111111111111111111111111",
        target: "0x2222222222222222222222222222222222222222",
        value: "1000000",
      }),
      /No LaCrew backend configured/,
    );
  });

  it("lists the intent tools plus the crew-driving surface", () => {
    const names = listLacrewMcpTools().map((t) => t.name);
    assert.deepEqual(names, [
      "lacrew_get_org_tree",
      "lacrew_propose_intent",
      "lacrew_list_pending_intents",
      "lacrew_approve_intent",
      "lacrew_check_policy",
      "lacrew_org_action",
      "lacrew_set_budget",
      "lacrew_governance",
      "lacrew_invoke_agent",
    ]);
  });

  it("reports unsupported capabilities instead of faking success", async () => {
    // A backend without the optional crew-driving methods must fail loudly:
    // silence here would read as "the org changed" when nothing happened.
    const backend = {
      getOrgTree: async () => [],
      listPendingIntents: async () => [],
      proposeIntent: async () => ({}),
      resolveIntent: async () => ({}),
    };
    await assert.rejects(
      runMcpTool("lacrew_org_action", { action: "fire", node: "0x1" }, { backend }),
      /not supported by this backend/,
    );
  });

  it("routes crew-driving tools to the backend capability", async () => {
    const calls: Array<[string, unknown]> = [];
    const backend = {
      getOrgTree: async () => [],
      listPendingIntents: async () => [],
      proposeIntent: async () => ({}),
      resolveIntent: async () => ({}),
      checkPolicy: async (input: unknown) => {
        calls.push(["checkPolicy", input]);
        return { verdict: "ALLOW" };
      },
      setBudget: async (input: unknown) => {
        calls.push(["setBudget", input]);
        return { verdict: "ALLOW" };
      },
    };

    await runMcpTool(
      "lacrew_check_policy",
      { agent: "0xa", target: "0xb", value: "42" },
      { backend },
    );
    await runMcpTool("lacrew_set_budget", { action: "set-grant", amount: "7" }, { backend });

    assert.deepEqual(calls[0], [
      "checkPolicy",
      { agent: "0xa", target: "0xb", value: 42n },
    ]);
    assert.deepEqual(calls[1], ["setBudget", { action: "set-grant", amount: 7n }]);
  });
});
