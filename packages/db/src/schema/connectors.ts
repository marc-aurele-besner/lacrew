import { index, jsonb, pgTable, text, timestamp, unique } from "drizzle-orm/pg-core";

/**
 * Connector write policy (F2.24): the mode a write route runs in, and the
 * confirmations a mode of `ask` produced.
 *
 * Neither table holds a credential. A mode rule is `auto | ask | deny` against
 * a route pattern; an ask records a request that was *not* sent yet and the
 * human answer that released or refused it.
 */
export const connectorWriteModes = pgTable(
  "orchestrator_connector_modes",
  {
    /** `workspace`, `crew:<address>`, or `agent:<address>`. */
    scopeKey: text("scope_key").notNull(),
    scope: jsonb("scope").notNull().$type<Record<string, unknown>>(),
    /** `<connector>.<route>` or `<connector>.*`. */
    route: text("route").notNull(),
    mode: text("mode").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique("connector_modes_scope_route").on(table.scopeKey, table.route)],
);

export const connectorAsks = pgTable(
  "orchestrator_connector_asks",
  {
    /** Deterministic: run + principal + route + request fingerprint. */
    id: text("id").primaryKey(),
    connector: text("connector").notNull(),
    route: text("route").notNull(),
    method: text("method").notNull(),
    /** Rendered path — what the human is confirming, not a template. */
    path: text("path").notNull(),
    /** Hash of the request a "yes" releases; one yes never covers another call. */
    fingerprint: text("fingerprint").notNull(),
    /** Only the fields the route forwards. No headers, so no credential. */
    args: jsonb("args").notNull().$type<Record<string, unknown>>(),
    principal: text("principal").notNull().default(""),
    threadId: text("thread_id").notNull(),
    questionId: text("question_id").notNull(),
    flowId: text("flow_id"),
    runId: text("run_id"),
    /** `pending` | `approved` | `declined` | `expired` | `consumed`. */
    status: text("status").notNull(),
    /** How it ended, kept once `status` becomes `consumed`. */
    outcome: text("outcome"),
    /**
     * The suspended run, so whichever replica handles the answer can continue
     * it. Step outputs only — the same trace the run result already carries.
     */
    resume: jsonb("resume").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (table) => [
    index("connector_asks_question_idx").on(table.questionId),
    index("connector_asks_status_idx").on(table.status),
  ],
);
