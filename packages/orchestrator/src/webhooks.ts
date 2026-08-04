/**
 * Webhook flow triggers (F2.22): signed HTTP deliveries start a scoped flow run
 * as a declared principal.
 *
 * The shape is deliberately two-phase. `accept()` runs on the HTTP thread and
 * does only what a producer needs an answer for — verify, size-check, resolve,
 * claim the delivery key — then hands a job to the queue. `deliver()` runs the
 * flow on a worker. A producer's socket must never be the thing keeping a
 * funded run alive, and a delivery that takes minutes of model time would
 * otherwise be retried by every sane webhook sender while it was still working.
 *
 * A webhook never widens authority. The run executes as the trigger's principal
 * through the same `flows.run` path as a manual run, so the principal's policy
 * stack, session-key ceiling, and pause state all still apply. What a hook adds
 * is *who may start it*, and that is exactly the HMAC's job.
 */

import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { FlowDefinition, FlowRunResult } from "@lacrew/flows";
import { isSealedSecret, seal, sessionSealingAvailable, unseal } from "./secretBox.js";
import { createWebhookStoreFromEnv, type WebhookStore } from "./webhookStore.js";
import { generateWebhookSecret } from "./webhookSignature.js";
import {
  eventSelected,
  getEventSource,
  isEventSource,
  type EventSourceConfig,
  type EventSourceId,
} from "./eventSources.js";
import type { JwksFetcher } from "./googleOidc.js";
import type { CrewRuntime } from "./runtime.js";
import type { FlowsSurface } from "./flows.js";

/** Default body cap. Big enough for a GitHub `pull_request` event, far from OOM. */
const DEFAULT_MAX_BODY_BYTES = 1_048_576;

const DELIVERY_LOG_LIMIT = 100;

export function webhookMaxBodyBytes(): number {
  const raw = Number(process.env.LACREW_WEBHOOK_MAX_BYTES ?? 0);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MAX_BODY_BYTES;
}

/**
 * How a delivery body becomes the flow's `input` string.
 *
 * `fields` maps flow-visible names to dot paths in the body, producing a flat
 * JSON object — flat because `interpolate` only reaches `{{input.<key>}}` at the
 * top level, so a nested passthrough would render as an empty string and look
 * like a missing field rather than an unreachable one. `path` lifts a single
 * value. Neither given, the whole body is passed through as JSON.
 */
export type WebhookInputMap = {
  path?: string;
  fields?: Record<string, string>;
};

/** Public view of a trigger. Never carries the secret — not even sealed. */
export type WebhookTrigger = {
  id: string;
  flowId: string;
  principal?: `0x${string}`;
  /** Which event source speaks to this hook (`lacrew` | `github` | `google-pubsub`). */
  scheme: EventSourceId;
  enabled: boolean;
  input?: WebhookInputMap;
  description?: string;
  /**
   * Event types this trigger wants. Empty or absent means every delivery runs.
   * Dotted prefixes select subtypes, so `pull_request` covers
   * `pull_request.opened` without listing each action.
   */
  events?: string[];
  /** Non-secret per-source settings (Pub/Sub audience, service account). */
  config?: EventSourceConfig;
  /** Absent for sources that authenticate the sender instead of sharing a key. */
  secretVersion?: number;
};

export type WebhookDelivery = {
  triggerId: string;
  deliveryKey: string;
  result: string;
  reason?: string | null;
  runId?: string | null;
  bytes?: number | null;
  at: string;
};

/** Job handed to the queue once a delivery is accepted. */
export type WebhookJob = {
  triggerId: string;
  deliveryKey: string;
  runId: string;
  input: string;
};

export type WebhookAccept =
  | {
      ok: true;
      status: 202;
      runId: string;
      deliveryKey: string;
      job: WebhookJob;
    }
  | { ok: true; status: 200; duplicate: true; deliveryKey: string }
  /**
   * Verified and well-formed, but the trigger did not subscribe to this event
   * type. A 2xx on purpose: GitHub sends every subscribed event and disables a
   * hook that keeps answering 4xx, so "not interested" must not read as
   * "broken".
   */
  | { ok: true; status: 200; skipped: string; eventType?: string }
  | { ok: false; status: number; error: string };

