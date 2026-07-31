import { boolean, integer, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Plan-required mode (F2.31): the requirement one scope runs under.
 *
 * One row per scope — workspace, crew or agent — because the setting is a
 * property of who is acting, not of any one route. A missing row is `off`,
 * which is why an unreadable store leaves crews working exactly as they did
 * before the mode existed: this is a supervision control, not authority, and
 * failing it closed would stop desks over a database blip while every onchain
 * bound still stands.
 */
export const planRequirements = pgTable("orchestrator_plan_requirements", {
  /** `workspace`, `crew:<address>`, or `agent:<address>`. */
  scopeKey: text("scope_key").primaryKey(),
  scope: jsonb("scope").notNull().$type<Record<string, unknown>>(),
  /** `off` | `spends_only` | `side_effects`. */
  mode: text("mode").notNull(),
  /** How long a plan stays current. */
  windowMs: integer("window_ms").notNull(),
  /** Below this, a plan is not a plan. */
  minPlanChars: integer("min_plan_chars").notNull(),
  /** Whether the plan of the seat that delegated the work counts. */
  acceptUpstreamPlan: boolean("accept_upstream_plan").notNull().default(false),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
