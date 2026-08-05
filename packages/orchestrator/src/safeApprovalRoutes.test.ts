/**
 * A passkey-owned Safe as the onchain approver, over the HTTP surface
 * (F2.6 / F1.3).
 *
 * The claim under test: when the workspace root is a Safe, the *Safe* settles
 * the intent. Nothing this orchestrator holds a key for is ever asked to
 * resolve — not the manager key, not the resolver key, not on a valid proof and
 * not on an invalid one. `state.resolved` staying empty is therefore the
 * assertion that matters in almost every case here, because a resolve signed by
 * a key this process holds is exactly the substitution a Safe root rules out.
 *
 * The Safe itself is faked at the seam (`SafeApprovalSurface`): the encoding,
 * the contract-signature framing and the challenge binding are covered by
 * `@lacrew/adapter-wallet-safe`, and the real `execTransaction` loop by the
 * anvil test there. What is covered here is the wiring — which challenge is
 * minted, which path a proof takes, and what is recorded when a transaction was
 * only handed back rather than sent.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { p256 } from "@noble/curves/nist";
import { createLacrewClient } from "@lacrew/sdk/testing";
import { ANVIL_CHAIN_ID, type Intent, type OrgNode } from "@lacrew/core";
import { CrewRuntime } from "./runtime.js";
import { createFlowsSurface } from "./flows.js";
import { createMemoryFlowStore } from "./flowStore.js";
import { InMemoryQueue } from "./queue/index.js";
import { MemoryModelProvider } from "./model/index.js";
import { createOrchestratorApp } from "./httpApp.js";
import { createRootAuthSurface } from "./rootAuth.js";
import { SafeApprovalRefusal, type SafeApprovalSurface } from "./safeApproval.js";

const RP_ID = "localhost";
const ORIGIN = "http://localhost:3000";
/** The org's root seat *is* the Safe — that is the whole point of the kind. */
const ROOT_SAFE = "0x00000000000000000000000000000000000005a7" as `0x${string}`;
const MANAGER = "0x00000000000000000000000000000000000000a5" as `0x${string}`;
const WORKER = "0x00000000000000000000000000000000000000b9" as `0x${string}`;
const TARGET = "0x00000000000000000000000000000000000000cc" as `0x${string}`;
const SAFE_TX_HASH = `0x${"7c".repeat(32)}` as `0x${string}`;
const SAFE_CHALLENGE = Buffer.from(SAFE_TX_HASH.slice(2), "hex").toString("base64url");

function coseKey(x: Uint8Array, y: Uint8Array): string {
  return Buffer.from([
    0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x58, 0x20, ...x, 0x22, 0x58, 0x20, ...y,
  ]).toString("base64url");
}

function credential() {
  const privateKey = p256.utils.randomPrivateKey();
  const point = p256.ProjectivePoint.fromPrivateKey(privateKey).toRawBytes(false);
  return {
    privateKey,
    publicKey: coseKey(point.slice(1, 33), point.slice(33, 65)),
    credentialId: randomBytes(16).toString("base64url"),
  };
}

/**
 * `flags` defaults to user-present *and* user-verified, because Safe's WebAuthn
 * signer requires the second. `0x01` is the "preferred ceremony that skipped
 * it" case, which must be refused here rather than onchain.
 */
function assertFor(cred: ReturnType<typeof credential>, challenge: string, flags = 0x05) {
  const clientData = Buffer.from(
    JSON.stringify({ type: "webauthn.get", challenge, origin: ORIGIN }),
  );
  const authData = new Uint8Array(37);
  authData.set(new Uint8Array(createHash("sha256").update(RP_ID).digest()), 0);
  authData[32] = flags;
  const digest = createHash("sha256")
    .update(Buffer.concat([authData, createHash("sha256").update(clientData).digest()]))
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

const ORG: OrgNode[] = [
  { account: ROOT_SAFE, kind: "human_root", parent: null, active: true },
  { account: MANAGER, kind: "manager_agent", parent: ROOT_SAFE, active: true },
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
  pending: Intent[];
}) {
  const base = createLacrewClient({ useMock: true }) as unknown as Record<string, unknown>;
  return {
    ...base,
    addresses: {
      chainId: ANVIL_CHAIN_ID,
      humanRoot: ROOT_SAFE,
      escalationRouter: "0x00000000000000000000000000000000000000e1",
    },
    async getOrgTree() {
      return ORG;
    },
    async getPendingIntents() {
      return state.pending.filter((i) => !i.resolved);
    },
    async getAuditTrail() {
      return [];
    },
    async resolveIntent(id: string, approved: boolean, approver?: `0x${string}`) {
      state.resolved.push({ id, approved, ...(approver ? { approver } : {}) });
      const found = state.pending.find((i) => i.id === id)!;
      found.resolved = true;
      found.approved = approved;
      return { intent: found, escalated: false, txHash: "0xresolve" as const };
    },
  };
}

