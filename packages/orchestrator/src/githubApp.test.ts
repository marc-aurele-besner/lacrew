import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createPublicKey, createVerify, generateKeyPairSync } from "node:crypto";
import {
  createGithubAppTokenSource,
  normalizePrivateKey,
  signAppJwt,
  type GithubAppAuth,
} from "./githubApp.js";
import { buildConnectorPreset, createConnectorRegistry } from "./index.js";

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

const AUTH: GithubAppAuth = {
  kind: "github-app",
  appIdEnv: "GITHUB_APP_ID",
  privateKeyEnv: "GITHUB_APP_PRIVATE_KEY",
  installationIdEnv: "GITHUB_APP_INSTALLATION_ID",
};

const ENV = {
  GITHUB_APP_ID: "123456",
  GITHUB_APP_PRIVATE_KEY: privateKey,
  GITHUB_APP_INSTALLATION_ID: "48213991",
};

const HOUR_MS = 60 * 60 * 1000;

function decode(part: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>;
}

/** A GitHub stub: mints tokens on the exchange path, serves the API elsewhere. */
function githubStub(opts: { apiStatus?: number[]; expiresInMs?: number; now?: () => number } = {}) {
  const exchanges: Array<{ url: string; jwt: string }> = [];
  const apiCalls: Array<{ url: string; token: string }> = [];
  const statuses = [...(opts.apiStatus ?? [])];
  const now = opts.now ?? Date.now;
  let minted = 0;
  const impl = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const bearer = (headers.authorization ?? "").replace(/^Bearer /, "");
    if (u.includes("/access_tokens")) {
      exchanges.push({ url: u, jwt: bearer });
      minted += 1;
      return new Response(
        JSON.stringify({
          token: `ghs_installation_${minted}`,
          expires_at: new Date(now() + (opts.expiresInMs ?? HOUR_MS)).toISOString(),
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      );
    }
    apiCalls.push({ url: u, token: bearer });
    const status = statuses.shift() ?? 200;
    return new Response(JSON.stringify({ number: 7 }), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { impl, exchanges, apiCalls, mintCount: () => minted };
}

test("the app JWT is RS256, backdated, and verifies against the app's public key", () => {
  const nowMs = 1_800_000_000_000;
  const jwt = signAppJwt("123456", privateKey, nowMs);
  const [header, payload, signature] = jwt.split(".") as [string, string, string];

  assert.deepEqual(decode(header), { alg: "RS256", typ: "JWT" });
  const claims = decode(payload) as { iat: number; exp: number; iss: string };
  assert.equal(claims.iss, "123456");
  // Backdated so GitHub never sees an `iat` in its own future.
  assert.equal(claims.iat, Math.floor(nowMs / 1000) - 60);
  assert.ok(claims.exp - claims.iat <= 600, "GitHub rejects a JWT older than 10 minutes");

  const verifier = createVerify("RSA-SHA256");
  verifier.update(`${header}.${payload}`);
  assert.ok(
    verifier.verify(createPublicKey(publicKey), Buffer.from(signature, "base64url")),
    "signature must verify against the app key",
  );
});

test("a private key mangled by an env var still loads", () => {
  const escaped = privateKey.replace(/\n/g, "\\n");
  assert.equal(normalizePrivateKey(escaped), privateKey.trim());
  assert.equal(normalizePrivateKey(Buffer.from(privateKey).toString("base64")), privateKey.trim());
  assert.equal(normalizePrivateKey(`  ${privateKey}  `), privateKey.trim());
});

test("a key that is not a key fails as a key, not as a 401 later", () => {
  assert.throws(() => normalizePrivateKey("hunter2"), /github_app_private_key_unreadable/);
  assert.throws(
    () => signAppJwt("1", "-----BEGIN RSA PRIVATE KEY-----\nnope\n-----END RSA PRIVATE KEY-----", 0),
    /github_app_private_key_invalid/,
  );
});

test("the installation token is minted once and reused until it nears expiry", async () => {
  let clock = 1_800_000_000_000;
  const stub = githubStub({ now: () => clock });
  const source = createGithubAppTokenSource({ fetchImpl: stub.impl, now: () => clock });
  const args = { cacheKey: "github", baseUrl: "https://api.github.com", auth: AUTH, env: ENV };

  assert.equal(await source.get(args), "ghs_installation_1");
  assert.equal(await source.get(args), "ghs_installation_1");
  assert.equal(stub.mintCount(), 1, "a cached token must not be re-minted");

  // Still inside the refresh margin's safe zone.
  clock += 50 * 60 * 1000;
  assert.equal(await source.get(args), "ghs_installation_1");
  assert.equal(stub.mintCount(), 1);

  // Now within five minutes of expiry: re-mint rather than ride a dying token.
  clock += 6 * 60 * 1000;
  assert.equal(await source.get(args), "ghs_installation_2");
  assert.equal(stub.mintCount(), 2);
});

test("the exchange goes to the connector's own host, so Enterprise works", async () => {
  const stub = githubStub();
  const source = createGithubAppTokenSource({ fetchImpl: stub.impl });
  await source.get({
    cacheKey: "ghe",
    baseUrl: "https://github.acme.example/api/v3",
    auth: AUTH,
    env: ENV,
  });
  assert.equal(
    stub.exchanges[0]!.url,
    "https://github.acme.example/api/v3/app/installations/48213991/access_tokens",
  );
});

test("concurrent cold calls mint one token, not one each", async () => {
  const stub = githubStub();
  const source = createGithubAppTokenSource({ fetchImpl: stub.impl });
  const args = { cacheKey: "github", baseUrl: "https://api.github.com", auth: AUTH, env: ENV };
  const tokens = await Promise.all([source.get(args), source.get(args), source.get(args)]);
  assert.deepEqual(tokens, ["ghs_installation_1", "ghs_installation_1", "ghs_installation_1"]);
  assert.equal(stub.mintCount(), 1);
});

test("a missing credential names the env var that is missing", async () => {
  const stub = githubStub();
  const source = createGithubAppTokenSource({ fetchImpl: stub.impl });
  const base = { cacheKey: "github", baseUrl: "https://api.github.com", auth: AUTH };
  await assert.rejects(
    source.get({ ...base, env: { ...ENV, GITHUB_APP_ID: undefined } }),
    /connector_missing_credential:GITHUB_APP_ID/,
  );
  await assert.rejects(
    source.get({ ...base, env: { ...ENV, GITHUB_APP_PRIVATE_KEY: undefined } }),
    /connector_missing_credential:GITHUB_APP_PRIVATE_KEY/,
  );
  await assert.rejects(
    source.get({ ...base, env: { ...ENV, GITHUB_APP_INSTALLATION_ID: undefined } }),
    /connector_missing_credential:GITHUB_APP_INSTALLATION_ID/,
  );
});

test("a refused exchange reports the status and never the body", async () => {
  const impl = (async () =>
    new Response(JSON.stringify({ message: "A JWT could not be decoded", jwt: "eyJ…" }), {
      status: 401,
    })) as unknown as typeof fetch;
  const source = createGithubAppTokenSource({ fetchImpl: impl });
  await assert.rejects(
    source.get({ cacheKey: "github", baseUrl: "https://api.github.com", auth: AUTH, env: ENV }),
    (err: Error) => {
      assert.match(err.message, /github_app_token_exchange_failed:401/);
      assert.ok(!err.message.includes("eyJ"), "the echoed JWT must not reach the error");
      return true;
    },
  );
});

test("an unparseable expiry is treated as an hour, never as forever", async () => {
  let clock = 1_800_000_000_000;
  const impl = (async () =>
    new Response(JSON.stringify({ token: "ghs_x", expires_at: "soon" }), {
      status: 201,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
  const source = createGithubAppTokenSource({ fetchImpl: impl, now: () => clock });
  const args = { cacheKey: "github", baseUrl: "https://api.github.com", auth: AUTH, env: ENV };
  await source.get(args);
  assert.equal(source.status("github").cached, true);
  clock += 56 * 60 * 1000;
  // Inside the assumed hour minus the margin it is still live; past it, gone.
  assert.ok(Date.parse(source.status("github").expiresAt!) - clock < 5 * 60 * 1000);
});

test("status reports whether a token is held, never the token", async () => {
  const stub = githubStub();
  const source = createGithubAppTokenSource({ fetchImpl: stub.impl });
  assert.deepEqual(source.status("github"), { cached: false, expiresAt: null });
  await source.get({ cacheKey: "github", baseUrl: "https://api.github.com", auth: AUTH, env: ENV });
  const status = source.status("github");
  assert.equal(status.cached, true);
  assert.ok(status.expiresAt);
  assert.ok(!JSON.stringify(status).includes("ghs_"), "no token material in a status view");
});

/* ------------------------------------------------------------------ *
 * Through the registry
 * ------------------------------------------------------------------ */

function appConnector() {
  return buildConnectorPreset("github", {
    authMode: "github-app",
    omitRoutes: ["merge_pull_request"],
  });
}

test("a connector call carries the installation token, not the private key", async () => {
  const stub = githubStub();
  const registry = createConnectorRegistry({
    connectors: [appConnector()],
    env: ENV,
    fetchImpl: stub.impl,
  });
  const res = await registry.call("github.get_pull_request", {
    owner: "o",
    repo: "r",
    number: 7,
  });
  assert.equal(res.ok, true);
  assert.equal(stub.apiCalls[0]!.token, "ghs_installation_1");
  // The JWT went only to the exchange; the API call never sees app material.
  assert.equal(stub.exchanges.length, 1);
  assert.ok(!stub.apiCalls[0]!.token.includes("."), "an API call must not carry the app JWT");
});

test("a 401 re-mints once and retries, rather than failing a live crew", async () => {
  const stub = githubStub({ apiStatus: [401, 200] });
  const registry = createConnectorRegistry({
    connectors: [appConnector()],
    env: ENV,
    fetchImpl: stub.impl,
  });
  const res = await registry.call("github.get_pull_request", { owner: "o", repo: "r", number: 7 });
  assert.equal(res.status, 200);
  assert.equal(stub.mintCount(), 2, "the stale token must be replaced");
  assert.deepEqual(
    stub.apiCalls.map((c) => c.token),
    ["ghs_installation_1", "ghs_installation_2"],
  );
});

test("a genuine 401 is reported after one re-mint, not retried forever", async () => {
  const stub = githubStub({ apiStatus: [401, 401] });
  const registry = createConnectorRegistry({
    connectors: [appConnector()],
    env: ENV,
    fetchImpl: stub.impl,
  });
  const res = await registry.call("github.get_pull_request", { owner: "o", repo: "r", number: 7 });
  assert.equal(res.status, 401);
  assert.equal(res.ok, false);
  assert.equal(stub.apiCalls.length, 2, "exactly one retry");
});

test("a bearer connector does not re-mint on a 401 — there is nothing to re-mint", async () => {
  const stub = githubStub({ apiStatus: [401, 200] });
  const registry = createConnectorRegistry({
    connectors: [
      buildConnectorPreset("github", { authMode: "token", omitRoutes: ["merge_pull_request"] }),
    ],
    env: { GH_TOKEN: "ghp_x" },
    fetchImpl: stub.impl,
  });
  const res = await registry.call("github.get_pull_request", { owner: "o", repo: "r", number: 7 });
  assert.equal(res.status, 401);
  assert.equal(stub.apiCalls.length, 1);
});

test("describe() reports wiring without a credential anywhere in it", async () => {
  const stub = githubStub();
  const registry = createConnectorRegistry({
    connectors: [
      buildConnectorPreset("github", {
        authMode: "github-app",
        policyTargets: { merge_pull_request: "0x00000000000000000000000000000000000000aa" },
      }),
    ],
    env: ENV,
    fetchImpl: stub.impl,
  });

  let view = registry.describe();
  assert.equal(view.length, 1);
  assert.equal(view[0]!.auth.kind, "github-app");
  assert.deepEqual(view[0]!.auth.envVars, [
    "GITHUB_APP_ID",
    "GITHUB_APP_PRIVATE_KEY",
    "GITHUB_APP_INSTALLATION_ID",
  ]);
  assert.equal(view[0]!.auth.ready, true);
  assert.deepEqual(view[0]!.auth.installationToken, { cached: false, expiresAt: null });

  const merge = view[0]!.routes.find((r) => r.name === "merge_pull_request")!;
  assert.equal(merge.effect, "write");
  assert.equal(merge.policyTarget, "0x00000000000000000000000000000000000000aa");
  assert.equal(view[0]!.routes.find((r) => r.name === "get_pull_request")!.policyTarget, null);

  await registry.call("github.get_pull_request", { owner: "o", repo: "r", number: 7 });
  view = registry.describe();
  assert.equal(view[0]!.auth.installationToken!.cached, true);

  const serialized = JSON.stringify(view);
  assert.ok(!serialized.includes("BEGIN RSA"), "no key material");
  assert.ok(!serialized.includes("ghs_"), "no installation token");
  assert.ok(!serialized.includes("48213991"), "not even the installation id value");
});

test("describe() says not-ready when the env vars are absent", () => {
  const registry = createConnectorRegistry({
    connectors: [buildConnectorPreset("github", { authMode: "github-app", omitRoutes: ["merge_pull_request"] })],
    env: { GITHUB_APP_ID: "1" },
  });
  assert.equal(registry.describe()[0]!.auth.ready, false);
});

test("validation refuses a half-configured github-app connector", () => {
  assert.throws(
    () =>
      createConnectorRegistry({
        connectors: [
          {
            id: "github",
            baseUrl: "https://api.github.com",
            auth: {
              kind: "github-app",
              appIdEnv: "GITHUB_APP_ID",
              privateKeyEnv: "",
              installationIdEnv: "GITHUB_APP_INSTALLATION_ID",
            },
            routes: [{ name: "get_pr", method: "GET", path: "/x", effect: "read" }],
          },
        ],
      }),
    /github-app auth needs privateKeyEnv/,
  );
});