export type WebhookCreateInput = {
  flowId: string;
  principal?: `0x${string}`;
  scheme?: EventSourceId;
  input?: WebhookInputMap;
  description?: string;
  events?: string[];
  config?: EventSourceConfig;
  /** Operator-supplied secret; one is generated when omitted. */
  secret?: string;
};

export type WebhookSurface = {
  list(): WebhookTrigger[];
  get(id: string): WebhookTrigger | undefined;
  /**
   * Returns the cleartext secret exactly once — it is not readable again.
   * Absent for sources that authenticate the sender rather than share a key.
   */
  create(input: WebhookCreateInput): Promise<{ trigger: WebhookTrigger; secret?: string }>;
  rotate(id: string, secret?: string): Promise<{ trigger: WebhookTrigger; secret?: string }>;
  setEnabled(id: string, enabled: boolean): Promise<WebhookTrigger>;
  remove(id: string): Promise<boolean>;
  deliveries(limit?: number, triggerId?: string): Promise<WebhookDelivery[]>;
  /** Verify + claim a delivery on the HTTP thread. Never runs the flow. */
  accept(input: {
    triggerId: string;
    rawBody: string;
    header: (name: string) => string | undefined;
    /** Declared body size, when the transport supplied one. */
    contentLength?: number;
  }): Promise<WebhookAccept>;
  /** Run a claimed delivery. Called by the queue worker, not by HTTP. */
  deliver(job: WebhookJob): Promise<FlowRunResult | null>;
  hydrate(): Promise<number>;
  storeName: string;
};

/** Trigger ids are public (they sit in the URL); random so they are unguessable. */
function newTriggerId(): string {
  return `wht_${randomBytes(12).toString("base64url")}`;
}

