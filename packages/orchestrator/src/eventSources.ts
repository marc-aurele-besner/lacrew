/**
 * Event sources for webhook flow triggers (F2.22).
 *
 * A source answers four questions about an inbound delivery, and the reason
 * they live together is that every provider answers all four differently:
 *
 *   1. **Is it genuine?** — HMAC over the raw bytes for `lacrew` / `github`, a
 *      Google-signed OIDC token for `google-pubsub`. Some sources hold a shared
 *      secret; some hold no secret at all and bind to an audience instead.
 *   2. **Which delivery is it?** — the idempotency key. Producers already mint
 *      one (`X-GitHub-Delivery`, Pub/Sub `messageId`); inventing our own would
 *      make their retries look like new events.
 *   3. **What happened?** — the event type, so a trigger can subscribe to
 *      `pull_request` and ignore the other forty things GitHub sends.
 *   4. **What is the payload?** — not always the body. Pub/Sub wraps the real
 *      message in base64 inside an envelope, and a flow mapping
 *      `pull_request.title` against that envelope would silently read nothing.
 *
 * Adding a provider means adding one entry here, not touching the delivery
 * path — which is the whole point of the seam.
 */

import { verifyGoogleOidcToken, type JwksFetcher } from "./googleOidc.js";
import {
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  verifyWebhookSignature,
  type WebhookScheme,
} from "./webhookSignature.js";

export const EVENT_SOURCES = ["lacrew", "github", "google-pubsub"] as const;
export type EventSourceId = (typeof EVENT_SOURCES)[number];

export function isEventSource(value: unknown): value is EventSourceId {
  return typeof value === "string" && (EVENT_SOURCES as readonly string[]).includes(value);
}

/** Per-source settings an operator supplies at registration. Never a secret. */
export type EventSourceConfig = {
  /** google-pubsub: the audience the push subscription was configured with. */
  audience?: string;
  /** google-pubsub: the service account email that owns the subscription. */
  serviceAccountEmail?: string;
};

export type DeliveryContext = {
  /** The exact bytes received, as text. Never a re-serialized object. */
  rawBody: string;
  header: (name: string) => string | undefined;
  nowMs?: number;
};

export type SourceVerification = { ok: true } | { ok: false; reason: string };

export type EventSource = {
  id: EventSourceId;
  /** Human label for pickers and docs. */
  title: string;
  /** Whether registration mints a shared signing secret for this source. */
  usesSecret: boolean;
  /** Config keys that must be present before a trigger can be created. */
  requiredConfig: Array<keyof EventSourceConfig>;
  verify(input: {
    ctx: DeliveryContext;
    secret: string | undefined;
    config: EventSourceConfig | undefined;
    /** Test seam for the Google key set; unused by HMAC sources. */
    jwksFetcher?: JwksFetcher;
  }): Promise<SourceVerification>;
  /** Producer-minted delivery id, when the provider sends one. */
  deliveryKey(ctx: DeliveryContext, body: unknown): string | undefined;
  /** Event name a trigger's `events` filter is matched against. */
  eventType(ctx: DeliveryContext, body: unknown): string | undefined;
  /**
   * The payload a flow's input mapping should see. Returns `undefined` when the
   * envelope is malformed, which the caller reports as a bad body rather than
   * mapping against nothing.
   */
  payload(ctx: DeliveryContext, body: unknown): unknown;
};

function hmacSource(id: WebhookScheme, title: string, deliveryHeader?: string): EventSource {
  return {
    id,
    title,
    usesSecret: true,
    requiredConfig: [],
    verify: async ({ ctx, secret }) => {
      if (!secret) return { ok: false, reason: "secret_unreadable" };
      const check = verifyWebhookSignature({
        scheme: id,
        secret,
        rawBody: ctx.rawBody,
        header: ctx.header,
        ...(ctx.nowMs !== undefined ? { nowMs: ctx.nowMs } : {}),
      });
      return check.ok ? { ok: true } : { ok: false, reason: check.reason };
    },
    deliveryKey: (ctx) =>
      deliveryHeader ? ctx.header(deliveryHeader)?.trim() || undefined : undefined,
    eventType: (ctx, body) => {
      if (id !== "github") return undefined;
      const event = ctx.header("x-github-event")?.trim();
      if (!event) return undefined;
      // GitHub splits the event across a header and the body: the header says
      // `pull_request`, the body says which action. Composing them is what lets
      // a trigger subscribe to `pull_request.opened` and ignore the rest.
      const action =
        body && typeof body === "object" ? (body as { action?: unknown }).action : undefined;
      return typeof action === "string" && action ? `${event}.${action}` : event;
    },
    payload: (_ctx, body) => body,
  };
}

