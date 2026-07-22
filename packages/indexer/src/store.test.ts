import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

describe("a damaged store is not an empty one", () => {
  it("still treats an absent file as a first run", () => {
    const dir = mkdtempSync(join(tmpdir(), "lacrew-indexer-"));
    const loaded = loadStore(join(dir, "store.json"));
    assert.deepEqual(loaded.pendingIntents, []);
    assert.deepEqual(loaded.audit, []);
    rmSync(dir, { recursive: true, force: true });
  });

  it("refuses a truncated store rather than reporting no approvals", () => {
    // Returning an empty store here said "no pending escalations, no audit
    // history" — which a reader acts on by doing nothing.
    const dir = mkdtempSync(join(tmpdir(), "lacrew-indexer-"));
    const path = join(dir, "store.json");
    writeFileSync(path, '{"pendingIntents":[{"id":"1"');
    assert.throws(() => loadStore(path), /could not be read/);
    // Left intact: the damaged file is the only copy of that audit trail.
    assert.equal(readFileSync(path, "utf8"), '{"pendingIntents":[{"id":"1"');
    rmSync(dir, { recursive: true, force: true });
  });

  it("refuses valid JSON that is not a store", () => {
    const dir = mkdtempSync(join(tmpdir(), "lacrew-indexer-"));
    const path = join(dir, "store.json");
    writeFileSync(path, '{"pendingIntents":"nope"}');
    assert.throws(() => loadStore(path), /is not a store/);
    rmSync(dir, { recursive: true, force: true });
  });
});
