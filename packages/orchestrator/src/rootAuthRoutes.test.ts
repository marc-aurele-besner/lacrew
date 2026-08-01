/**
 * Root-authorized session lifecycle over the HTTP surface (F0.7).
 *
 * What is pinned here is the gate and the rotation's bounds: that a caller
 * holding nothing but the orchestrator's own credential cannot retire or
 * re-issue a key, and that the replacement a rotation mints carries the
 * retired key's authority rather than a fresh grant of its own.
 *
 * The chain is faked — SessionRegistry's own behaviour is covered by the
 * Foundry suites — so what these tests read is the arguments the runtime would
 * have sent it.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { p256 } from "@noble/curves/nist";
import { createLacrewClient } from "@lacrew/sdk/testing";
import { ANVIL_CHAIN_ID, MOCK_WORKER, type SessionScope } from "@lacrew/core";
import { CrewRuntime } from "./runtime.js";
import { createFlowsSurface } from "./flows.js";
import { createMemoryFlowStore } from "./flowStore.js";
import { InMemoryQueue } from "./queue/index.js";
import { MemoryModelProvider } from "./model/index.js";
import { createOrchestratorApp } from "./httpApp.js";
import { createRootAuthSurface } from "./rootAuth.js";

const RP_ID = "localhost";
const ORIGIN = "http://localhost:3000";
const ROOT = "0x00000000000000000000000000000000000000d7" as `0x${string}`;
const TARGET_A = "0x00000000000000000000000000000000000000a1" as `0x${string}`;
const TARGET_B = "0x00000000000000000000000000000000000000b2" as `0x${string}`;

function coseKey(x: Uint8Array, y: Uint8Array): string {
  return Buffer.from([
    0xa5,
    0x01,
    0x02,
    0x03,
    0x26,
    0x20,
    0x01,
    0x21,
    0x58,
    0x20,
    ...x,
    0x22,
    0x58,
    0x20,
    ...y,
  ]).toString("base64url");
}

function credential() {
  const privateKey = p256.utils.randomPrivateKey();
  const point =
    p256.ProjectivePoint.fromPrivateKey(privateKey).toRawBytes(false);
  return {
    privateKey,
    publicKey: coseKey(point.slice(1, 33), point.slice(33, 65)),
    credentialId: randomBytes(16).toString("base64url"),
  };
}

function assertFor(cred: ReturnType<typeof credential>, challenge: string) {
  const clientData = Buffer.from(
    JSON.stringify({ type: "webauthn.get", challenge, origin: ORIGIN }),
  );
  const authData = new Uint8Array(37);
  authData.set(new Uint8Array(createHash("sha256").update(RP_ID).digest()), 0);
  authData[32] = 0x05;
  const digest = createHash("sha256")
    .update(
      Buffer.concat([
        authData,
        createHash("sha256").update(clientData).digest(),
      ]),
    )
    .digest();
  return {
    kind: "passkey" as const,
    credentialId: cred.credentialId,
    authenticatorData: Buffer.from(authData).toString("base64url"),
    clientDataJSON: clientData.toString("base64url"),
    signature: Buffer.from(
      p256.sign(new Uint8Array(digest), cred.privateKey).toDERRawBytes(),
    ).toString("base64url"),
  };
}

type IssueArgs = {
  agent: `0x${string}`;
  maxValue: bigint;
  allowedTarget?: `0x${string}`;
  allowedTargets?: `0x${string}`[];
  scopeMask: bigint;
  window?: { start: number; end: number };
  rate?: { maxProposals: number; ratePeriod: number };
};

/** A live session as SessionRegistry would report it, and the writes it takes. */
function sessionClient(state: {
  issued: IssueArgs[];
  revoked: string[];
  live: {
    keyId: string;
    scopes: SessionScope[];
    maxValue: string;
    allowedTarget: `0x${string}`;
    allowedTargets?: `0x${string}`[];
    window?: { start: number; end: number };
    rate?: { maxProposals: number; ratePeriod: number };
  };
}) {
  const base = createLacrewClient({ useMock: true }) as unknown as Record<
    string,
    unknown
  >;
  let seq = 0;
  return {
    ...base,
    publicClient: {
      async getBalance() {
        return 10n ** 18n;
      },
    },
    addresses: {
      chainId: ANVIL_CHAIN_ID,
      sessionRegistry: "0x00000000000000000000000000000000000000aa",
      humanRoot: ROOT,
    },
    walletClient: { account: { address: ROOT } },
    async issueSession(args: IssueArgs) {
      state.issued.push(args);
      return { sessionId: `s-${(seq += 1)}`, txHash: "0xissue" };
    },
    async revokeSession(id: string) {
      state.revoked.push(id);
      return { txHash: "0xrevoke" };
    },
    async fundEth() {
      return { txHash: "0xfund" };
    },
    async getAuditTrail() {
      return [];
    },
    async getSessions() {
      return [
        {
          agent: MOCK_WORKER,
          keyId: state.live.keyId,
          keyAddress: "0x00000000000000000000000000000000000000ee",
          expiresAt: Date.now() + 3_600_000,
          scopes: state.live.scopes,
          maxValue: state.live.maxValue,
          allowedTarget: state.live.allowedTarget,
          ...(state.live.allowedTargets
            ? { allowedTargets: state.live.allowedTargets }
            : {}),
          ...(state.live.window ? { window: state.live.window } : {}),
          ...(state.live.rate ? { rate: state.live.rate } : {}),
          revoked: false,
        },
      ];
    },
  };
}

