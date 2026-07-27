import assert from "node:assert/strict";
import { test } from "node:test";
import { MemoryModelProvider } from "./memory.js";

test("MemoryModelProvider returns mocked text", async () => {
  const p = new MemoryModelProvider();
  const out = await p.complete({ prompt: "hello crew" });
  assert.equal(out.mocked, true);
  assert.match(out.text, /hello crew/);
});
