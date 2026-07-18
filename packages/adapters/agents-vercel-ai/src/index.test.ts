import assert from "node:assert/strict";
import { test } from "node:test";
import { createLacrewVercelAiTools, listLacrewVercelAiToolNames } from "./index.js";

test("exposes MCP tools in Vercel AI shape", async () => {
  const tools = createLacrewVercelAiTools({ useMock: true });
  const names = listLacrewVercelAiToolNames();
  assert.ok(names.includes("lacrew_get_org_tree"));
  assert.ok(tools.lacrew_get_org_tree);
  const tree = await tools.lacrew_get_org_tree!.execute({});
  assert.ok(tree);
});

test("routes execute through an injected backend", async () => {
  const calls: string[] = [];
  const tools = createLacrewVercelAiTools({
    backend: {
      getOrgTree: async () => {
        calls.push("getOrgTree");
        return [];
      },
      listPendingIntents: async () => [],
      proposeIntent: async (input) => {
        calls.push(`propose:${input.value}`);
        return { intentId: "1", verdict: "ESCALATE" };
      },
      resolveIntent: async () => ({}),
    },
  });
  await tools.lacrew_get_org_tree!.execute({});
  await tools.lacrew_propose_intent!.execute({ agent: "0xa", target: "0xb", value: "42" });
  assert.deepEqual(calls, ["getOrgTree", "propose:42"]);
});