function buildApp(opts: {
  rootAuth?: ReturnType<typeof createRootAuthSurface>;
  live?: Partial<Parameters<typeof sessionClient>[0]["live"]>;
}) {
  const state = {
    issued: [] as IssueArgs[],
    revoked: [] as string[],
    live: {
      keyId: "7",
      scopes: ["propose:intent"] as SessionScope[],
      maxValue: "50000000",
      allowedTarget: TARGET_A,
      ...opts.live,
    },
  };
  const runtime = new CrewRuntime({
    client: sessionClient(state) as never,
  });
  const model = new MemoryModelProvider();
  const app = createOrchestratorApp({
    runtime,
    queue: new InMemoryQueue(),
    model,
    flows: createFlowsSurface({
      runtime,
      model,
      store: createMemoryFlowStore(),
    }),
    ...(opts.rootAuth ? { rootAuth: opts.rootAuth } : {}),
    mcpUseMock: true,
    isDbReady: () => false,
    isDbConfigured: () => false,
  });
  return { app, state, runtime };
}

const post = (
  app: ReturnType<typeof buildApp>["app"],
  path: string,
  body: unknown,
) =>
  app.request(path, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });

function passkeyAuth(cred: ReturnType<typeof credential>) {
  return createRootAuthSurface({
    config: {
      kind: "passkey",
      credentialId: cred.credentialId,
      publicKey: cred.publicKey,
      rpId: RP_ID,
      origin: ORIGIN,
    },
  });
}

