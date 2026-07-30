import {
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
 * Webhook trigger records + their delivery log (F2.22). A trigger binds one
 * flow to one signing secret and one principal; a delivery is one signed
 * request against it.
 *
 * The secret is stored sealed (AES-256-GCM envelope, `secretBox.ts`) — never
 * as cleartext, because HMAC verification needs the key back and a database
 * dump would otherwise hand over the authority to start funded flows.
 */
export const webhookTriggers = pgTable(
  "orchestrator_webhook_triggers",
  {
    /** Public trigger id — the path segment of the hook URL. */
    id: text("id").primaryKey(),
    flowId: text("flow_id").notNull(),
    /** Agent the run executes as; null means the crew's default worker. */
    principal: text("principal"),
    /** Signature scheme the producer speaks: "lacrew" or "github". */
    scheme: text("scheme").notNull(),
    /** JSON envelope from `seal()`. Cleartext secrets never reach this column. */
    secretSealed: text("secret_sealed").notNull(),
    /** Rotation counter, so a delivery line can say which secret verified. */
    secretVersion: integer("secret_version").notNull().default(1),
    enabled: boolean("enabled").notNull().default(true),
    /** Optional body → flow input mapping (`path` / `fields`). */
    inputMap: jsonb("input_map").$type<Record<string, unknown>>(),
    /** Event types this trigger subscribes to; null/empty means all of them. */
    events: jsonb("events").$type<string[]>(),
    /** Non-secret per-source settings (Pub/Sub audience, service account). */
    config: jsonb("config").$type<Record<string, unknown>>(),
    description: text("description"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("webhook_triggers_flow_idx").on(table.flowId)],
);

export const webhookDeliveries = pgTable(
  "orchestrator_webhook_deliveries",
  {
    id: serial("id").primaryKey(),
    triggerId: text("trigger_id").notNull(),
    /**
     * Producer-supplied idempotency key (or a digest of the signature when the
     * producer sent none). Unique per trigger: the insert *is* the idempotency
     * check, so two replicas racing the same delivery cannot both enqueue.
     */
    deliveryKey: text("delivery_key").notNull(),
    /** `accepted` | `rejected` | `run_started` | `run_failed`. */
    result: text("result").notNull(),
    /** Stable snake_case reason; null when the delivery was accepted cleanly. */
    reason: text("reason"),
    /** Run this delivery started, when it got that far. */
    runId: text("run_id"),
    /** Body size — enough to explain a 413 without keeping the body itself. */
    bytes: integer("bytes"),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("webhook_deliveries_key_uq").on(table.triggerId, table.deliveryKey),
    index("webhook_deliveries_at_idx").on(table.at),
  ],
);
