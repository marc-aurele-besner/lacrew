import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { emptyStore, loadStore, saveStore } from "./store.js";

describe("indexer store", () => {
  it("round-trips JSON", () => {
    const dir = mkdtempSync(join(tmpdir(), "lacrew-indexer-"));
    const path = join(dir, "store.json");
    const store = emptyStore();
    store.audit.push({
      type: "IntentCreated",
      at: "2026-07-17T00:00:00.000Z",
      payload: { intentId: "1" },
    });
    saveStore(path, store);
    const loaded = loadStore(path);
    assert.equal(loaded.audit.length, 1);
    assert.equal(loaded.audit[0]?.type, "IntentCreated");
    rmSync(dir, { recursive: true, force: true });
  });
});
