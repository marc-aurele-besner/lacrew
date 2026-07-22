import { index, integer, jsonb, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Runtime session + intent records (F1.7). Written by the orchestrator so
 * issued sessions and proposed intents survive restarts and stay queryable
 * without hitting the chain.
 *
 * Session private keys are stored **sealed** (`sealed_key`) and never in
 * cleartext — see `packages/orchestrator/src/secretBox.ts` for the envelope and
 * what the trust boundary actually is. Nothing here is served over HTTP: the
 * session endpoints return metadata only.
 */
export const runtimeSessions = pgTable(
  "orchestrator_sessions",
  {
    /**
     * Session id (onchain uint as string, or mock id). Onchain ids restart
     * from 0 on a fresh local deploy; the upsert overwrites the stale row.
     */
    keyId: text("key_id").primaryKey(),
    agent: text("agent").notNull(),
    /** Ephemeral EOA registered in SessionRegistry (onchain mode only). */
    keyAddress: text("key_address"),
    /**
     * AES-256-GCM envelope around the session private key, so a restart can
     * reuse the live onchain session instead of issuing (and gas-funding) a new
     * one. Null when sealing is not configured — a supported mode in which
     * restarts simply re-issue. Never logged, never served.
     */
    sealedKey: text("sealed_key"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    scopes: jsonb("scopes").notNull().$type<string[]>(),
    maxValue: text("max_value"),
    allowedTarget: text("allowed_target"),
    mode: text("mode").notNull(),
    chainId: integer("chain_id"),
    status: text("status").notNull().default("active"),
    issuedAt: timestamp("issued_at", { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [index("sessions_issued_idx").on(table.issuedAt)],
);

export const runtimeIntents = pgTable(
  "orchestrator_intents",
  {
    id: serial("id").primaryKey(),
    /** Router intent id; "0" for ALLOW spends (no pending intent created). */
    intentId: text("intent_id").notNull(),
    agent: text("agent").notNull(),
    target: text("target").notNull(),
    value: text("value").notNull(),
    verdict: text("verdict").notNull(),
    status: text("status").notNull(),
    txHash: text("tx_hash"),
    resolveTxHash: text("resolve_tx_hash"),
    sessionKeyId: text("session_key_id"),
    chainId: integer("chain_id"),
    proposedAt: timestamp("proposed_at", { withTimezone: true }).notNull(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (table) => [
    index("intents_intent_idx").on(table.intentId),
    index("intents_proposed_idx").on(table.proposedAt),
    index("intents_status_idx").on(table.status),
  ],
);
