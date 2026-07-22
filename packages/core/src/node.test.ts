import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { findWorkspaceRoot, resolveIndexerPath, resolveWorkspacePath } from "./node.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../../..");

describe("findWorkspaceRoot", () => {
  it("walks up to the workspace root from anywhere inside it", () => {
    assert.equal(findWorkspaceRoot(HERE), ROOT);
    assert.equal(findWorkspaceRoot(ROOT), ROOT);
  });

  it("returns null outside a workspace rather than guessing", () => {
    assert.equal(findWorkspaceRoot("/"), null);
  });
});

describe("resolveWorkspacePath", () => {
  it("resolves a relative path to the same place from different cwds", () => {
    // The bug this guards: the indexer writes INDEXER_PATH from
    // packages/indexer and the orchestrator reads it from packages/orchestrator.
    // Resolving against each process's cwd produced two different files, so the
    // audit trail read empty with no error anywhere.
    const fromIndexer = resolveWorkspacePath(".lacrew/indexer.json", resolve(ROOT, "packages/indexer"));
    const fromOrchestrator = resolveWorkspacePath(
      ".lacrew/indexer.json",
      resolve(ROOT, "packages/orchestrator"),
    );
    assert.equal(fromIndexer, fromOrchestrator);
    assert.equal(fromIndexer, resolve(ROOT, ".lacrew/indexer.json"));
  });

  it("leaves absolute paths alone", () => {
    assert.equal(resolveWorkspacePath("/var/tmp/store.json"), "/var/tmp/store.json");
  });

  it("passes URLs through untouched", () => {
    // The same env var also accepts a remote indexer.
    assert.equal(resolveWorkspacePath("https://idx.example/store.json"), "https://idx.example/store.json");
    assert.equal(resolveWorkspacePath("http://127.0.0.1:9000/x.json"), "http://127.0.0.1:9000/x.json");
  });
});

describe("resolveIndexerPath", () => {
  it("falls back to the default store when nothing is configured", () => {
    assert.equal(resolveIndexerPath(undefined), resolve(ROOT, ".lacrew/indexer.json"));
    // A blank env var is "unset", not a path to the workspace root itself.
    assert.equal(resolveIndexerPath("   "), resolve(ROOT, ".lacrew/indexer.json"));
  });

  it("honours an explicit path", () => {
    assert.equal(resolveIndexerPath("custom/idx.json"), resolve(ROOT, "custom/idx.json"));
  });
});
