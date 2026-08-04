import { index, integer, jsonb, pgTable, serial, text, timestamp, unique } from "drizzle-orm/pg-core";

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

/**
 * Where a run actually is, right now (F2.26).
 *
 * `orchestrator_flow_runs` is the finished trace — it is written when a run
 * ends, so a process killed mid-run leaves nothing there at all. This table is
 * written *during* the run, one row per run, and is what a restarting
 * orchestrator reads to find work that was in flight.
 *
 * `attempt` is the reconciliation hinge: it is set before a side-effecting step
 * calls and cleared once the call returned. A row that comes back with `status`
 * running and a non-null `attempt` is a crash mid-write, and the default answer
 * to that is to fail the run — not to retry a payment nobody can prove did or
 * did not happen.
 *
 * Nothing here is authority. A resume re-runs the same policy checks as the
 * same principal; the state only says where to pick up.
 */
export const flowRunState = pgTable(
  "orchestrator_flow_run_state",
  {
    runId: text("run_id").primaryKey(),
    flowId: text("flow_id").notNull(),
    /** running | paused | completed | error | cancelled | max_steps. */
    status: text("status").notNull(),
    /**
     * An operator's standing request, read between steps by the running
     * worker: `pause` or `cancel`, cleared once honoured. A request rather than
     * a mutation because the run may be moving in another process.
     */
    request: text("request"),
    /** Agent the run executes as; a resume uses this one, never a fresher one. */
    principal: text("principal"),
    trigger: text("trigger"),
    /** Step a resume enters; null when the run went no further. */
    cursor: text("cursor"),
    /** FlowResumeState — outputs and traces of everything already done. */
    state: jsonb("state").$type<Record<string, unknown>>(),
    /** FlowWaiting — set while the run is paused. */
    pause: jsonb("pause").$type<Record<string, unknown>>(),
    /** FlowAttempt, non-null only while a side-effecting step is in flight. */
    attempt: jsonb("attempt").$type<Record<string, unknown>>(),
    /**
     * The run whose `agent` step delegated this one (F2.24 / F2.27), and the
     * step it delegated from. Null on every run a person or a trigger started.
     *
     * This is the link a parked child is woken *up* through: when the child
     * ends, the parent parked on `awaiting_child` is the row named here, and
     * the parent's own pause token carries this run's id back the other way.
     * The pair is unique because one step delegates one run — a second row for
     * the same (run, step) would mean a resume started the delegate twice,
     * which is precisely the double-write the checkpoint ledger exists to stop.
     */
    parentRunId: text("parent_run_id"),
    parentStepId: text("parent_step_id"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("flow_run_state_status_idx").on(table.status),
    index("flow_run_state_updated_idx").on(table.updatedAt),
    unique("flow_run_state_parent_step_uq").on(table.parentRunId, table.parentStepId),
  ],
);

/**
 * The checkpoint ledger: one row per completed step, written before the next
 * step starts.
 *
 * `orchestrator_flow_run_state` already holds the latest cursor, so this is not
 * what a resume reads — it is the trail that says which steps had happened at
 * the moment of a crash, which is the question asked when reconciling a write
 * by hand. `(run_id, seq)` is unique so a redelivered resume overwrites its own
 * row instead of forking the history.
 */
export const flowCheckpoints = pgTable(
  "orchestrator_flow_checkpoints",
  {
    id: serial("id").primaryKey(),
    runId: text("run_id").notNull(),
    /** Monotonic within a run; 1 for the first completed step. */
    seq: integer("seq").notNull(),
    flowId: text("flow_id").notNull(),
    stepId: text("step_id").notNull(),
    /** Cursor after this step; null when the run went no further. */
    nextStepId: text("next_step_id"),
    /** running | paused. */
    status: text("status").notNull(),
    pause: jsonb("pause").$type<Record<string, unknown>>(),
    state: jsonb("state").$type<Record<string, unknown>>(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("flow_checkpoints_run_seq_uq").on(table.runId, table.seq),
    index("flow_checkpoints_run_idx").on(table.runId),
  ],
);

/**
 * Blocking human gates (F2.27): the questions holding runs, and the decisions
 * that released them.
 *
 * One row per (run, step) — the id is derived from that pair, so re-entering a
 * gate after a restart finds the question it already posted instead of asking a
 * second time. The decision is kept after the run consumes it: a record of a
 * spent answer is what stops one "yes" from releasing the same branch twice.
 */
export const humanGates = pgTable(
  "orchestrator_human_gates",
  {
    /** Deterministic: run + flow + step + principal. */
    id: text("id").primaryKey(),
    flowId: text("flow_id"),
    runId: text("run_id"),
    stepId: text("step_id").notNull(),
    /** The question as a person read it, already interpolated. */
    prompt: text("prompt").notNull(),
    /** `[{ id, label }]` — the only answers that resolve this gate. */
    options: jsonb("options").notNull().$type<Array<Record<string, unknown>>>(),
    /** Human seat or role the question was addressed to. Advisory. */
    assignee: text("assignee"),
    principal: text("principal").notNull().default(""),
    threadId: text("thread_id").notNull(),
    questionId: text("question_id").notNull(),
    /** `pending` | `answered` | `timed_out` | `cancelled` | `consumed`. */
    status: text("status").notNull(),
    /** How it ended, kept once `status` becomes `consumed`. */
    outcome: text("outcome"),
    /** The option picked, on an answered gate. */
    optionId: text("option_id"),
    /** The human seat that picked it, as the conversation attributed it. */
    answeredBy: text("answered_by"),
    /** FlowResumeState, so whichever replica reads the answer can continue. */
    resume: jsonb("resume").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (table) => [
    index("human_gates_question_idx").on(table.questionId),
    index("human_gates_status_idx").on(table.status),
    index("human_gates_run_idx").on(table.runId),
  ],
);
