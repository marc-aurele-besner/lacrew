import { boolean, index, jsonb, pgTable, text, timestamp, unique } from "drizzle-orm/pg-core";

/**
 * Crew heartbeats (F2.21): one standing checklist per crew, and the ledger of
 * the ticks it fired.
 *
 * The tick row is not only a log — its unique `(crew_id, window_key)` is the
 * coalescing guarantee. The runner inserts before doing any work, so a second
 * dispatch of the same minute finds the row taken and stops, and two replicas
 * sharing a queue cannot both work through the same crew's list.
 *
 * Nothing here is a credential and nothing here is authority: a checklist names
 * flows and skills that already exist, and a heartbeat that could not be read
 * simply does not fire.
 */
export const crewHeartbeats = pgTable("orchestrator_crew_heartbeats", {
  /** Crew id, lowercased — also the thread (`crew:<id>`) summaries land in. */
  crewId: text("crew_id").primaryKey(),
  /** 5-field cron, read in `timezone`. */
  schedule: text("schedule").notNull(),
  /** IANA zone; null means UTC. */
  timezone: text("timezone"),
  /** `{ start, end }` "HH:MM" local times, or null for no quiet window. */
  quietHours: jsonb("quiet_hours").$type<Record<string, unknown>>(),
  /** Ordered `{ kind, id, input?, as? }` items. */
  checklist: jsonb("checklist").notNull().$type<unknown[]>(),
  /** Default seat every item runs as; null means the crew's default worker. */
  principal: text("principal"),
  /** Cheap-model override for this tick's skill items. */
  model: text("model"),
  notifyOnOk: boolean("notify_on_ok").notNull().default(true),
  stopOnError: boolean("stop_on_error").notNull().default(false),
  enabled: boolean("enabled").notNull().default(false),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const crewHeartbeatTicks = pgTable(
  "orchestrator_crew_heartbeat_ticks",
  {
    crewId: text("crew_id").notNull(),
    /** `<crewId>@<minute>` — the claim, not just a label. */
    windowKey: text("window_key").notNull(),
    /** `running` | `ok` | `attention` | `failed` | `skipped`. */
    status: text("status").notNull(),
    /** Per-item outcomes: id, kind, principal, status, runId, detail. */
    items: jsonb("items").$type<unknown[]>(),
    /** Thread message this tick posted, when it posted one. */
    messageId: text("message_id"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (table) => [
    unique("crew_heartbeat_ticks_window_uq").on(table.crewId, table.windowKey),
    index("crew_heartbeat_ticks_started_idx").on(table.startedAt),
  ],
);
