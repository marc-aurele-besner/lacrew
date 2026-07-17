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

export function loadStore(path: string): IndexerStore {
  if (!existsSync(path)) return emptyStore();
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as IndexerStore;
    return {
      pendingIntents: parsed.pendingIntents ?? [],
      audit: parsed.audit ?? [],
      updatedAt: parsed.updatedAt ?? new Date().toISOString(),
    };
  } catch {
    return emptyStore();
  }
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
