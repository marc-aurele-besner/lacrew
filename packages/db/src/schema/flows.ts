import { index, jsonb, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Flow definitions + run traces (F1.17). Written by the orchestrator's flows
 * surface so saved pipelines and their history survive restarts; consumers
 * read these tables, never the orchestrator's memory.
 */
export const flowDefinitions = pgTable(
  "orchestrator_flows",
  {
    /** Flow id (definition.id) — one row per flow, upserted on save. */
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    /** Full FlowDefinition JSON — the source of truth for scope. */
    definition: jsonb("definition").notNull().$type<Record<string, unknown>>(),
    /**
     * Scope denormalized out of `definition` so listings can filter in SQL.
     * Null means org-wide (a flow saved without an explicit scope).
     */
    scopeLevel: text("scope_level"),
    /** Team root node or agent address; null for org scope. */
    scopeRef: text("scope_ref"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("flows_scope_idx").on(table.scopeLevel, table.scopeRef)],
);

export const flowRuns = pgTable(
  "orchestrator_flow_runs",
  {
    id: serial("id").primaryKey(),
    runId: text("run_id").notNull().unique(),
    flowId: text("flow_id").notNull(),
    status: text("status").notNull(),
    /** Agent the run executed as; null for runs predating scoped principals. */
    principal: text("principal"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }).notNull(),
    /** Full FlowRunResult JSON (steps, verdicts, summaries). */
    result: jsonb("result").notNull().$type<Record<string, unknown>>(),
  },
  (table) => [
    index("flow_runs_flow_idx").on(table.flowId),
    index("flow_runs_started_idx").on(table.startedAt),
  ],
);
