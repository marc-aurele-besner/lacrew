import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CrewRuntime } from "./runtime.js";

describe("CrewRuntime", () => {
  it("lists pending mock intents after construct", async () => {
    const runtime = new CrewRuntime();
    const pending = await runtime.listPending();
    assert.ok(Array.isArray(pending));
    assert.ok(pending.length >= 1);
  });
});
