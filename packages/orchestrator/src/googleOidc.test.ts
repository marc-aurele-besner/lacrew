import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createSign, generateKeyPairSync, type KeyObject } from "node:crypto";
import {
  resetGoogleJwksCache,
  verifyGoogleOidcToken,
  type Jwk,
  type JwksFetcher,
} from "./googleOidc.js";

/**
 * A throwaway RSA key per run, exported as a JWKS the verifier can fetch. This
 * exercises the genuine RS256 path — real key generation, real signing, real
 * verification — without a credential in the repo or a call to Google.
 */
function makeSigner(kid: string): { jwk: Jwk; sign: (header: object, claims: object) => string } {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: "jwk" }), kid, alg: "RS256", use: "sig" } as Jwk;
  return {
    jwk,
    sign: (header, claims) => {
      const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
      const signingInput = `${b64(header)}.${b64(claims)}`;
      const signer = createSign("RSA-SHA256");
      signer.update(signingInput);
      signer.end();
      return `${signingInput}.${signer.sign(privateKey as KeyObject).toString("base64url")}`;
    },
  };
}

const AUD = "https://orch.example.com/hooks/wht_abc";
const SA = "pubsub-pusher@my-project.iam.gserviceaccount.com";
const NOW_MS = 1_800_000_000_000;
const NOW_SEC = Math.floor(NOW_MS / 1000);
const JWKS_URL = "https://jwks.test/certs";

const signer = makeSigner("kid-1");

function jwks(...keys: Jwk[]): JwksFetcher {
  return async () => ({ keys });
}

function token(overrides: Partial<Record<string, unknown>> = {}, header: object = {}): string {
  return signer.sign(
    { alg: "RS256", kid: "kid-1", typ: "JWT", ...header },
    {
      iss: "https://accounts.google.com",
      aud: AUD,
      email: SA,
      email_verified: true,
      exp: NOW_SEC + 600,
      iat: NOW_SEC,
      sub: "1234567890",
      ...overrides,
    },
  );
}

function verify(authorization: string | undefined, fetcher = jwks(signer.jwk), nowMs = NOW_MS) {
  return verifyGoogleOidcToken({
    authorization,
    audience: AUD,
    serviceAccountEmail: SA,
    nowMs,
    jwksUrl: JWKS_URL,
    fetcher,
  });
}

