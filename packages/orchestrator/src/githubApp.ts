/**
 * GitHub App credentials for connectors.
 *
 * A bearer token in an env var is a fine credential for a person. It is a poor
 * one for a crew: a personal access token carries whatever its owner can reach,
 * it is attributed to a human in every audit log GitHub keeps, and revoking it
 * takes away that person's own access too. A GitHub App installation is the
 * shape that actually fits — scoped to the repos it was installed on, its own
 * identity in GitHub's audit trail, revocable without touching a person.
 *
 * The cost is that an App credential is not a static string. What the operator
 * holds is an app id and an RSA private key; what the API wants is an
 * installation token that expires in an hour. Getting from one to the other is
 * two steps, and doing it on every call would be an extra round trip per
 * request against a rate limit:
 *
 * 1. Sign a short-lived RS256 JWT as the app itself (`iss` = app id).
 * 2. Exchange it at `/app/installations/{id}/access_tokens` for a token that
 *    carries the installation's permissions, and cache that until shortly
 *    before it expires.
 *
 * The private key never leaves this module, the installation token is never
 * logged, never audited, and never returned to a flow — a flow names a route
 * and the registry does the rest, which is the same guarantee bearer auth
 * already made.
 *
 * Clock skew is why the JWT is backdated 60s and why the cache refreshes five
 * minutes early: GitHub rejects a JWT whose `iat` is in its future, and a token
 * that expires mid-flight fails a call that had nothing wrong with it.
 */

import { createSign } from "node:crypto";

export type GithubAppAuth = {
  kind: "github-app";
  /** Env var holding the numeric app id. */
  appIdEnv: string;
  /** Env var holding the RSA private key PEM (literal `\n` accepted). */
  privateKeyEnv: string;
  /** Env var holding the installation id the token is minted for. */
  installationIdEnv: string;
};

export type GithubAppEnv = Record<string, string | undefined>;

/** GitHub rejects a JWT older than 10 minutes; nine leaves room for skew. */
const JWT_LIFETIME_S = 9 * 60;
const JWT_BACKDATE_S = 60;
/** Re-mint this long before expiry so a call never rides a dying token. */
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

function base64url(input: string | Buffer): string {
  return Buffer.from(input).toString("base64url");
}

/**
 * Accept the shapes a private key survives an environment variable in: a real
 * PEM, one whose newlines were escaped by a shell or a secrets manager, or a
 * base64 blob of either. Rejecting the escaped form would be a footgun nobody
 * debugs quickly — it looks right in the dashboard it was pasted into.
 */
export function normalizePrivateKey(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.includes("-----BEGIN")) {
    return trimmed.replace(/\\n/g, "\n").trim();
  }
  const decoded = Buffer.from(trimmed, "base64").toString("utf8");
  if (decoded.includes("-----BEGIN")) return decoded.trim();
  throw new Error("github_app_private_key_unreadable");
}

/** RS256 JWT signed as the app. Short-lived by design; never cached. */
export function signAppJwt(appId: string, privateKeyPem: string, nowMs: number): string {
  const iat = Math.floor(nowMs / 1000) - JWT_BACKDATE_S;
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(
    JSON.stringify({ iat, exp: iat + JWT_BACKDATE_S + JWT_LIFETIME_S, iss: appId }),
  );
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  let signature: string;
  try {
    signature = signer.sign(privateKeyPem, "base64url");
  } catch {
    // The key is wrong, not the request. Saying so plainly beats a 401 from
    // GitHub that reads as "the app is not installed".
    throw new Error("github_app_private_key_invalid");
  }
  return `${header}.${payload}.${signature}`;
}

type CacheEntry = { token: string; expiresAtMs: number };

export type GithubAppTokenSource = {
  /**
   * Installation token for a connector, from cache when one is live. `baseUrl`
   * is the connector's own, so a GitHub Enterprise install mints against its
   * host rather than github.com.
   */
  get(args: {
    cacheKey: string;
    baseUrl: string;
    auth: GithubAppAuth;
    env: GithubAppEnv;
  }): Promise<string>;
  /** Drop a cached token so the next call re-mints. Used after a 401. */
  invalidate(cacheKey: string): void;
  /**
   * What a status surface may report: whether a token is held and until when.
   * Never the token, and never the key it was minted from.
   */
  status(cacheKey: string): { cached: boolean; expiresAt: string | null };
};

export function createGithubAppTokenSource(opts: {
  fetchImpl?: typeof fetch;
  now?: () => number;
}): GithubAppTokenSource {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ?? Date.now;
  const cache = new Map<string, CacheEntry>();
  // Concurrent calls on a cold cache would otherwise each mint a token, and
  // GitHub invalidates nothing — they would simply burn rate limit and race.
  const inFlight = new Map<string, Promise<string>>();

  async function mint(args: {
    baseUrl: string;
    auth: GithubAppAuth;
    env: GithubAppEnv;
  }): Promise<CacheEntry> {
    const appId = args.env[args.auth.appIdEnv]?.trim();
    const keyRaw = args.env[args.auth.privateKeyEnv]?.trim();
    const installationId = args.env[args.auth.installationIdEnv]?.trim();
    if (!appId) throw new Error(`connector_missing_credential:${args.auth.appIdEnv}`);
    if (!keyRaw) throw new Error(`connector_missing_credential:${args.auth.privateKeyEnv}`);
    if (!installationId) {
      throw new Error(`connector_missing_credential:${args.auth.installationIdEnv}`);
    }

    const jwt = signAppJwt(appId, normalizePrivateKey(keyRaw), now());
    const url = `${args.baseUrl.replace(/\/$/, "")}/app/installations/${encodeURIComponent(installationId)}/access_tokens`;
    const res = await fetchImpl(url, {
      method: "POST",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${jwt}`,
        "x-github-api-version": "2022-11-28",
      },
      redirect: "manual",
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) {
      // The status is the whole diagnosis here — 401 is a bad key or app id,
      // 404 is an installation the app cannot see. The body may quote the JWT
      // back, so it is deliberately not included.
      throw new Error(`github_app_token_exchange_failed:${res.status}`);
    }
    const body = (await res.json()) as { token?: string; expires_at?: string };
    if (!body.token) throw new Error("github_app_token_exchange_malformed");
    const expiresAtMs = body.expires_at ? Date.parse(body.expires_at) : NaN;
    return {
      token: body.token,
      // An unparseable expiry is treated as one hour, GitHub's documented life
      // for these. Treating it as forever is how a crew dies quietly at 61
      // minutes.
      expiresAtMs: Number.isFinite(expiresAtMs) ? expiresAtMs : now() + 60 * 60 * 1000,
    };
  }

  return {
    async get({ cacheKey, baseUrl, auth, env }) {
      const hit = cache.get(cacheKey);
      if (hit && hit.expiresAtMs - REFRESH_MARGIN_MS > now()) return hit.token;

      const pending = inFlight.get(cacheKey);
      if (pending) return pending;

      const task = mint({ baseUrl, auth, env })
        .then((entry) => {
          cache.set(cacheKey, entry);
          return entry.token;
        })
        .finally(() => {
          inFlight.delete(cacheKey);
        });
      inFlight.set(cacheKey, task);
      return task;
    },
    invalidate(cacheKey) {
      cache.delete(cacheKey);
    },
    status(cacheKey) {
      const hit = cache.get(cacheKey);
      if (!hit) return { cached: false, expiresAt: null };
      return { cached: true, expiresAt: new Date(hit.expiresAtMs).toISOString() };
    },
  };
}