type SafeState = {
  submits: Array<{ intentId: string; approved: boolean; awaitingApprover: string | null }>;
  relay: boolean;
  refuseWith?: string;
};

/** A stand-in for the real Safe: records what it was asked to do. */
function fakeSafeApproval(safe: SafeState): SafeApprovalSurface {
  return {
    safeAddress: ROOT_SAFE,
    async canRelay() {
      return safe.relay;
    },
    async challengeFor() {
      return { challenge: SAFE_CHALLENGE, safeTxHash: SAFE_TX_HASH, safeAddress: ROOT_SAFE };
    },
    async submit(input) {
      safe.submits.push({
        intentId: input.intentId,
        approved: input.approved,
        awaitingApprover: input.awaitingApprover,
      });
      if (safe.refuseWith) throw new SafeApprovalRefusal(safe.refuseWith);
      if (!safe.relay) {
        return {
          sent: false,
          safeTxHash: SAFE_TX_HASH,
          execution: { to: ROOT_SAFE, data: "0xdeadbeef", value: 0n },
        };
      }
      return { sent: true, safeTxHash: SAFE_TX_HASH, txHash: `0x${"ee".repeat(32)}` };
    },
  };
}

function safePasskeyAuth(cred: ReturnType<typeof credential>) {
  return createRootAuthSurface({
    config: {
      kind: "safe-passkey",
      credentialId: cred.credentialId,
      publicKey: cred.publicKey,
      rpId: RP_ID,
      origin: ORIGIN,
      safeAddress: ROOT_SAFE,
    },
  });
}

