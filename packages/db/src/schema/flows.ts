import { index, jsonb, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Flow definitions + run traces (F1.17). Written by the orchestrator's flows
 * surface so saved pipelines and their history survive restarts; consumers
 * read these tables, never the orchestrator's memory.
 */
export const flowDefinitions = pgTable("orchestrator_flows", {
  /** Flow id (definition.id) — one row per flow, upserted on save. */
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  /** Full FlowDefinition JSON. */
  definition: jsonb("definition").notNull().$type<Record<string, unknown>>(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const flowRuns = pgTable(
  "orchestrator_flow_runs",
  {
    id: serial("id").primaryKey(),
    runId: text("run_id").notNull().unique(),
    flowId: text("flow_id").notNull(),
    status: text("status").notNull(),
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
