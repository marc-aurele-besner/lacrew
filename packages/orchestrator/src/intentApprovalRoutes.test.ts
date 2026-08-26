/**
 * Root-anchored approvals over the HTTP surface (F2.6 / F1.3).
 *
 * The claim under test: an intent that has climbed to the human root cannot be
 * settled by whoever holds this orchestrator's credential. Holding the bearer
 * token, or an assertion from some other authenticator, or a proof collected
 * for a different decision, all leave the intent exactly where it was — and the
 * client is never asked to resolve it.
 *
 * The other half matters just as much: a manager-depth intent stays ungated. A
 * product that demands the root's authenticator for a spend inside a manager's
 * own bounds has no reporting tree, only a root with extra steps.
 *
 * The chain is faked — EscalationRouter's own `msg.sender` check is covered by
 * the Foundry suites — so what these tests read is whether the runtime was
 * asked to resolve at all, and as whom.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { p256 } from "@noble/curves/nist.js";
import { privateKeyToAccount } from "viem/accounts";
import { createLacrewClient } from "@lacrew/sdk/testing";
import { ANVIL_CHAIN_ID, rootChallengeStatement, type Intent, type OrgNode } from "@lacrew/core";
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
const MANAGER = "0x00000000000000000000000000000000000000a5" as `0x${string}`;
const WORKER = "0x00000000000000000000000000000000000000b9" as `0x${string}`;
const TARGET = "0x00000000000000000000000000000000000000cc" as `0x${string}`;

/** Anvil account 0 and 1, used only to sign statements — no chain is touched. */
const ROOT_WALLET = privateKeyToAccount(
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
);
const STRANGER_WALLET = privateKeyToAccount(
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
);

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
  const privateKey = p256.utils.randomSecretKey();
  const point = p256.Point.BASE.multiply(p256.Point.Fn.fromBytes(privateKey)).toBytes(false);
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
    .update(Buffer.concat([authData, createHash("sha256").update(clientData).digest()]))
    .digest();
  return {
    kind: "passkey" as const,
    credentialId: cred.credentialId,
    authenticatorData: Buffer.from(authData).toString("base64url"),
    clientDataJSON: clientData.toString("base64url"),
    signature: Buffer.from(
      p256.sign(new Uint8Array(digest), cred.privateKey, { prehash: false, format: "der" }),
    ).toString("base64url"),
  };
}

const ORG: OrgNode[] = [
  { account: ROOT, kind: "human_root", parent: null, active: true },
  { account: MANAGER, kind: "manager_agent", parent: ROOT, active: true },
  { account: WORKER, kind: "worker_agent", parent: MANAGER, active: true },
];

function intent(id: string, awaitingApprover: `0x${string}`): Intent {
  return {
    id,
    agent: WORKER,
    target: TARGET,
    value: 75n * 10n ** 6n,
    data: "0x",
    awaitingApprover,
    resolved: false,
    approved: null,
    verdict: "ESCALATE",
  };
}

/** Records every resolve the runtime asks the chain for, and as whom. */
function approvalClient(state: {
  resolved: Array<{ id: string; approved: boolean; approver?: string }>;
}) {
  const base = createLacrewClient({ useMock: true }) as unknown as Record<string, unknown>;
  const pending = [intent("root-1", ROOT), intent("mgr-1", MANAGER)];
  return {
    ...base,
    addresses: { chainId: ANVIL_CHAIN_ID, humanRoot: ROOT },
    async getOrgTree() {
      return ORG;
    },
    async getPendingIntents() {
      return pending.filter((i) => !i.resolved);
    },
    async getAuditTrail() {
      return [];
    },
    async resolveIntent(id: string, approved: boolean, approver?: `0x${string}`) {
      state.resolved.push({ id, approved, ...(approver ? { approver } : {}) });
      const found = pending.find((i) => i.id === id)!;
      found.resolved = true;
      found.approved = approved;
      return { intent: found, escalated: false, txHash: "0xresolve" as const };
    },
  };
}

function buildApp(rootAuth?: ReturnType<typeof createRootAuthSurface>) {
  const state = { resolved: [] as Array<{ id: string; approved: boolean; approver?: string }> };
  const runtime = new CrewRuntime({ client: approvalClient(state) as never });
  const model = new MemoryModelProvider();
  const app = createOrchestratorApp({
    runtime,
    queue: new InMemoryQueue(),
    model,
    flows: createFlowsSurface({ runtime, model, store: createMemoryFlowStore() }),
    ...(rootAuth ? { rootAuth } : {}),
    mcpUseMock: true,
    isDbReady: () => false,
    isDbConfigured: () => false,
  });
  return { app, state };
}

const post = (app: ReturnType<typeof buildApp>["app"], path: string, body: unknown) =>
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

function walletAuth() {
  return createRootAuthSurface({ config: { kind: "wallet", address: ROOT_WALLET.address } });
}