/** Resolve a dot path (`pull_request.title`, `commits.0.id`) against a body. */
export function readPath(body: unknown, path: string): unknown {
  let cursor: unknown = body;
  for (const part of path.split(".")) {
    if (cursor === null || cursor === undefined) return undefined;
    if (Array.isArray(cursor)) {
      const index = Number(part);
      if (!Number.isInteger(index)) return undefined;
      cursor = cursor[index];
      continue;
    }
    if (typeof cursor !== "object") return undefined;
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return cursor;
}

function asInputValue(value: unknown): string {
  if (value === undefined || value === null) return "";
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

/** Body → the flow's `input` string, per the trigger's mapping. */
export function mapWebhookInput(body: unknown, map: WebhookInputMap | undefined): string {
  if (map?.fields && Object.keys(map.fields).length > 0) {
    const out: Record<string, string> = {};
    for (const [key, path] of Object.entries(map.fields)) {
      out[key] = asInputValue(readPath(body, path));
    }
    return JSON.stringify(out);
  }
  if (map?.path) return asInputValue(readPath(body, map.path));
  return JSON.stringify(body ?? null);
}

/**
 * The producer's idempotency key, or a digest of the signature when it sent
 * none. The signature already covers the body (and, on the `lacrew` scheme, the
 * timestamp), so its digest identifies one delivery attempt without the log
 * holding anything that could be replayed.
 */
function deliveryKeyFor(header: (name: string) => string | undefined): string {
  const explicit =
    header("idempotency-key") ?? header("x-github-delivery") ?? header("x-lacrew-delivery");
  if (explicit?.trim()) return explicit.trim().slice(0, 200);
  const signature = header("x-lacrew-signature") ?? header("x-hub-signature-256") ?? randomUUID();
  return `sig_${createHash("sha256").update(signature).digest("hex").slice(0, 32)}`;
}

/**
 * A rejection's log key.
 *
 * Deliberately not the producer's key: a rejected delivery established no
 * idempotency, and reusing the key would make the correctly-signed retry look
 * like a replay of the failure and get dropped.
 */
function rejectionKey(): string {
  return `rej_${randomUUID()}`;
}

/** Trim, drop blanks, de-duplicate — an events filter is a set, not a list. */
function normalizeEvents(events: string[] | undefined): string[] {
  if (!Array.isArray(events)) return [];
  return [...new Set(events.map((e) => String(e).trim()).filter(Boolean))];
}

/**
 * Keep only the config keys a source declares.
 *
 * Config is operator-supplied JSON that gets persisted and echoed back, so an
 * unrecognized key would be stored and served forever without ever being read.
 */
function pickConfig(config: EventSourceConfig): EventSourceConfig {
  const out: EventSourceConfig = {};
  if (config.audience?.trim()) out.audience = config.audience.trim();
  if (config.serviceAccountEmail?.trim()) {
    out.serviceAccountEmail = config.serviceAccountEmail.trim();
  }
  return out;
}

export function createWebhookSurface(opts: {
  runtime: CrewRuntime;
  flows: FlowsSurface;
  /** Hands an accepted delivery to the queue; the HTTP thread never runs it. */
  enqueue: (job: WebhookJob) => Promise<void>;
  store?: WebhookStore;
  /** Test seam for Google's key set; production reaches the real endpoint. */
  jwksFetcher?: JwksFetcher;
}): WebhookSurface {
  const store = opts.store ?? createWebhookStoreFromEnv();
  const triggers = new Map<string, WebhookTrigger>();
  /** Cleartext secrets, in process only. The store holds them sealed. */
  const secrets = new Map<string, string>();

  const view = (t: WebhookTrigger): WebhookTrigger => ({ ...t });

  /**
   * Seal a secret for storage, refusing when the store outlives the process and
   * no sealing key is configured. Writing a cleartext secret to Postgres would
   * make a database dump enough to start funded flows, which is the exact thing
   * the envelope exists to prevent — so this fails loudly rather than degrading.
   */
  const sealForStore = (secret: string): string => {
    if (!store.durable) return "";
    if (!sessionSealingAvailable()) {
      throw new Error("webhook_sealing_unavailable");
    }
    return JSON.stringify(seal(secret));
  };

  const persist = async (trigger: WebhookTrigger, secret: string | undefined): Promise<void> => {
    await store.save({
      id: trigger.id,
      flowId: trigger.flowId,
      principal: trigger.principal ?? null,
      scheme: trigger.scheme,
      secretSealed: secret ? sealForStore(secret) : "",
      secretVersion: trigger.secretVersion ?? 0,
      enabled: trigger.enabled,
      inputMap: trigger.input ? (trigger.input as Record<string, unknown>) : null,
      description: trigger.description ?? null,
      events: trigger.events ?? null,
      config: trigger.config ? (trigger.config as Record<string, unknown>) : null,
    });
  };

  /**
   * A flow must declare `trigger: "webhook"` before a hook can point at it.
   * Without that, creating a trigger record would be enough to make any saved
   * flow remotely startable, and the definition — the thing an operator reads
   * and the marketplace ships — would not say so.
   */
  const requireWebhookFlow = async (flowId: string): Promise<FlowDefinition> => {
    // Always through the store: this runs on registration and on every
    // delivery, both of which can land on a replica that booted before the flow
    // was saved, and both of which already touch the database anyway.
    const def = await opts.flows.get(flowId, { refresh: true });
    if (!def) throw new Error("flow_not_found");
    if (def.trigger !== "webhook") throw new Error("flow_not_webhook_triggered");
    return def;
  };

  /** Adopt a store row into the in-process maps, unsealing its secret. */
  const adopt = (row: Awaited<ReturnType<WebhookStore["get"]>>): WebhookTrigger | undefined => {
    if (!row || !isEventSource(row.scheme)) return undefined;
    const trigger: WebhookTrigger = {
      id: row.id,
      flowId: row.flowId,
      ...(row.principal ? { principal: row.principal as `0x${string}` } : {}),
      scheme: row.scheme,
      enabled: row.enabled,
      ...(row.inputMap ? { input: row.inputMap as WebhookInputMap } : {}),
      ...(row.description ? { description: row.description } : {}),
      ...(row.events?.length ? { events: row.events } : {}),
      ...(row.config ? { config: row.config as EventSourceConfig } : {}),
      ...(row.secretVersion ? { secretVersion: row.secretVersion } : {}),
    };
    triggers.set(row.id, trigger);
    const secret = row.secretSealed ? readSealed(row.id, row.secretSealed) : null;
    if (secret) secrets.set(row.id, secret);
    else if (store.durable && getEventSource(trigger.scheme).usesSecret) {
      // Sealed material exists and could not be opened — wrong key, or a
      // tampered row. Dropping the in-process copy is what turns that into a
      // 503 instead of quietly verifying against the last secret this process
      // happened to see.
      secrets.delete(row.id);
    }
    // A non-durable store keeps nothing at rest, so it has no sealed material
    // to disagree with; the in-process secret stays authoritative.
    return trigger;
  };

  /**
   * Resolve a trigger from the store on every delivery, not from a cache.
   *
   * The process that mints a trigger and the one that handles its delivery are
   * routinely different: a durable deployment runs several replicas against one
   * queue, and pg-boss hands the job to whichever is free. Resolving from the
   * map hydrated at boot makes every hook created since look deleted — a 404 to
   * the producer, a dropped job on the worker.
   *
   * Reading through only on a *miss* would fix that and still leave the worse
   * half: a secret rotated on another replica would keep verifying here for
   * this process's whole lifetime, so revoking a leaked secret would not
   * actually revoke it. The cost of getting that right is one primary-key
   * lookup per delivery, against a path that is about to write a delivery row
   * to the same database anyway. The map remains the fallback for a store that
   * cannot answer.
   */
  const resolve = async (id: string): Promise<WebhookTrigger | undefined> => {
    return adopt(await store.get(id)) ?? triggers.get(id);
  };

  const recordChange = (
    trigger: WebhookTrigger,
    action: "created" | "rotated" | "enabled" | "disabled" | "removed",
  ): void => {
    opts.runtime.recordAudit({
      type: "WebhookTriggerChanged",
      at: new Date().toISOString(),
      payload: {
        action,
        triggerId: trigger.id,
        flowId: trigger.flowId,
        scheme: trigger.scheme,
        principal: trigger.principal ?? null,
        secretVersion: trigger.secretVersion,
        enabled: trigger.enabled,
      },
    });
  };

  const reject = async (
    triggerId: string,
    status: number,
    error: string,
    bytes?: number,
  ): Promise<WebhookAccept> => {
    if (triggers.has(triggerId)) {
      await store.logDelivery({
        triggerId,
        deliveryKey: rejectionKey(),
        result: "rejected",
        reason: error,
        runId: null,
        bytes: bytes ?? null,
      });
    }
    return { ok: false, status, error };
  };

  const surface: WebhookSurface = {
    list: () => [...triggers.values()].map(view),
    get: (id) => {
      const found = triggers.get(id);
      return found ? view(found) : undefined;
    },

    create: async (input) => {
      await requireWebhookFlow(input.flowId);
      const scheme = input.scheme ?? "lacrew";
      if (!isEventSource(scheme)) throw new Error("unknown_event_source");
      if (input.principal && !/^0x[0-9a-fA-F]{40}$/.test(input.principal)) {
        throw new Error("invalid_principal");
      }
      const source = getEventSource(scheme);
      // Required config is checked here rather than at delivery time: a Pub/Sub
      // hook without an audience would accept a token minted for anybody's
      // subscription, and learning that from the first live event is far too
      // late for a trigger that starts funded flows.
      const missing = source.requiredConfig.filter((key) => !input.config?.[key]?.trim());
      if (missing.length > 0) throw new Error(`source_config_required: ${missing.join(", ")}`);

      const events = normalizeEvents(input.events);
      const secret = source.usesSecret
        ? input.secret?.trim() || generateWebhookSecret()
        : undefined;
      const trigger: WebhookTrigger = {
        id: newTriggerId(),
        flowId: input.flowId,
        ...(input.principal ? { principal: input.principal } : {}),
        scheme,
        enabled: true,
        ...(input.input ? { input: input.input } : {}),
        ...(input.description ? { description: input.description } : {}),
        ...(events.length > 0 ? { events } : {}),
        ...(input.config ? { config: pickConfig(input.config) } : {}),
        ...(secret ? { secretVersion: 1 } : {}),
      };
      await persist(trigger, secret);
      triggers.set(trigger.id, trigger);
      if (secret) secrets.set(trigger.id, secret);
      recordChange(trigger, "created");
      return { trigger: view(trigger), ...(secret ? { secret } : {}) };
    },

    rotate: async (id, secret) => {
      const existing = await resolve(id);
      if (!existing) throw new Error("webhook_trigger_not_found");
      // Nothing to rotate when the source carries no shared secret; saying so
      // beats minting a key that would never verify anything.
      if (!getEventSource(existing.scheme).usesSecret) throw new Error("source_has_no_secret");
      const next = secret?.trim() || generateWebhookSecret();
      const rotated: WebhookTrigger = {
        ...existing,
        secretVersion: (existing.secretVersion ?? 1) + 1,
      };
      await persist(rotated, next);
      triggers.set(id, rotated);
      secrets.set(id, next);
      recordChange(rotated, "rotated");
      return { trigger: view(rotated), secret: next };
    },

    setEnabled: async (id, enabled) => {
      const existing = await resolve(id);
      if (!existing) throw new Error("webhook_trigger_not_found");
      const secret = secrets.get(id);
      if (!secret && getEventSource(existing.scheme).usesSecret) {
        throw new Error("webhook_secret_unreadable");
      }
      const updated: WebhookTrigger = { ...existing, enabled };
      await persist(updated, secret);
      triggers.set(id, updated);
      recordChange(updated, enabled ? "enabled" : "disabled");
      return view(updated);
    },

    remove: async (id) => {
      const existing = triggers.get(id);
      const existed = triggers.delete(id);
      secrets.delete(id);
      if (existing) {
        await store.remove(id);
        recordChange(existing, "removed");
      }
      return existed;
    },

    deliveries: async (limit = DELIVERY_LOG_LIMIT, triggerId) =>
      store.recentDeliveries(limit, triggerId),

    accept: async ({ triggerId, rawBody, header, contentLength }) => {
      const trigger = await resolve(triggerId);
      if (!trigger) return { ok: false, status: 404, error: "webhook_trigger_not_found" };

      const bytes = Buffer.byteLength(rawBody, "utf8");
      const cap = webhookMaxBodyBytes();
      if ((contentLength ?? bytes) > cap || bytes > cap) {
        return reject(triggerId, 413, "webhook_body_too_large", bytes);
      }

      const source = getEventSource(trigger.scheme);
      const secret = secrets.get(triggerId);
      if (source.usesSecret && !secret) {
        // The record survived a restart but its secret did not unseal. Verifying
        // is impossible, and accepting unverified would defeat the whole point.
        return reject(triggerId, 503, "webhook_secret_unreadable", bytes);
      }

      const ctx = { rawBody, header };
      const verified = await source.verify({
        ctx,
        secret,
        config: trigger.config,
        ...(opts.jwksFetcher ? { jwksFetcher: opts.jwksFetcher } : {}),
      });
      if (!verified.ok) {
        // A key set we could not reach is our outage, not the producer's bad
        // request — 503 tells them to retry, 401 tells them to stop.
        const status = verified.reason === "jwks_unavailable" ? 503 : 401;
        return reject(triggerId, status, `webhook_${verified.reason}`, bytes);
      }

      if (!trigger.enabled) return reject(triggerId, 403, "webhook_trigger_disabled", bytes);

      let body: unknown;
      try {
        body = JSON.parse(rawBody);
      } catch {
        return reject(triggerId, 400, "webhook_body_invalid", bytes);
      }

      // The payload a flow sees is not always the body: Pub/Sub wraps the real
      // message in base64 inside an envelope, and mapping against the envelope
      // would read nothing while looking like a mis-typed path.
      const payload = source.payload(ctx, body);
      if (payload === undefined) {
        return reject(triggerId, 400, "webhook_envelope_invalid", bytes);
      }

      const eventType = source.eventType(ctx, body);
      if (!eventSelected(trigger.events, eventType)) {
        // Verified and well-formed, just not subscribed. Logged so an operator
        // can see the hook is live and simply filtering, and answered 2xx so
        // GitHub does not mark the endpoint as failing and disable it.
        await store.logDelivery({
          triggerId,
          deliveryKey: rejectionKey(),
          result: "skipped",
          reason: `event_not_selected${eventType ? `: ${eventType}` : ""}`,
          runId: null,
          bytes,
        });
        return {
          ok: true,
          status: 200,
          skipped: "event_not_selected",
          ...(eventType ? { eventType } : {}),
        };
      }

      let def: FlowDefinition;
      try {
        def = await requireWebhookFlow(trigger.flowId);
      } catch (err) {
        const reason = err instanceof Error ? err.message : "flow_not_found";
        return reject(triggerId, reason === "flow_not_found" ? 404 : 400, reason, bytes);
      }

      // Reject rather than skip: a webhook producer retries, and a silent skip
      // would let a paused agent's events vanish with a 2xx on every one.
      const principal = trigger.principal ?? opts.runtime.defaultAgent;
      if (opts.runtime.isAgentPaused(principal)) {
        return reject(triggerId, 403, "webhook_principal_paused", bytes);
      }

      const deliveryKey = source.deliveryKey(ctx, body) ?? deliveryKeyFor(header);
      const claimed = await store.claimDelivery({
        triggerId,
        deliveryKey,
        bytes,
      });
      if (!claimed) return { ok: true, status: 200, duplicate: true, deliveryKey };

      const runId = `run-wh-${randomBytes(6).toString("hex")}`;
      const job: WebhookJob = {
        triggerId,
        deliveryKey,
        runId,
        input: mapWebhookInput(payload, trigger.input),
      };
      try {
        await opts.enqueue(job);
      } catch (err) {
        await store.settleDelivery({
          triggerId,
          deliveryKey,
          result: "run_failed",
          reason: "webhook_enqueue_failed",
        });
        throw err;
      }
      opts.runtime.recordAudit({
        type: "WebhookDelivery",
        at: new Date().toISOString(),
        payload: {
          triggerId,
          flowId: def.id,
          runId,
          deliveryKey,
          principal,
          bytes,
        },
      });
      return { ok: true, status: 202, runId, deliveryKey, job };
    },

    deliver: async (job) => {
      const trigger = await resolve(job.triggerId);
      if (!trigger) {
        await store.settleDelivery({
          triggerId: job.triggerId,
          deliveryKey: job.deliveryKey,
          result: "run_failed",
          reason: "webhook_trigger_not_found",
        });
        return null;
      }
      try {
        const result = await opts.flows.run({
          id: trigger.flowId,
          input: job.input,
          trigger: "webhook",
          runId: job.runId,
          // This worker may never have seen the flow: the queue hands a
          // delivery to whichever replica is free, and its boot-time map holds
          // only the flows that existed when it started.
          refresh: true,
          ...(trigger.principal ? { as: trigger.principal } : {}),
        });
        await store.settleDelivery({
          triggerId: job.triggerId,
          deliveryKey: job.deliveryKey,
          result: result.status === "error" ? "run_failed" : "run_started",
          reason: result.status === "error" ? "flow_run_error" : null,
          runId: result.runId,
        });
        return result;
      } catch (err) {
        const reason = err instanceof Error ? err.message : "flow_run_failed";
        await store.settleDelivery({
          triggerId: job.triggerId,
          deliveryKey: job.deliveryKey,
          result: "run_failed",
          reason,
          runId: job.runId,
        });
        console.error(`[@lacrew/orchestrator] webhook flow "${trigger.flowId}" failed:`, reason);
        return null;
      }
    },

    hydrate: async () => {
      for (const row of await store.list()) {
        if (!adopt(row)) {
          console.error(
            `[@lacrew/orchestrator] webhook trigger ${row.id} has unknown scheme "${row.scheme}"; skipped`,
          );
        }
      }
      await store.prune();
      return triggers.size;
    },

    storeName: store.name,
  };

  return surface;
}

/**
 * Recover a stored secret, or null when it cannot be read.
 *
 * Null leaves the trigger listed but unverifiable, which surfaces as a 503 on
 * delivery. Dropping the trigger instead would read as "never configured" and
 * invite an operator to create a second one, while the unreadable row stayed in
 * the database.
 */
function readSealed(triggerId: string, raw: string): string | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isSealedSecret(parsed)) return null;
    return unseal(parsed);
  } catch (err) {
    console.error(
      `[@lacrew/orchestrator] webhook secret for ${triggerId} could not be read:`,
      err instanceof Error ? err.message.split("\n")[0] : err,
    );
    return null;
  }
}
