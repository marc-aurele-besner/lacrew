import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { InMemoryQueue } from "./memory.js";

describe("InMemoryQueue", () => {
  it("runs enqueued epoch handler after start", async () => {
    let epochs = 0;
    const q = new InMemoryQueue();
    await q.start({ onEpoch: async () => { epochs += 1; } });
    const id = await q.enqueue("epoch");
    assert.ok(id?.startsWith("mem_epoch_"));
    assert.equal(epochs, 1);
    assert.deepEqual(q.status(), { provider: "memory", ready: true });
    await q.stop();
    assert.equal(q.status().ready, false);
  });
});
