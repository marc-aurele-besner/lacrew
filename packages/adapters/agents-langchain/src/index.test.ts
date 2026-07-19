import assert from "node:assert/strict";
import { test } from "node:test";
import { flow, runFlow } from "@lacrew/flows";
import {
  createLacrewLangChainTools,
  createLangChainFlowBackend,
  listLacrewLangChainToolNames,
} from "./index.js";

test("exposes all LaCrew MCP tools in LangChain shape", async () => {
  const tools = createLacrewLangChainTools();
  const names = tools.map((t) => t.name);
  assert.deepEqual(names, listLacrewLangChainToolNames());
  assert.ok(names.includes("lacrew_get_org_tree"));
  assert.ok(names.includes("lacrew_propose_intent"));
  for (const t of tools) {
    assert.ok(t.description.length > 0);
    assert.equal(typeof t.invoke, "function");
    assert.equal((t.schema as { type?: string }).type, "object");
  }
});

test("tool invoke returns a JSON string (LangChain string-output convention)", async () => {
  const tools = createLacrewLangChainTools();
  const orgTree = tools.find((t) => t.name === "lacrew_get_org_tree")!;
  const out = await orgTree.invoke({});
  assert.equal(typeof out, "string");
  assert.ok(Array.isArray(JSON.parse(out)));
});

test("tools dispatch to an injected backend", async () => {
  const calls: string[] = [];
  const tools = createLacrewLangChainTools({
    backend: {
      getOrgTree: async () => {
        calls.push("tree");
        return [{ account: "0xTEST" }];
      },
      listPendingIntents: async () => [],
      proposeIntent: async () => ({ verdict: "ALLOW" }),
      resolveIntent: async () => ({}),
    },
  });
  const out = await tools.find((t) => t.name === "lacrew_get_org_tree")!.invoke({});
  assert.deepEqual(calls, ["tree"]);
  assert.ok(out.includes("0xTEST"));
});

test("a LangChain runnable powers model steps in a @lacrew/flows pipeline", async () => {
  const seen: unknown[] = [];
  // Runnable stand-in: AIMessage-like output, as chat models return.
  const runnable = {
    invoke: async (input: unknown) => {
      seen.push(input);
      return { content: `LC says: ${String(input).slice(0, 40)}` };
    },
  };
  const backend = createLangChainFlowBackend({ runnable });

  const def = flow("lc-demo", "LangChain demo")
    .tool("org", "lacrew_get_org_tree")
    .model("sum", { system: "Be terse.", prompt: "Summarize {{steps.org.json}}", next: null })
    .build();
  const run = await runFlow(def, backend);

  assert.equal(run.status, "completed");
  assert.equal(run.steps.length, 2);
  const modelOut = run.steps[1]!.output as { text: string };
  assert.ok(modelOut.text.startsWith("LC says: Be terse."));
  assert.equal(seen.length, 1);
});
