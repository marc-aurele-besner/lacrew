import { boolean, index, integer, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Dual control (F2.32): the rule one scope runs under.
 *
 * One row per scope — workspace, crew or agent — because who must concur is a
 * property of who is acting, not of any one route. A missing row is `off`.
 * Unlike plan-required, an unreadable table is not treated as "off": this
 * control fails closed, so the process refuses the effects it covers rather
 * than quietly delivering the unreviewed merge the operator was paying to
 * prevent.
 */
export const dualControlRules = pgTable("orchestrator_dual_control_rules", {
  /** `workspace`, `crew:<address>`, or `agent:<address>`. */
  scopeKey: text("scope_key").primaryKey(),
  scope: jsonb("scope").notNull().$type<Record<string, unknown>>(),
  /** `off` | `risky_writes` | `spends_and_writes`. */
  mode: text("mode").notNull(),
  /** `manager` | `seat:<address>` | `role:human` | `any_peer_in_crew`. */
  reviewer: text("reviewer").notNull(),
  /** Base units, as a decimal string: the propose carries the same number. */
  minSpend: text("min_spend").notNull().default("0"),
  /** Whether connector and external-MCP writes qualify. */
  connectorWrites: boolean("connector_writes").notNull().default(true),
  /** Whether `org` / `budget` / `governance` mutators qualify. */
  orgMutators: boolean("org_mutators").notNull().default(true),
  /** How long a review waits before the effect fails closed. */
  timeoutMs: integer("timeout_ms").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * The reviews themselves: the effects held, and the decisions that released or
 * refused them.
 *
 * One row per (run, actor, call fingerprint) — the id is derived from that
 * triple, so a restart re-entering the effect finds the question it already
 * posted instead of asking a second time, and a concurrence given for one call
 * can never release a different one. The decision is kept after the run
 * consumes it: a record of a spent concurrence is what stops one answer from
 * releasing the same effect twice.
 */
export const dualControlReviews = pgTable(
  "orchestrator_dual_control_reviews",
  {
    /** Deterministic: run + actor + tool + fingerprint. */
    id: text("id").primaryKey(),
    tool: text("tool").notNull(),
    /** `spend` | `write`. */
    effect: text("effect").notNull(),
    /** Hash of the call a concurrence would release. */
    fingerprint: text("fingerprint").notNull(),
    /** The fields the question showed, already bounded — never a credential. */
    args: jsonb("args").notNull().$type<Record<string, unknown>>(),
    /** Base units of a propose, when this review holds a spend. */
    value: text("value"),
    /** The seat that wants to act; never a qualifying reviewer of its own effect. */
    actor: text("actor").notNull(),
    /** The reviewer spec as configured. */
    reviewer: text("reviewer").notNull(),
    /** Seats asked; empty when the question was addressed to people. */
    reviewers: jsonb("reviewers").notNull().$type<string[]>(),
    human: boolean("human").notNull().default(false),
    /** The configured reviewer was unavailable and this was the fallback. */
    escalated: boolean("escalated").notNull().default(false),
    humanOverride: boolean("human_override").notNull().default(true),
    threadId: text("thread_id").notNull(),
    questionId: text("question_id").notNull(),
    flowId: text("flow_id"),
    runId: text("run_id"),
    /** `pending` | `concurred` | `rejected` | `timed_out` | `cancelled` | `consumed`. */
    status: text("status").notNull(),
    /** How it ended, kept once `status` becomes `consumed`. */
    outcome: text("outcome"),
    /** The seat that decided, as the conversation attributed it. */
    decidedBy: text("decided_by"),
    decidedByKind: text("decided_by_kind"),
    /** FlowResumeState, so whichever replica reads the answer can continue. */
    resume: jsonb("resume").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (table) => [
    index("dual_control_question_idx").on(table.questionId),
    index("dual_control_status_idx").on(table.status),
    index("dual_control_run_idx").on(table.runId),
  ],
);
