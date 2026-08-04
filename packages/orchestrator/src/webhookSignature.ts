/**
 * HMAC verification for inbound webhook deliveries (F2.22).
 *
 * A hook URL is a capability to start a funded flow, so the path segment alone
 * is never enough — every delivery carries a signature over the *raw* body.
 * Parsing before verifying would let an unauthenticated request pick which
 * JSON parser branch runs, so callers must hand the exact bytes they received.
 *
 * Two schemes, because the product needs both a first-party path and one that a
 * provider already speaks:
 *
 *   - `lacrew` — `X-Lacrew-Signature: sha256=<hex>` over `<timestamp>.<body>`
 *     with `X-Lacrew-Timestamp` (unix seconds). The timestamp is inside the
 *     signed material, so a captured delivery cannot be replayed past the
 *     tolerance window even against a fresh idempotency ledger.
 *   - `github` — `X-Hub-Signature-256: sha256=<hex>` over the body alone, which
 *     is what GitHub sends. It has no timestamp, so replay defence there rests
 *     entirely on `X-GitHub-Delivery` idempotency; that is a property of the
 *     producer, not something this scheme can assert.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const WEBHOOK_SCHEMES = ["lacrew", "github"] as const;
export type WebhookScheme = (typeof WEBHOOK_SCHEMES)[number];

/** Header carrying the signature, per scheme. */
export const SIGNATURE_HEADER: Record<WebhookScheme, string> = {
  lacrew: "x-lacrew-signature",
  github: "x-hub-signature-256",
};

export const TIMESTAMP_HEADER = "x-lacrew-timestamp";

/** How far a signed timestamp may drift before the delivery is refused. */
const DEFAULT_TOLERANCE_SEC = 300;

export type SignatureFailure =
  | "signature_missing"
  | "signature_malformed"
  | "signature_invalid"
  | "timestamp_missing"
  | "timestamp_stale";

export type SignatureCheck = { ok: true } | { ok: false; reason: SignatureFailure };

export function isWebhookScheme(value: unknown): value is WebhookScheme {
  return typeof value === "string" && (WEBHOOK_SCHEMES as readonly string[]).includes(value);
}

/** A fresh signing secret. 32 bytes of base64url — URL-safe and copy-pasteable. */
export function generateWebhookSecret(): string {
  return randomBytes(32).toString("base64url");
}

export function webhookToleranceSec(): number {
  const raw = Number(process.env.LACREW_WEBHOOK_TOLERANCE_SEC ?? 0);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TOLERANCE_SEC;
}

function hmacHex(secret: string, material: string): string {
  return createHmac("sha256", secret).update(material, "utf8").digest("hex");
}

/** Signature a `lacrew`-scheme producer must send. Exported for docs + tests. */
export function signLacrewDelivery(secret: string, timestampSec: number, rawBody: string): string {
  return `sha256=${hmacHex(secret, `${timestampSec}.${rawBody}`)}`;
}

/** Signature a `github`-scheme producer sends (body only). */
export function signGithubDelivery(secret: string, rawBody: string): string {
  return `sha256=${hmacHex(secret, rawBody)}`;
}

/**
 * Compare digests without leaking their contents through timing.
 *
 * A length mismatch short-circuits because `timingSafeEqual` throws on unequal
 * buffers — and a wrong *length* is not a secret worth protecting, only the
 * bytes are.
 */
function digestsMatch(presented: string, expected: string): boolean {
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Split `sha256=<hex>` into its digest, or null when the shape is wrong. */
function digestOf(header: string): string | null {
  const match = /^sha256=([0-9a-f]{64})$/i.exec(header.trim());
  return match?.[1] ? match[1].toLowerCase() : null;
}

export function verifyWebhookSignature(input: {
  scheme: WebhookScheme;
  secret: string;
  /** The exact bytes received, as text. Never a re-serialized object. */
  rawBody: string;
  header: (name: string) => string | undefined;
  nowMs?: number;
  toleranceSec?: number;
}): SignatureCheck {
  const presented = input.header(SIGNATURE_HEADER[input.scheme]);
  if (!presented?.trim()) return { ok: false, reason: "signature_missing" };
  const digest = digestOf(presented);
  if (!digest) return { ok: false, reason: "signature_malformed" };

  if (input.scheme === "github") {
    const expected = digestOf(signGithubDelivery(input.secret, input.rawBody))!;
    return digestsMatch(digest, expected)
      ? { ok: true }
      : { ok: false, reason: "signature_invalid" };
  }

  const rawTs = input.header(TIMESTAMP_HEADER)?.trim();
  if (!rawTs) return { ok: false, reason: "timestamp_missing" };
  const ts = Number(rawTs);
  if (!Number.isFinite(ts) || !Number.isInteger(ts)) {
    return { ok: false, reason: "timestamp_missing" };
  }

  // Verify the signature before judging the clock: answering "stale" to an
  // unsigned request would turn the endpoint into a clock oracle.
  const expected = digestOf(signLacrewDelivery(input.secret, ts, input.rawBody))!;
  if (!digestsMatch(digest, expected)) return { ok: false, reason: "signature_invalid" };

  const nowSec = Math.floor((input.nowMs ?? Date.now()) / 1000);
  const tolerance = input.toleranceSec ?? webhookToleranceSec();
  // Absolute drift: a timestamp from the future is as suspect as an old one,
  // and a producer with a fast clock should learn that from the response.
  if (Math.abs(nowSec - ts) > tolerance) return { ok: false, reason: "timestamp_stale" };
  return { ok: true };
}