describe("POST /sessions/revoke", () => {
  it("refuses a bare request when a root is configured, and changes nothing", async () => {
    const { app, state } = buildApp({ rootAuth: passkeyAuth(credential()) });
    const res = await post(app, "/sessions/revoke", { sessionId: "7" });
    assert.equal(res.status, 401);
    assert.equal(
      ((await res.json()) as { error: string }).error,
      "root_proof_required",
    );
    // The whole claim: holding the orchestrator's own credential is not enough.
    assert.deepEqual(state.revoked, []);
  });

  it("refuses a proof that is not from the registered credential, and changes nothing", async () => {
    const cred = credential();
    const rootAuth = passkeyAuth(cred);
    const { app, state } = buildApp({ rootAuth });
    const challenge = rootAuth.issueChallenge("session:revoke", "7");
    const res = await post(app, "/sessions/revoke", {
      sessionId: "7",
      challenge: challenge.challenge,
      rootProof: {
        ...assertFor(credential(), challenge.challenge),
        credentialId: cred.credentialId,
      },
    });
    assert.equal(res.status, 401);
    assert.equal(
      ((await res.json()) as { error: string }).error,
      "signature_invalid",
    );
    assert.deepEqual(state.revoked, []);
  });

  it("revokes onchain once the root proves it, and says who authorized it", async () => {
    const cred = credential();
    const rootAuth = passkeyAuth(cred);
    const { app, state } = buildApp({ rootAuth });
    const challenge = rootAuth.issueChallenge("session:revoke", "7");
    const res = await post(app, "/sessions/revoke", {
      sessionId: "7",
      challenge: challenge.challenge,
      rootProof: assertFor(cred, challenge.challenge),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { txHash: string; authorizedBy: string };
    assert.equal(body.txHash, "0xrevoke");
    assert.equal(body.authorizedBy, "root:passkey");
    assert.deepEqual(state.revoked, ["7"]);
  });

  it("lets automated containment narrow, under its own name", async () => {
    const { app, state } = buildApp({ rootAuth: passkeyAuth(credential()) });
    const res = await post(app, "/sessions/revoke", {
      sessionId: "7",
      containment: true,
    });
    assert.equal(res.status, 200);
    // Audited as containment, never as a root: a guardian lockdown removes
    // authority and is worth keeping, but it did not ask the human.
    assert.equal(
      ((await res.json()) as { authorizedBy: string }).authorizedBy,
      "containment",
    );
    assert.deepEqual(state.revoked, ["7"]);
  });

  it("stays open, and admits it, when no root is configured", async () => {
    const { app, state } = buildApp({});
    const res = await post(app, "/sessions/revoke", { sessionId: "7" });
    assert.equal(res.status, 200);
    assert.equal(
      ((await res.json()) as { authorizedBy: string }).authorizedBy,
      "unauthenticated",
    );
    assert.deepEqual(state.revoked, ["7"]);
  });
});

describe("POST /sessions/rotate", () => {
  it("refuses a bare request, and neither retires nor issues anything", async () => {
    const { app, state } = buildApp({ rootAuth: passkeyAuth(credential()) });
    const res = await post(app, "/sessions/rotate", { sessionId: "7" });
    assert.equal(res.status, 401);
    assert.deepEqual(state.revoked, []);
    assert.deepEqual(state.issued, []);
  });

  it("never accepts the containment carve-out — rotation issues authority", async () => {
    const { app, state } = buildApp({ rootAuth: passkeyAuth(credential()) });
    const res = await post(app, "/sessions/rotate", {
      sessionId: "7",
      containment: true,
    });
    assert.equal(res.status, 401);
    assert.deepEqual(state.issued, []);
  });

  it("re-issues under the retired key's own scopes, value and targets", async () => {
    const cred = credential();
    const rootAuth = passkeyAuth(cred);
    const { app, state } = buildApp({
      rootAuth,
      live: {
        keyId: "7",
        scopes: ["propose:intent"],
        maxValue: "50000000",
        allowedTarget: TARGET_A,
        allowedTargets: [TARGET_A, TARGET_B],
        window: { start: 3600, end: 7200 },
        rate: { maxProposals: 3, ratePeriod: 60 },
      },
    });
    const challenge = rootAuth.issueChallenge("session:rotate", "7");
    const res = await post(app, "/sessions/rotate", {
      sessionId: "7",
      challenge: challenge.challenge,
      rootProof: assertFor(cred, challenge.challenge),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      preserved: boolean;
      authorizedBy: string;
      revoked: { sessionId: string };
      session: { keyId: string };
    };
    assert.equal(body.preserved, true);
    assert.equal(body.authorizedBy, "root:passkey");
    assert.equal(body.revoked.sessionId, "7");
    assert.deepEqual(state.revoked, ["7"]);

    assert.equal(state.issued.length, 1);
    const issued = state.issued[0]!;
    assert.equal(issued.agent, MOCK_WORKER);
    assert.equal(issued.maxValue, 50_000_000n);
    // scopeMask 1 = propose:intent only. A rotation that handed back
    // spend:whitelist would have widened the very key it was cycling.
    assert.equal(issued.scopeMask, 1n);
    assert.deepEqual(issued.allowedTargets, [TARGET_A, TARGET_B]);
    assert.deepEqual(issued.window, { start: 3600, end: 7200 });
    assert.deepEqual(issued.rate, { maxProposals: 3, ratePeriod: 60 });
  });

  it("cannot widen a narrow key even when the deployment default is wider", async () => {
    const cred = credential();
    const rootAuth = passkeyAuth(cred);
    const { app, state } = buildApp({
      rootAuth,
      live: {
        keyId: "7",
        scopes: ["propose:intent"],
        maxValue: "1",
        allowedTarget: TARGET_A,
      },
    });
    const challenge = rootAuth.issueChallenge("session:rotate", "7");
    await post(app, "/sessions/rotate", {
      sessionId: "7",
      challenge: challenge.challenge,
      rootProof: assertFor(cred, challenge.challenge),
    });
    // `boot` treats maxValue as a ceiling, so the replacement can only ever be
    // this narrow or narrower — never the default.
    assert.equal(state.issued[0]!.maxValue, 1n);
  });
});

describe("GET /root-auth", () => {
  it("answers whether a proof will be demanded, and of what kind", async () => {
    const { app } = buildApp({ rootAuth: passkeyAuth(credential()) });
    const body = (await (await app.request("/root-auth")).json()) as {
      required: boolean;
      kind: string;
      configError: string | null;
    };
    assert.deepEqual(
      {
        required: body.required,
        kind: body.kind,
        configError: body.configError,
      },
      { required: true, kind: "passkey", configError: null },
    );
  });

  it("does not mint a challenge for a root that does not exist", async () => {
    const { app } = buildApp({});
    const res = await post(app, "/root-auth/challenge", {
      action: "session:revoke",
      subject: "7",
    });
    const body = (await res.json()) as {
      required: boolean;
      challenge: string | null;
    };
    // A nonce here would let a client render a signing prompt whose answer
    // nothing would ever check.
    assert.deepEqual(body, { required: false, challenge: null, kind: null });
  });

  it("refuses to mint a challenge for anything but the two lifecycle actions", async () => {
    const { app } = buildApp({ rootAuth: passkeyAuth(credential()) });
    const res = await post(app, "/root-auth/challenge", {
      action: "treasury:drain",
      subject: "7",
    });
    assert.equal(res.status, 400);
  });

  it("binds the challenge it mints to the action and subject asked for", async () => {
    const cred = credential();
    const { app } = buildApp({ rootAuth: passkeyAuth(cred) });
    const res = await post(app, "/root-auth/challenge", {
      action: "session:rotate",
      subject: "7",
    });
    const body = (await res.json()) as {
      required: boolean;
      kind: string;
      challenge: string;
      action: string;
      subject: string;
      statement: string;
    };
    assert.equal(body.required, true);
    assert.equal(body.kind, "passkey");
    assert.equal(body.action, "session:rotate");
    assert.equal(body.subject, "7");
    assert.match(body.statement, /action: session:rotate/);
    assert.ok(body.challenge.length > 0);
  });
});