/**
 * A Pub/Sub push envelope. `data` is base64 and usually JSON, but a topic can
 * carry anything, so a non-JSON payload is surfaced as the decoded string
 * rather than rejected — the flow may well want the raw text.
 */
type PubsubEnvelope = {
  message?: {
    data?: string;
    messageId?: string;
    message_id?: string;
    attributes?: Record<string, string>;
    publishTime?: string;
  };
  subscription?: string;
};

function pubsubMessage(body: unknown): PubsubEnvelope["message"] | undefined {
  if (!body || typeof body !== "object") return undefined;
  const message = (body as PubsubEnvelope).message;
  return message && typeof message === "object" ? message : undefined;
}

const googlePubsubSource: EventSource = {
  id: "google-pubsub",
  title: "Google Pub/Sub push",
  // No shared secret: Google signs the sender, and the trigger binds to the
  // audience + service account it will accept instead.
  usesSecret: false,
  requiredConfig: ["audience", "serviceAccountEmail"],
  verify: async ({ ctx, config, jwksFetcher }) => {
    if (!config?.audience || !config.serviceAccountEmail) {
      return { ok: false, reason: "source_config_missing" };
    }
    const check = await verifyGoogleOidcToken({
      authorization: ctx.header("authorization"),
      audience: config.audience,
      serviceAccountEmail: config.serviceAccountEmail,
      ...(ctx.nowMs !== undefined ? { nowMs: ctx.nowMs } : {}),
      ...(jwksFetcher ? { fetcher: jwksFetcher } : {}),
    });
    return check.ok ? { ok: true } : { ok: false, reason: check.reason };
  },
  deliveryKey: (_ctx, body) => {
    const message = pubsubMessage(body);
    return message?.messageId ?? message?.message_id ?? undefined;
  },
  eventType: (_ctx, body) => {
    // Gmail and Calendar watches put the event kind in attributes; a bare topic
    // may send none, in which case the trigger's filter simply cannot apply.
    const attrs = pubsubMessage(body)?.attributes;
    return attrs?.eventType ?? attrs?.event_type ?? undefined;
  },
  payload: (_ctx, body) => {
    const message = pubsubMessage(body);
    if (!message) return undefined;
    if (message.data === undefined) return { ...message };
    let decoded: string;
    try {
      decoded = Buffer.from(message.data, "base64").toString("utf8");
    } catch {
      return undefined;
    }
    try {
      return JSON.parse(decoded);
    } catch {
      // Not JSON — hand the flow the text, with the envelope's metadata beside
      // it so a mapping can still reach messageId / attributes.
      return { text: decoded, attributes: message.attributes ?? {} };
    }
  },
};

const SOURCES: Record<EventSourceId, EventSource> = {
  lacrew: hmacSource("lacrew", "LaCrew signed webhook", "x-lacrew-delivery"),
  github: hmacSource("github", "GitHub webhook", "x-github-delivery"),
  "google-pubsub": googlePubsubSource,
};

export function getEventSource(id: EventSourceId): EventSource {
  return SOURCES[id];
}

/** Catalog for pickers and docs — never includes secrets or config values. */
export function describeEventSources(): Array<{
  id: EventSourceId;
  title: string;
  usesSecret: boolean;
  requiredConfig: string[];
  signatureHeader?: string;
  timestampHeader?: string;
}> {
  return EVENT_SOURCES.map((id) => {
    const source = SOURCES[id];
    return {
      id,
      title: source.title,
      usesSecret: source.usesSecret,
      requiredConfig: [...source.requiredConfig],
      ...(id === "lacrew" || id === "github" ? { signatureHeader: SIGNATURE_HEADER[id] } : {}),
      ...(id === "lacrew" ? { timestampHeader: TIMESTAMP_HEADER } : {}),
    };
  });
}

/**
 * Whether a delivery's event type passes the trigger's filter.
 *
 * An empty filter means everything. A delivery whose type the provider did not
 * declare passes too: refusing it would silently drop events from a topic that
 * simply does not label them, and "I could not tell" is not "you did not ask
 * for this".
 *
 * GitHub-style dotted subtypes match on the prefix, so `pull_request` selects
 * `pull_request.opened` without the operator enumerating every action.
 */
export function eventSelected(
  filter: string[] | undefined,
  eventType: string | undefined,
): boolean {
  if (!filter || filter.length === 0) return true;
  if (!eventType) return true;
  // Prefix only, never the reverse: a filter for `pull_request.opened` must not
  // be satisfied by a delivery that is merely `pull_request`.
  return filter.some((want) => want === eventType || eventType.startsWith(`${want}.`));
}
