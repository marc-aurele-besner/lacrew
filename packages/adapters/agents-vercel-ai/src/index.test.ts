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