describe("POST /intents/resolve — root-depth approvals", () => {
  it("refuses a bare request, and never asks the chain to resolve", async () => {
    const { app, state } = buildApp(passkeyAuth(credential()));
    const res = await post(app, "/intents/resolve", { intentId: "root-1", approved: true });
    assert.equal(res.status, 401);
    assert.equal(((await res.json()) as { error: string }).error, "root_proof_required");
    // The acceptance criterion, stated as an assertion: a live intent awaiting
    // the root is not resolvable by whoever holds the orchestrator's token.
    assert.deepEqual(state.resolved, []);
  });

  it("refuses an assertion from an authenticator that is not the root's", async () => {
    const cred = credential();
    const rootAuth = passkeyAuth(cred);
    const { app, state } = buildApp(rootAuth);
    const challenge = rootAuth.issueChallenge("intent:approve", "root-1");
    const res = await post(app, "/intents/resolve", {
      intentId: "root-1",
      approved: true,
      challenge: challenge.challenge,
      // A stranger's key, wearing the registered credential id.
      rootProof: {
        ...assertFor(credential(), challenge.challenge),
        credentialId: cred.credentialId,
      },
    });
    assert.equal(res.status, 401);
    assert.deepEqual(state.resolved, []);
  });

  it("approves on a valid assertion, signing as the root the chain is waiting on", async () => {
    const cred = credential();
    const rootAuth = passkeyAuth(cred);
    const { app, state } = buildApp(rootAuth);
    const challenge = rootAuth.issueChallenge("intent:approve", "root-1");
    const res = await post(app, "/intents/resolve", {
      intentId: "root-1",
      approved: true,
      challenge: challenge.challenge,
      rootProof: assertFor(cred, challenge.challenge),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { authorizedBy: string; approver: string; txHash: string };
    assert.equal(body.authorizedBy, "root:passkey");
    assert.equal(body.approver, ROOT);
    assert.equal(body.txHash, "0xresolve");
    assert.deepEqual(state.resolved, [{ id: "root-1", approved: true, approver: ROOT }]);
  });

  it("will not let a proof collected to deny be spent approving", async () => {
    const cred = credential();
    const rootAuth = passkeyAuth(cred);
    const { app, state } = buildApp(rootAuth);
    // Consent to refuse a spend is not consent to release it.
    const challenge = rootAuth.issueChallenge("intent:deny", "root-1");
    const res = await post(app, "/intents/resolve", {
      intentId: "root-1",
      approved: true,
      challenge: challenge.challenge,
      rootProof: assertFor(cred, challenge.challenge),
    });
    assert.equal(res.status, 401);
    assert.equal(((await res.json()) as { error: string }).error, "challenge_not_for_this_action");
    assert.deepEqual(state.resolved, []);
  });

  it("will not let a session revoke's proof settle an intent", async () => {
    const cred = credential();
    const rootAuth = passkeyAuth(cred);
    const { app, state } = buildApp(rootAuth);
    const challenge = rootAuth.issueChallenge("session:revoke", "root-1");
    const res = await post(app, "/intents/resolve", {
      intentId: "root-1",
      approved: true,
      challenge: challenge.challenge,
      rootProof: assertFor(cred, challenge.challenge),
    });
    assert.equal(res.status, 401);
    assert.deepEqual(state.resolved, []);
  });

  it("burns the challenge on a failed attempt, so proofs cannot be ground against one nonce", async () => {
    const cred = credential();
    const rootAuth = passkeyAuth(cred);
    const { app, state } = buildApp(rootAuth);
    const challenge = rootAuth.issueChallenge("intent:approve", "root-1");

    const wrong = await post(app, "/intents/resolve", {
      intentId: "root-1",
      approved: true,
      challenge: challenge.challenge,
      rootProof: {
        ...assertFor(credential(), challenge.challenge),
        credentialId: cred.credentialId,
      },
    });
    assert.equal(wrong.status, 401);

    // The real root, the real assertion — and still refused, because the nonce
    // it answers is gone. A fresh challenge is one round trip; a nonce that
    // survives failures is an oracle.
    const retry = await post(app, "/intents/resolve", {
      intentId: "root-1",
      approved: true,
      challenge: challenge.challenge,
      rootProof: assertFor(cred, challenge.challenge),
    });
    assert.equal(retry.status, 401);
    assert.equal(((await retry.json()) as { error: string }).error, "challenge_expired_or_unknown");
    assert.deepEqual(state.resolved, []);
  });

  it("denies on a valid assertion for the deny action", async () => {
    const cred = credential();
    const rootAuth = passkeyAuth(cred);
    const { app, state } = buildApp(rootAuth);
    const challenge = rootAuth.issueChallenge("intent:deny", "root-1");
    const res = await post(app, "/intents/resolve", {
      intentId: "root-1",
      approved: false,
      challenge: challenge.challenge,
      rootProof: assertFor(cred, challenge.challenge),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(state.resolved, [{ id: "root-1", approved: false, approver: ROOT }]);
  });

  it("takes a wallet root's signature, and refuses a stranger's", async () => {
    const rootAuth = walletAuth();
    const { app, state } = buildApp(rootAuth);

    const first = rootAuth.issueChallenge("intent:approve", "root-1");
    const stranger = await post(app, "/intents/resolve", {
      intentId: "root-1",
      approved: true,
      challenge: first.challenge,
      rootProof: {
        kind: "wallet",
        address: ROOT_WALLET.address,
        signature: await STRANGER_WALLET.signMessage({ message: first.statement }),
      },
    });
    assert.equal(stranger.status, 401);
    assert.deepEqual(state.resolved, []);

    const second = rootAuth.issueChallenge("intent:approve", "root-1");
    const ok = await post(app, "/intents/resolve", {
      intentId: "root-1",
      approved: true,
      challenge: second.challenge,
      rootProof: {
        kind: "wallet",
        address: ROOT_WALLET.address,
        signature: await ROOT_WALLET.signMessage({
          message: rootChallengeStatement({
            action: "intent:approve",
            subject: "root-1",
            challenge: second.challenge,
          }),
        }),
      },
    });
    assert.equal(ok.status, 200);
    assert.equal(((await ok.json()) as { authorizedBy: string }).authorizedBy, "root:wallet");
    assert.deepEqual(state.resolved, [{ id: "root-1", approved: true, approver: ROOT }]);
  });
});

describe("POST /intents/resolve — manager-depth approvals", () => {
  it("resolves with no proof, as the manager the chain is waiting on", async () => {
    const { app, state } = buildApp(passkeyAuth(credential()));
    const res = await post(app, "/intents/resolve", { intentId: "mgr-1", approved: true });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { authorizedBy: string; approver: string };
    assert.equal(body.approver, MANAGER);
    // Not `root:…`: nothing about this decision was shown to a root, and the
    // trail must not read as though it was.
    assert.equal(body.authorizedBy, "approver");
    assert.deepEqual(state.resolved, [{ id: "mgr-1", approved: true, approver: MANAGER }]);
  });

  it("refuses an intent nobody is waiting on rather than treating it as ungated", async () => {
    const { app, state } = buildApp(passkeyAuth(credential()));
    const res = await post(app, "/intents/resolve", { intentId: "ghost-9", approved: true });
    assert.equal(res.status, 404);
    assert.equal(((await res.json()) as { error: string }).error, "intent_not_pending");
    assert.deepEqual(state.resolved, []);
  });
});

describe("POST /root-auth/challenge — intent actions", () => {
  it("asks for the root only when the intent has climbed to the root", async () => {
    const { app } = buildApp(passkeyAuth(credential()));

    const atRoot = await post(app, "/root-auth/challenge", {
      action: "intent:approve",
      subject: "root-1",
    });
    const rootBody = (await atRoot.json()) as { required: boolean; challenge: string | null };
    assert.equal(rootBody.required, true);
    assert.ok(rootBody.challenge);

    // No authenticator prompt for a spend inside the manager's own bounds — a
    // prompt that is not really required is one operators learn to click past.
    const atManager = await post(app, "/root-auth/challenge", {
      action: "intent:approve",
      subject: "mgr-1",
    });
    const mgrBody = (await atManager.json()) as {
      required: boolean;
      challenge: string | null;
      awaitingApprover: string;
    };
    assert.equal(mgrBody.required, false);
    assert.equal(mgrBody.challenge, null);
    assert.equal(mgrBody.awaitingApprover, MANAGER);
  });

  it("mints nothing for an intent that is not pending", async () => {
    const { app } = buildApp(passkeyAuth(credential()));
    const res = await post(app, "/root-auth/challenge", {
      action: "intent:approve",
      subject: "ghost-9",
    });
    assert.equal(res.status, 404);
  });

  it("refuses an action it cannot verify", async () => {
    const { app } = buildApp(passkeyAuth(credential()));
    const res = await post(app, "/root-auth/challenge", {
      action: "intent:execute",
      subject: "root-1",
    });
    assert.equal(res.status, 400);
  });
});

describe("root-depth approvals with no root configured", () => {
  it("resolves, and says plainly that nobody was asked", async () => {
    // A deployment with no LACREW_ROOT_AUTH is ungated — the self-host default
    // where the operator is holding the key at the terminal. What must not
    // happen is the trail recording a root's consent nobody sought.
    const { app, state } = buildApp();
    const res = await post(app, "/intents/resolve", { intentId: "root-1", approved: true });
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as { authorizedBy: string }).authorizedBy, "unauthenticated");
    assert.deepEqual(state.resolved, [{ id: "root-1", approved: true, approver: ROOT }]);
  });
});
