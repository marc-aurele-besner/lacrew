import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";

/**
 * Inference & API cost budgets (F2.28): what a crew's model usage may cost,
 * what it has cost this period, and the calls that figure is made of.
 *
 * Nothing here is authority and nothing here is money. A budget cannot approve,
 * deny or resize an onchain action — exhausting one stops model calls, and a
 * proposal made without a model still goes through. The tables exist so the
 * number an operator is shown is the number the guard reads.
 *
 * The usage row, not the event log, is the enforced counter: it is incremented
 * in SQL (`used = used + n`) so two replicas metering the same crew cannot lose
 * a call to a read-modify-write race. The event log is the breakdown behind it,
 * pruned on a retention window, and losing it costs an export rather than a
 * limit.
 */
export const inferenceBudgets = pgTable(
  "orchestrator_inference_budgets",
  {
    /** `crew:<id>` or `crew:<id>/agent:<0x…>` — the metered subject. */
    scopeKey: text("scope_key").primaryKey(),
    crewId: text("crew_id").notNull(),
    /** Null for a crew-wide budget. */
    agentId: text("agent_id"),
    /** `calendar_month` | `epoch` | `window`. */
    period: text("period").notNull(),
    /** `window` only: length in days. */
    windowDays: integer("window_days"),
    /** `epoch` only: length in seconds, mirroring the streamer's. */
    epochSeconds: integer("epoch_seconds"),
    /** `epoch` / `window`: instant period boundaries are counted from. */
    anchorAt: timestamp("anchor_at", { withTimezone: true }),
    /** `{ maxUsd?, maxInputTokens?, maxOutputTokens? }` — any subset. */
    limits: jsonb("limits").notNull().$type<Record<string, unknown>>(),
    /** `soft` (warn) | `hard` (refuse further completions). */
    policy: text("policy").notNull(),
    /** Model to fall back to past the warn line. */
    cheapModel: text("cheap_model"),
    /** Hard breach stops the heartbeat rather than every call the crew makes. */
    pauseHeartbeatOnBreach: boolean("pause_heartbeat_on_breach").notNull().default(true),
    enabled: boolean("enabled").notNull().default(false),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("inference_budgets_crew_idx").on(table.crewId)],
);

export const inferenceUsage = pgTable(
  "orchestrator_inference_usage",
  {
    scopeKey: text("scope_key").notNull(),
    /** `2026-07`, `window:<ms>:<n>`, `epoch:<ms>:<n>` — rollover is a new key. */
    periodKey: text("period_key").notNull(),
    /**
     * Counted whether or not a budget exists for this scope. Metering that
     * only starts when a limit is set would make the first budget an operator
     * writes read as zero-used on a crew that has been running for weeks.
     */
    inputTokens: bigint("input_tokens", { mode: "number" }).notNull().default(0),
    outputTokens: bigint("output_tokens", { mode: "number" }).notNull().default(0),
    /** Integer micro-dollars: millions of sub-cent calls must still add up. */
    usdMicros: bigint("usd_micros", { mode: "number" }).notNull().default(0),
    calls: integer("calls").notNull().default(0),
    /** Calls no price was known for — why the dollar figure may read low. */
    unpricedCalls: integer("unpriced_calls").notNull().default(0),
    /** Alert state already announced, so one crossing sends one alert. */
    alertedState: text("alerted_state").notNull().default("ok"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique("inference_usage_scope_period").on(table.scopeKey, table.periodKey)],
);

export const inferenceUsageEvents = pgTable(
  "orchestrator_inference_usage_events",
  {
    id: serial("id").primaryKey(),
    scopeKey: text("scope_key").notNull(),
    periodKey: text("period_key").notNull(),
    /** Model as the provider named it, kept verbatim for the breakdown. */
    model: text("model").notNull(),
    provider: text("provider"),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    /** Null when the call could not be priced — never stored as zero. */
    usdMicros: bigint("usd_micros", { mode: "number" }),
    /** `provider` | `table` | `none`: where the number came from. */
    priceSource: text("price_source").notNull(),
    /** True when tokens were approximated because none were reported. */
    tokensEstimated: boolean("tokens_estimated").notNull().default(false),
    /** Flow run this call belonged to, when it belonged to one. */
    runId: text("run_id"),
    flowId: text("flow_id"),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("inference_usage_events_scope_idx").on(table.scopeKey, table.periodKey),
    index("inference_usage_events_at_idx").on(table.at),
  ],
);