function buildApp(opts: {
  rootAuth?: ReturnType<typeof createRootAuthSurface>;
  safe?: SafeState;
  withSafeApproval?: boolean;
}) {
  const state = {
    resolved: [] as Array<{ id: string; approved: boolean; approver?: string }>,
    pending: [intent("root-1", ROOT_SAFE), intent("mgr-1", MANAGER)],
  };
  const runtime = new CrewRuntime({ client: approvalClient(state) as never });
  const model = new MemoryModelProvider();
  const app = createOrchestratorApp({
    runtime,
    queue: new InMemoryQueue(),
    model,
    flows: createFlowsSurface({ runtime, model, store: createMemoryFlowStore() }),
    ...(opts.rootAuth ? { rootAuth: opts.rootAuth } : {}),
    ...(opts.safe && opts.withSafeApproval !== false
      ? { safeApproval: fakeSafeApproval(opts.safe) }
      : {}),
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

describe("POST /root-auth/challenge — a Safe root signs its own transaction", () => {
  it("mints the Safe transaction hash as the challenge, not a nonce of ours", async () => {
    const safe: SafeState = { submits: [], relay: true };
    const { app } = buildApp({ rootAuth: safePasskeyAuth(credential()), safe });
    const res = await post(app, "/root-auth/challenge", {
      action: "intent:approve",
      subject: "root-1",
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.kind, "safe-passkey");
    // One assertion, two verifiers: this challenge is the hash the Safe will
    // check onchain, so the ceremony that proves the root also signs the spend.
    assert.equal(body.challenge, SAFE_CHALLENGE);
    assert.equal(body.safeTxHash, SAFE_TX_HASH);
    assert.equal(body.safeAddress, ROOT_SAFE);
    // The Safe's signer demands it; a "preferred" ceremony would revert onchain.
    assert.equal(body.userVerification, "required");
    assert.equal(body.relayed, true);
  });

  it("says so rather than minting a challenge nothing could consume", async () => {
    // A Safe root with no Safe path wired: a proof collected now would settle
    // nothing, so refusing here beats an authenticator prompt that goes nowhere.
    const { app } = buildApp({ rootAuth: safePasskeyAuth(credential()) });
    const res = await post(app, "/root-auth/challenge", {
      action: "intent:approve",
      subject: "root-1",
    });
    assert.equal(res.status, 501);
    assert.equal(((await res.json()) as { error: string }).error, "safe_approval_unavailable");
  });

  it("leaves manager-depth intents ungated", async () => {
    const safe: SafeState = { submits: [], relay: true };
    const { app } = buildApp({ rootAuth: safePasskeyAuth(credential()), safe });
    const res = await post(app, "/root-auth/challenge", {
      action: "intent:approve",
      subject: "mgr-1",
    });
    const body = (await res.json()) as { required: boolean; awaitingApprover: string };
    assert.equal(body.required, false);
    assert.equal(body.awaitingApprover, MANAGER);
    // No Safe transaction was even planned for a decision the manager may make.
    assert.deepEqual(safe.submits, []);
  });
});

describe("POST /intents/resolve — the Safe is the sender", () => {
  it("settles through the Safe and never through a key this process holds", async () => {
    const cred = credential();
    const rootAuth = safePasskeyAuth(cred);
    const safe: SafeState = { submits: [], relay: true };
    const { app, state } = buildApp({ rootAuth, safe });
    const challenge = rootAuth.issueChallenge("intent:approve", "root-1", SAFE_CHALLENGE);

    const res = await post(app, "/intents/resolve", {
      intentId: "root-1",
      approved: true,
      challenge: challenge.challenge,
      rootProof: assertFor(cred, challenge.challenge),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.authorizedBy, "root:safe-passkey");
    assert.equal(body.approver, ROOT_SAFE);
    assert.equal(body.safeTxHash, SAFE_TX_HASH);
    assert.equal(body.txHash, `0x${"ee".repeat(32)}`);
    // The Safe was asked, with the seat the chain is actually waiting on.
    assert.deepEqual(safe.submits, [
      { intentId: "root-1", approved: true, awaitingApprover: ROOT_SAFE },
    ]);
    // And the keyring path was not: no `resolveIntent` was signed here.
    assert.deepEqual(state.resolved, []);
  });

  it("refuses a bare request and plans no Safe transaction", async () => {
    const safe: SafeState = { submits: [], relay: true };
    const { app, state } = buildApp({ rootAuth: safePasskeyAuth(credential()), safe });
    const res = await post(app, "/intents/resolve", { intentId: "root-1", approved: true });
    assert.equal(res.status, 401);
    assert.equal(((await res.json()) as { error: string }).error, "root_proof_required");
    assert.deepEqual(safe.submits, []);
    assert.deepEqual(state.resolved, []);
  });

  it("refuses an assertion the authenticator did not verify the user for", async () => {
    const cred = credential();
    const rootAuth = safePasskeyAuth(cred);
    const safe: SafeState = { submits: [], relay: true };
    const { app, state } = buildApp({ rootAuth, safe });
    const challenge = rootAuth.issueChallenge("intent:approve", "root-1", SAFE_CHALLENGE);
    const res = await post(app, "/intents/resolve", {
      intentId: "root-1",
      approved: true,
      challenge: challenge.challenge,
      rootProof: assertFor(cred, challenge.challenge, 0x01),
    });
    assert.equal(res.status, 401);
    assert.equal(((await res.json()) as { error: string }).error, "user_not_verified");
    assert.deepEqual(safe.submits, []);
    assert.deepEqual(state.resolved, []);
  });

  it("refuses a stranger's authenticator wearing the root's credential id", async () => {
    const cred = credential();
    const rootAuth = safePasskeyAuth(cred);
    const safe: SafeState = { submits: [], relay: true };
    const { app, state } = buildApp({ rootAuth, safe });
    const challenge = rootAuth.issueChallenge("intent:approve", "root-1", SAFE_CHALLENGE);
    const res = await post(app, "/intents/resolve", {
      intentId: "root-1",
      approved: true,
      challenge: challenge.challenge,
      rootProof: {
        ...assertFor(credential(), challenge.challenge),
        credentialId: cred.credentialId,
      },
    });
    assert.equal(res.status, 401);
    assert.deepEqual(safe.submits, []);
    assert.deepEqual(state.resolved, []);
  });

  it("surfaces the Safe's own refusal without touching the keyring", async () => {
    const cred = credential();
    const rootAuth = safePasskeyAuth(cred);
    const safe: SafeState = {
      submits: [],
      relay: true,
      refuseWith: "root_safe_not_passkey_owned: owners drifted",
    };
    const { app, state } = buildApp({ rootAuth, safe });
    const challenge = rootAuth.issueChallenge("intent:approve", "root-1", SAFE_CHALLENGE);
    const res = await post(app, "/intents/resolve", {
      intentId: "root-1",
      approved: true,
      challenge: challenge.challenge,
      rootProof: assertFor(cred, challenge.challenge),
    });
    assert.equal(res.status, 401);
    assert.match(((await res.json()) as { error: string }).error, /root_safe_not_passkey_owned/);
    assert.deepEqual(state.resolved, []);
  });

  it("hands back the transaction, and records nothing, when it may not relay", async () => {
    const cred = credential();
    const rootAuth = safePasskeyAuth(cred);
    const safe: SafeState = { submits: [], relay: false };
    const { app, state } = buildApp({ rootAuth, safe });
    const challenge = rootAuth.issueChallenge("intent:approve", "root-1", SAFE_CHALLENGE);
    const res = await post(app, "/intents/resolve", {
      intentId: "root-1",
      approved: true,
      challenge: challenge.challenge,
      rootProof: assertFor(cred, challenge.challenge),
    });
    assert.equal(res.status, 409);
    const body = (await res.json()) as {
      error: string;
      transaction: { to: string; data: string; value: string };
    };
    assert.equal(body.error, "safe_exec_unsigned");
    assert.equal(body.transaction.to, ROOT_SAFE);
    assert.equal(body.transaction.data, "0xdeadbeef");
    // Handing someone a transaction is not a spend that happened.
    assert.deepEqual(state.resolved, []);
  });

  it("leaves manager-depth approvals on the ordinary keyring path", async () => {
    const safe: SafeState = { submits: [], relay: true };
    const { app, state } = buildApp({ rootAuth: safePasskeyAuth(credential()), safe });
    const res = await post(app, "/intents/resolve", { intentId: "mgr-1", approved: true });
    assert.equal(res.status, 200);
    assert.deepEqual(safe.submits, []);
    assert.deepEqual(state.resolved, [{ id: "mgr-1", approved: true, approver: MANAGER }]);
  });
});

describe("POST /intents/confirm — the chain decides, not the browser", () => {
  it("records nothing while the chain still awaits the approver", async () => {
    const safe: SafeState = { submits: [], relay: false };
    const { app } = buildApp({ rootAuth: safePasskeyAuth(credential()), safe });
    const res = await post(app, "/intents/confirm", {
      intentId: "root-1",
      approved: true,
      txHash: `0x${"11".repeat(32)}`,
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { confirmed: boolean; awaitingApprover: string };
    assert.equal(body.confirmed, false);
    assert.equal(body.awaitingApprover, ROOT_SAFE);
  });

  it("confirms once the intent is no longer pending", async () => {
    const safe: SafeState = { submits: [], relay: false };
    const { app, state } = buildApp({ rootAuth: safePasskeyAuth(credential()), safe });
    // The browser's transaction landed: the router no longer awaits anyone.
    state.pending = state.pending.filter((i) => i.id !== "root-1");
    const res = await post(app, "/intents/confirm", {
      intentId: "root-1",
      approved: true,
      txHash: `0x${"11".repeat(32)}`,
    });
    const body = (await res.json()) as {
      confirmed: boolean;
      authorizedBy: string;
      approver: string;
    };
    assert.equal(body.confirmed, true);
    assert.equal(body.authorizedBy, "root:safe-passkey");
    assert.equal(body.approver, ROOT_SAFE);
  });
});
