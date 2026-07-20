/**
 * FlowStore: pluggable persistence for flow definitions + run traces.
 * Postgres (Drizzle via @lacrew/db) when DATABASE_URL is set, else memory
 * no-op — same provider pattern as AuditStore / QueueProvider / ModelProvider.
 */

import {
  createDb,
  deleteFlowDefinition,
  getDatabaseUrl,
  insertFlowRun,
  listFlowDefinitions,
  recentFlowRuns,
  upsertFlowDefinition,
  type DbHandle,
} from "@lacrew/db";
import type { FlowDefinition, FlowRunResult } from "@lacrew/flows";

export interface FlowStore {
  readonly name: string;
  /** Persist a definition; must never throw into the caller's flow. */
  save(def: FlowDefinition): Promise<void>;
  remove(id: string): Promise<void>;
  /** All persisted definitions (hydrated into the surface on boot). */
  list(): Promise<FlowDefinition[]>;
  appendRun(run: FlowRunResult): Promise<void>;
  /** Most recent runs, newest → oldest. */
  recentRuns(limit: number): Promise<FlowRunResult[]>;
  close(): Promise<void>;
}

/** No-op store for mock demos and tests. */
export function createMemoryFlowStore(): FlowStore {
  return {
    name: "memory",
    save: async () => {},
    remove: async () => {},
    list: async () => [],
    appendRun: async () => {},
    recentRuns: async () => [],
    close: async () => {},
  };
}

export function createPgFlowStore(url = getDatabaseUrl()): FlowStore {
  let handle: DbHandle | undefined;
  const db = () => (handle ??= createDb(url));
  const warn = (op: string, err: unknown) =>
    console.error(`[@lacrew/orchestrator] flow ${op} failed:`, err);

  return {
    name: "postgres",
    save: async (def) => {
      try {
        await upsertFlowDefinition(db(), {
          id: def.id,
          name: def.name,
          definition: def as unknown as Record<string, unknown>,
          scopeLevel: def.scope?.level ?? null,
          scopeRef: def.scope?.ref ?? null,
        });
      } catch (err) {
        warn("save", err);
      }
    },
    remove: async (id) => {
      try {
        await deleteFlowDefinition(db(), id);
      } catch (err) {
        warn("remove", err);
      }
    },
    list: async () => {
      try {
        const rows = await listFlowDefinitions(db());
        return rows.map((row) => row.definition as unknown as FlowDefinition);
      } catch (err) {
        warn("list", err);
        return [];
      }
    },
    appendRun: async (run) => {
      try {
        await insertFlowRun(db(), {
          runId: run.runId,
          flowId: run.flowId,
          status: run.status,
          principal: run.principal?.agent ?? null,
          startedAt: run.startedAt,
          finishedAt: run.finishedAt,
          result: run as unknown as Record<string, unknown>,
        });
      } catch (err) {
        warn("run append", err);
      }
    },
    recentRuns: async (limit) => {
      try {
        const rows = await recentFlowRuns(db(), limit);
        return rows.map((row) => row.result as unknown as FlowRunResult);
      } catch (err) {
        warn("runs list", err);
        return [];
      }
    },
    close: async () => {
      await handle?.close();
      handle = undefined;
    },
  };
}

/** Postgres when DATABASE_URL is set, memory otherwise. */
export function createFlowStoreFromEnv(): FlowStore {
  return getDatabaseUrl() ? createPgFlowStore() : createMemoryFlowStore();
}
