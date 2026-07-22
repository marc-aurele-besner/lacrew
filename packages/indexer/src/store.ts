import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import type { Intent, ProtocolEvent } from "@lacrew/core";

export type IndexerStore = {
  pendingIntents: Intent[];
  audit: ProtocolEvent[];
  updatedAt: string;
};

export function emptyStore(): IndexerStore {
  return { pendingIntents: [], audit: [], updatedAt: new Date().toISOString() };
}

/**
 * Read the store, or refuse.
 *
 * Only an absent file is an empty store — that is a first run. A file that
 * exists but cannot be read or parsed is an error, and it used to return
 * `emptyStore()`: the indexer then presented "no pending escalations, no audit
 * history, freshly updated" (a reader acts on zero pending approvals by doing
 * nothing) and the next `saveStore` overwrote the damaged file, destroying
 * whatever was still recoverable.
 *
 * Throwing leaves the file untouched for recovery. An indexer that will not
 * start is a visible problem; one that silently restarts from nothing and
 * overwrites its own audit trail is not.
 */
export function loadStore(path: string): IndexerStore {
  if (!existsSync(path)) return emptyStore();
  let parsed: IndexerStore;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as IndexerStore;
  } catch (err) {
    throw new Error(
      `Indexer store at ${path} exists but could not be read: ${
        err instanceof Error ? err.message : "unknown error"
      }. It has been left untouched — move it aside to start from empty.`,
    );
  }
  if (!Array.isArray(parsed?.pendingIntents) || !Array.isArray(parsed?.audit)) {
    throw new Error(
      `Indexer store at ${path} parsed but is not a store (missing pendingIntents/audit arrays). It has been left untouched — move it aside to start from empty.`,
    );
  }
  return {
    pendingIntents: parsed.pendingIntents,
    audit: parsed.audit,
    updatedAt: parsed.updatedAt ?? new Date().toISOString(),
  };
}

export function saveStore(path: string, store: IndexerStore): void {
  mkdirSync(dirname(path), { recursive: true });
  store.updatedAt = new Date().toISOString();
  writeFileSync(
    path,
    `${JSON.stringify(
      store,
      (_k, v) => (typeof v === "bigint" ? v.toString() : v),
      2,
    )}\n`,
  );
}
