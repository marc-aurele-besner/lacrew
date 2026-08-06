import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

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

/**
 * Standing per-agent controls (F1.7): the pause gate and the directive.
 *
 * One row per agent, replaced wholesale on write — a directive is edited as a
 * document, not accumulated, and diffing layers to preserve row identity would
 * buy nothing an operator can see.
 *
 * These outlive the process on purpose. A pause that vanished on restart fails
 * safe; a directive that vanished does not — an agent silently reverting to no
 * guidelines, no resources and no skills keeps working, and does the wrong
 * thing competently.
 */
export const runtimeAgentControls = pgTable("orchestrator_agent_controls", {
  /** Lowercased agent address; one row per agent. */
  agent: text("agent").primaryKey(),
  paused: boolean("paused").notNull().default(false),
  pausedAt: timestamp("paused_at", { withTimezone: true }),
  /** Free-text reason an operator gave; surfaced in the trail and the UI. */
  pausedReason: text("paused_reason"),
  /**
   * Ordered directive layers, each `{label, text?, resources?, skills?}`.
   * Stored as written rather than as rendered prompt text, so the editor can
   * round-trip what an operator typed instead of re-parsing a rendering.
   */
  layers: jsonb("layers").notNull().default([]).$type<unknown[]>(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Crew conversation (F1.7): the third channel, beside intents and proposals.
 *
 * Deliberately its own table rather than rows in the audit trail. The audit
 * trail records what the protocol did and is the thing users are asked to
 * trust; a message is a claim someone made about it. Merging the two would let
 * an agent's assertion sit in the record of settled facts, which is precisely
 * the confusion this channel must not create.
 */
export const runtimeMessages = pgTable(
  "orchestrator_messages",
  {
    id: text("id").primaryKey(),
    /** `crew:<id>`, `agent:<address>`, or `org`. */
    threadId: text("thread_id").notNull(),
    at: timestamp("at", { withTimezone: true }).notNull(),
    author: text("author").notNull(),
    /**
     * Stable id of the seat the posting surface authenticated (F2.27). Stored
     * beside the rendered name because that name is renameable and an assigned
     * gate is matched on this: a resolved gate whose message kept only the
     * display name stops being attributable the moment somebody is renamed.
     */
    authorId: text("author_id"),
    /** "agent" | "human" — who is speaking, which the UI must never guess. */
    authorKind: text("author_kind").notNull(),
    kind: text("kind").notNull(),
    body: text("body").notNull(),
    options: jsonb("options").$type<string[]>(),
    replyTo: text("reply_to"),
    recipient: text("recipient"),
    /** Intents, proposals, txs or flow runs this message claims to be about. */
    refs: jsonb("refs").$type<unknown[]>(),
    /** Rich content — links, fields, code, internal references (F1.7). */
    blocks: jsonb("blocks").$type<unknown[]>(),
    /**
     * Channel this line was bridged in from, when it was not the app (F2.19).
     * Provenance survives the restart with the sentence it labels: a message
     * that came back from storage looking app-native would be presenting a
     * chat line and a signed-in post as the same thing.
     */
    via: text("via"),
  },
  (table) => [index("messages_thread_idx").on(table.threadId, table.at)],
);
