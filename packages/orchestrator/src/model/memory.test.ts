import assert from "node:assert/strict";
import { test } from "node:test";
import { MemoryModelProvider } from "./memory.js";
import { createModelProviderFromEnv } from "./index.js";

test("MemoryModelProvider returns mocked text", async () => {
  const p = new MemoryModelProvider();
  const out = await p.complete({ prompt: "hello crew" });
  assert.equal(out.mocked, true);
  assert.match(out.text, /hello crew/);
});

test("createModelProviderFromEnv defaults to memory without key", () => {
  const prev = process.env.OPENROUTER_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  try {
    const p = createModelProviderFromEnv();
    assert.equal(p.name, "memory");
  } finally {
    if (prev !== undefined) process.env.OPENROUTER_API_KEY = prev;
  }
});
