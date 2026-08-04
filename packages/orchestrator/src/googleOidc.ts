/**
 * Google OIDC verification for Pub/Sub push deliveries (F2.22).
 *
 * Pub/Sub push does not sign the body. It authenticates the *sender*: Google
 * puts a short-lived OIDC token in `Authorization: Bearer`, signed by Google's
 * own keys, naming the service account that owns the subscription and the
 * audience the subscription was configured with. So unlike the HMAC schemes,
 * there is no shared secret here — the trigger stores which audience and which
 * service account it will accept, and the proof is Google's signature.
 *
 * That difference matters for what the check must be strict about. An OIDC
 * token that verifies only "Google signed this" is nearly worthless: *anyone*
 * can make Google mint a token for their own service account and point their
 * own subscription at someone else's URL. The binding that makes this safe is
 * `aud` plus `email` — the audience the operator chose and the service account
 * they expect — so both are required, and a trigger cannot be created without
 * them.
 *
 * Keys come from Google's JWKS endpoint, cached with a TTL. An unknown `kid`
 * refetches at most once per cooldown: Google rotates keys, so a hard failure
 * on an unseen kid would break deliveries for a whole TTL, while refetching per
 * request would let an attacker drive unbounded outbound fetches with garbage
 * tokens.
 */

import { createPublicKey, createVerify, timingSafeEqual } from "node:crypto";

/**
 * A JWKS entry. Structural rather than `crypto.JsonWebKey` so this module does
 * not depend on which @types/node revision exports that name.
 */
export type Jwk = Record<string, unknown> & { kid?: string };

export const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const GOOGLE_ISSUERS = new Set(["https://accounts.google.com", "accounts.google.com"]);

/** How long a fetched key set is trusted before a refresh. */
const JWKS_TTL_MS = 3_600_000;
/** Floor between refetches triggered by an unknown `kid`. */
const JWKS_REFETCH_COOLDOWN_MS = 60_000;
/** Clock skew allowed on `exp` / `iat`. */
const CLOCK_SKEW_SEC = 60;

export type GoogleOidcFailure =
  | "token_missing"
  | "token_malformed"
  | "token_unsupported_alg"
  | "token_key_unknown"
  | "token_signature_invalid"
  | "token_expired"
  | "token_issuer_invalid"
  | "token_audience_invalid"
  | "token_email_invalid"
  | "jwks_unavailable";

export type GoogleOidcCheck =
  { ok: true; claims: GoogleOidcClaims } | { ok: false; reason: GoogleOidcFailure };

export type GoogleOidcClaims = {
  iss: string;
  aud: string;
  email?: string;
  email_verified?: boolean;
  exp: number;
  iat?: number;
  sub?: string;
};

/** Injectable so tests drive a local key set instead of Google's endpoint. */
export type JwksFetcher = (url: string) => Promise<{ keys: Jwk[] }>;

const defaultFetcher: JwksFetcher = async (url) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(5_000) });
  if (!res.ok) throw new Error(`jwks_http_${res.status}`);
  return (await res.json()) as { keys: Jwk[] };
};

type CacheEntry = { keys: Map<string, Jwk>; fetchedAt: number; lastAttemptAt: number };

/**
 * Key cache. Module-level rather than per-trigger: the keys are Google's, not
 * any one trigger's, so a fleet of triggers should share one refresh.
 */
const cache = new Map<string, CacheEntry>();

/** Drop cached key sets — tests only, so one case cannot poison the next. */
export function resetGoogleJwksCache(): void {
  cache.clear();
}

function indexKeys(keys: Jwk[]): Map<string, Jwk> {
  const out = new Map<string, Jwk>();
  for (const key of keys) {
    const kid = key.kid;
    if (kid) out.set(kid, key);
  }
  return out;
}