describe("google pub/sub OIDC verification", () => {
  beforeEach(() => resetGoogleJwksCache());

  it("accepts a token Google signed for the right audience and service account", async () => {
    const check = await verify(`Bearer ${token()}`);
    assert.equal(check.ok, true);
    assert.equal(check.ok && check.claims.email, SA);
  });

  it("accepts a bare token as well as a Bearer header", async () => {
    assert.equal((await verify(token())).ok, true);
  });

  it("refuses a token signed by someone else's key", async () => {
    // Same kid, different key: the JWKS says which key is Google's, and only
    // that one may verify.
    const impostor = makeSigner("kid-1");
    const forged = impostor.sign(
      { alg: "RS256", kid: "kid-1", typ: "JWT" },
      {
        iss: "https://accounts.google.com",
        aud: AUD,
        email: SA,
        email_verified: true,
        exp: NOW_SEC + 600,
      },
    );
    assert.deepEqual(await verify(`Bearer ${forged}`), {
      ok: false,
      reason: "token_signature_invalid",
    });
  });

  it("refuses a tampered payload", async () => {
    const [h, , s] = token().split(".") as [string, string, string];
    const swapped = Buffer.from(
      JSON.stringify({
        iss: "https://accounts.google.com",
        aud: AUD,
        email: SA,
        email_verified: true,
        exp: NOW_SEC + 600,
      }),
    ).toString("base64url");
    assert.deepEqual(await verify(`Bearer ${h}.${swapped}.${s}`), {
      ok: false,
      reason: "token_signature_invalid",
    });
  });

  it("refuses alg none and any non-RS256 algorithm", async () => {
    // The classic forgery: claim an algorithm the verifier might honor from the
    // token itself. The algorithm is pinned, so this never reaches a key.
    const none = `${Buffer.from(JSON.stringify({ alg: "none", kid: "kid-1" })).toString("base64url")}.${Buffer.from(JSON.stringify({ aud: AUD })).toString("base64url")}.`;
    assert.deepEqual(await verify(`Bearer ${none}`), {
      ok: false,
      reason: "token_unsupported_alg",
    });
    assert.deepEqual(await verify(`Bearer ${token({}, { alg: "HS256" })}`), {
      ok: false,
      reason: "token_unsupported_alg",
    });
  });

  it("refuses a token minted for a different audience", async () => {
    // The binding that matters: anyone can get Google to sign a token, so a
    // valid signature alone must never be enough.
    assert.deepEqual(await verify(`Bearer ${token({ aud: "https://someone-else.example" })}`), {
      ok: false,
      reason: "token_audience_invalid",
    });
  });

  it("refuses a token from another service account, or an unverified email", async () => {
    assert.deepEqual(
      await verify(`Bearer ${token({ email: "attacker@evil.iam.gserviceaccount.com" })}`),
      {
        ok: false,
        reason: "token_email_invalid",
      },
    );
    assert.deepEqual(await verify(`Bearer ${token({ email_verified: false })}`), {
      ok: false,
      reason: "token_email_invalid",
    });
  });

  it("refuses an expired token and one issued in the future", async () => {
    assert.deepEqual(await verify(`Bearer ${token({ exp: NOW_SEC - 3600 })}`), {
      ok: false,
      reason: "token_expired",
    });
    assert.deepEqual(await verify(`Bearer ${token({ iat: NOW_SEC + 3600 })}`), {
      ok: false,
      reason: "token_expired",
    });
  });

  it("allows small clock skew rather than failing on the second", async () => {
    assert.equal((await verify(`Bearer ${token({ exp: NOW_SEC - 30 })}`)).ok, true);
  });

  it("refuses a foreign issuer", async () => {
    assert.deepEqual(await verify(`Bearer ${token({ iss: "https://accounts.evil.example" })}`), {
      ok: false,
      reason: "token_issuer_invalid",
    });
  });

  it("reports a missing or malformed token distinctly", async () => {
    assert.deepEqual(await verify(undefined), { ok: false, reason: "token_missing" });
    assert.deepEqual(await verify("Bearer not-a-jwt"), { ok: false, reason: "token_malformed" });
    assert.deepEqual(await verify("Bearer a.b.c"), { ok: false, reason: "token_malformed" });
  });

  it("distinguishes an unknown key from an unreachable key set", async () => {
    // A current key set that lacks the kid is a real answer (401-class); a set
    // we could not fetch is our outage (503-class), and the caller maps them to
    // different statuses so a producer knows whether retrying can help.
    const other = makeSigner("kid-2");
    assert.deepEqual(await verify(`Bearer ${token()}`, jwks(other.jwk)), {
      ok: false,
      reason: "token_key_unknown",
    });

    // A fresh cache: otherwise the key set fetched above is still current, the
    // cooldown keeps the failing fetcher from ever being called, and this would
    // assert nothing about the outage path.
    resetGoogleJwksCache();
    assert.deepEqual(
      await verify(`Bearer ${token()}`, async () => {
        throw new Error("network down");
      }),
      { ok: false, reason: "jwks_unavailable" },
    );
  });

  it("caches the key set instead of fetching per delivery", async () => {
    let fetches = 0;
    const counting: JwksFetcher = async () => {
      fetches += 1;
      return { keys: [signer.jwk] };
    };
    for (let i = 0; i < 5; i++) {
      assert.equal((await verify(`Bearer ${token()}`, counting)).ok, true);
    }
    assert.equal(fetches, 1, "a cached key set must serve repeat deliveries");
  });

  it("does not refetch per garbage kid, so a prober cannot amplify outbound requests", async () => {
    let fetches = 0;
    const counting: JwksFetcher = async () => {
      fetches += 1;
      return { keys: [signer.jwk] };
    };
    await verify(`Bearer ${token()}`, counting);
    for (let i = 0; i < 10; i++) {
      const junk = makeSigner(`unknown-${i}`);
      const t = junk.sign({ alg: "RS256", kid: `unknown-${i}` }, { aud: AUD, exp: NOW_SEC + 60 });
      assert.equal((await verify(`Bearer ${t}`, counting)).ok, false);
    }
    assert.equal(fetches, 1, "unknown kids must not each trigger a fetch");
  });

  it("serves a cached key through a transient JWKS outage", async () => {
    let calls = 0;
    const flaky: JwksFetcher = async () => {
      calls += 1;
      if (calls > 1) throw new Error("jwks down");
      return { keys: [signer.jwk] };
    };
    assert.equal((await verify(`Bearer ${token()}`, flaky)).ok, true);
    // Past the TTL the verifier tries again, fails, and falls back to the key
    // it already holds — Google's signature is not less genuine because their
    // endpoint blipped.
    const later = NOW_MS + 7_200_000;
    const check = await verifyGoogleOidcToken({
      authorization: `Bearer ${signer.sign(
        { alg: "RS256", kid: "kid-1", typ: "JWT" },
        {
          iss: "https://accounts.google.com",
          aud: AUD,
          email: SA,
          email_verified: true,
          exp: Math.floor(later / 1000) + 600,
        },
      )}`,
      audience: AUD,
      serviceAccountEmail: SA,
      nowMs: later,
      jwksUrl: JWKS_URL,
      fetcher: flaky,
    });
    assert.equal(check.ok, true);
  });
});