async function keyFor(
  kid: string,
  url: string,
  fetcher: JwksFetcher,
  nowMs: number,
): Promise<Jwk | null | "unavailable"> {
  const entry = cache.get(url);
  const fresh = entry !== undefined && nowMs - entry.fetchedAt < JWKS_TTL_MS;
  if (fresh && entry.keys.has(kid)) return entry.keys.get(kid)!;

  // Nothing usable cached for this kid. Refetch — unless we just tried, so an
  // attacker sending random kids cannot turn this into an outbound amplifier.
  if (entry !== undefined && nowMs - entry.lastAttemptAt < JWKS_REFETCH_COOLDOWN_MS) {
    const stale = entry.keys.get(kid);
    if (stale) return stale;
    // A current key set that simply lacks this kid is a real answer; a set we
    // could not refresh is not, and the two must not report the same way.
    return fresh ? null : "unavailable";
  }

  try {
    const fetched = await fetcher(url);
    const keys = indexKeys(fetched.keys ?? []);
    cache.set(url, { keys, fetchedAt: nowMs, lastAttemptAt: nowMs });
    return keys.get(kid) ?? null;
  } catch {
    if (entry) {
      entry.lastAttemptAt = nowMs;
      // Serve a stale key rather than failing closed on a transient JWKS blip:
      // the signature check itself is unchanged, and a key Google published an
      // hour ago is not less genuine because the endpoint is briefly down.
      const stale = entry.keys.get(kid);
      if (stale) return stale;
    } else {
      cache.set(url, { keys: new Map(), fetchedAt: 0, lastAttemptAt: nowMs });
    }
    return "unavailable";
  }
}

function decodeSegment(segment: string): unknown {
  return JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
}

/** Constant-time string compare for the audience / email bindings. */
function equals(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  if (x.length !== y.length) return false;
  return timingSafeEqual(x, y);
}

export async function verifyGoogleOidcToken(input: {
  /** Raw `Authorization` header value, or the bare token. */
  authorization: string | undefined;
  /** Audience the Pub/Sub subscription was configured with. Required. */
  audience: string;
  /** Service account email that owns the subscription. Required. */
  serviceAccountEmail: string;
  nowMs?: number;
  jwksUrl?: string;
  fetcher?: JwksFetcher;
}): Promise<GoogleOidcCheck> {
  const bearer = /^Bearer\s+(.+)$/i.exec(input.authorization?.trim() ?? "");
  const token = (bearer?.[1] ?? input.authorization ?? "").trim();
  if (!token) return { ok: false, reason: "token_missing" };

  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "token_malformed" };
  const [headerB64, payloadB64, signatureB64] = parts as [string, string, string];

  let header: { alg?: string; kid?: string };
  let claims: GoogleOidcClaims;
  try {
    header = decodeSegment(headerB64) as { alg?: string; kid?: string };
    claims = decodeSegment(payloadB64) as GoogleOidcClaims;
  } catch {
    return { ok: false, reason: "token_malformed" };
  }
  // Pinned rather than read from the token: honoring the token's own `alg` is
  // how "alg: none" and HMAC-with-the-public-key forgeries get in.
  if (header.alg !== "RS256") return { ok: false, reason: "token_unsupported_alg" };
  if (!header.kid) return { ok: false, reason: "token_key_unknown" };

  const nowMs = input.nowMs ?? Date.now();
  const url = input.jwksUrl ?? GOOGLE_JWKS_URL;
  const jwk = await keyFor(header.kid, url, input.fetcher ?? defaultFetcher, nowMs);
  if (jwk === "unavailable") return { ok: false, reason: "jwks_unavailable" };
  if (!jwk) return { ok: false, reason: "token_key_unknown" };

  let verified = false;
  try {
    const verifier = createVerify("RSA-SHA256");
    verifier.update(`${headerB64}.${payloadB64}`);
    verifier.end();
    verified = verifier.verify(
      // The JWK shape is validated by createPublicKey itself, which throws on a
      // malformed key and is caught below as an unverifiable signature.
      createPublicKey({ key: jwk, format: "jwk" } as Parameters<typeof createPublicKey>[0]),
      Buffer.from(signatureB64, "base64url"),
    );
  } catch {
    verified = false;
  }
  if (!verified) return { ok: false, reason: "token_signature_invalid" };

  // Claims are only checked after the signature: an unverified token's claims
  // are attacker-controlled, and answering "wrong audience" to one would tell a
  // prober which audience to forge next.
  const nowSec = Math.floor(nowMs / 1000);
  if (!Number.isFinite(claims.exp) || nowSec > claims.exp + CLOCK_SKEW_SEC) {
    return { ok: false, reason: "token_expired" };
  }
  if (claims.iat !== undefined && nowSec + CLOCK_SKEW_SEC < claims.iat) {
    return { ok: false, reason: "token_expired" };
  }
  if (!GOOGLE_ISSUERS.has(claims.iss)) return { ok: false, reason: "token_issuer_invalid" };
  if (typeof claims.aud !== "string" || !equals(claims.aud, input.audience)) {
    return { ok: false, reason: "token_audience_invalid" };
  }
  if (
    typeof claims.email !== "string" ||
    !equals(claims.email, input.serviceAccountEmail) ||
    claims.email_verified !== true
  ) {
    return { ok: false, reason: "token_email_invalid" };
  }
  return { ok: true, claims };
}
