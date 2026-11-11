/**
 * Sandbox mode: the orchestrator on the in-process simulator, with no chain.
 *
 * What is pinned here is as much about what a sandbox is not as what it is.
 * It is opted into by name and is never what a runtime falls back to; it
 * labels everything it serves, names its writes by `simTxId` and never by
 * `txHash`, keeps its activity out of the counts a billing meter reads, and
 * refuses by name whatever only a chain can do. And an orchestrator on a
 * chain behaves exactly as it did, with the simulator's controls refused.
 *
 * Every request goes through the HTTP app, which is the surface a control
 * plane drives.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ADDRESS_ENV_VARS,
  ANVIL_CHAIN_ID,
  DEFAULT_SESSION_TTL_MS,
  type ProtocolEvent,
} from "@lacrew/core";
import { PolicyDeniedError } from "@lacrew/sdk";
import { createLacrewClient } from "@lacrew/sdk/testing";
import { createMemoryAuditStore, type AuditStore } from "./auditStore.js";
import { createFlowsSurface } from "./flows.js";
import { createMemoryFlowStore } from "./flowStore.js";
import { createOrchestratorApp } from "./httpApp.js";
import { createRuntimeMcpBackend } from "./mcpBackend.js";
import { MemoryModelProvider } from "./model/index.js";
import { InMemoryQueue } from "./queue/index.js";
import type { RootAuthSurface } from "./rootAuth.js";
import { CrewRuntime, createRuntimeFromEnv, createSandboxRuntime } from "./runtime.js";
import {
  DEFAULT_SANDBOX_ROOT,
  SANDBOX_MAX_ADVANCE_SECONDS,
  SANDBOX_MAX_FUND,
  SandboxLedger,
  createMemorySandboxStateStore,
} from "./sandboxLedger.js";

type Json = Record<string, any>;
const addr = (n: string) => `0x${n.repeat(40)}` as `0x${string}`;
const TARGET = addr("7");
const USDC = (n: number) => (BigInt(n) * 10n ** 6n).toString();

/** A root-auth surface that refuses everything: no caller holds a proof. */
const REFUSING_ROOT_AUTH = {
  required: true,
  kind: "wallet",
  safeAddress: undefined,
  status: () => ({
    required: true,
    kind: "wallet",
    configError: null,
    pendingChallenges: 0,
    challengeTtlSec: 300,
  }),
  issueChallenge: () => ({ challenge: "nonce", expiresAt: new Date().toISOString() }),
  verify: async () => ({ ok: false as const, error: "root_proof_required", status: 401 as const }),
} as unknown as RootAuthSurface;

function appFor(runtime: CrewRuntime, options: { rootAuth?: RootAuthSurface } = {}) {
  const model = new MemoryModelProvider();
  const mcpBackend = createRuntimeMcpBackend(runtime);
  const app = createOrchestratorApp({
    runtime,
    queue: new InMemoryQueue(),
    model,
    flows: createFlowsSurface({ runtime, model, mcpBackend, store: createMemoryFlowStore() }),
    mcpBackend,
    mcpUseMock: false,
    isDbReady: () => false,
    isDbConfigured: () => false,
    ...(options.rootAuth ? { rootAuth: options.rootAuth } : {}),
  });
  const send = async (method: string, path: string, body?: unknown) => {
    const res = await app.request(path, {
      method,
      ...(body === undefined
        ? {}
        : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
    });
    return { status: res.status, body: (await res.json()) as Json };
  };
  return {
    get: (path: string) => send("GET", path),
    post: (path: string, body: unknown = {}) => send("POST", path, body),
    put: (path: string, body: unknown = {}) => send("PUT", path, body),
  };
}

type Api = ReturnType<typeof appFor>;

/** Every key named `txHash` anywhere in a response, however deep. */
function txHashesIn(value: unknown, found: unknown[] = []): unknown[] {
  if (Array.isArray(value)) for (const item of value) txHashesIn(item, found);
  else if (value && typeof value === "object") {
    for (const [key, inner] of Object.entries(value)) {
      if (key === "txHash" && inner != null) found.push(inner);
      txHashesIn(inner, found);
    }
  }
  return found;
}

/** A simulated write: 200, labelled, named by a `simTxId`, with no `txHash` anywhere. */
function assertSimulatedWrite(res: { status: number; body: Json }, what: string): void {
  assert.equal(res.status, 200, `${what}: ${JSON.stringify(res.body)}`);
  assert.equal(res.body.ledger, "sandbox", `${what} is labelled`);
  assert.deepEqual(txHashesIn(res.body), [], `${what} carries no txHash`);
}

/** Propose, vote and execute one governance action; the caller stands in for the root. */
async function govern(api: Api, path: string, body: Json): Promise<Json> {
  const proposed = await api.post(path, body);
  assertSimulatedWrite(proposed, path);
  assert.match(proposed.body.simTxId, /^simtx_\d+$/, `${path} is named by a simTxId`);
  const voted = await api.post("/governance/vote", {
    proposalId: proposed.body.proposalId,
    support: true,
  });
  assertSimulatedWrite(voted, "vote");
  assert.equal(voted.body.simTxIds.length, 1);
  assert.deepEqual(voted.body.txHashes, []);
  const executed = await api.post("/governance/execute", { proposalId: proposed.body.proposalId });
  assertSimulatedWrite(executed, "execute");
  assert.match(executed.body.simTxId, /^simtx_\d+$/);
  assert.equal(executed.body.proposal.state, "executed");
  return proposed.body;
}

const spend = (api: Api, agent: string, value: string) =>
  api.post("/mcp/call", {
    name: "lacrew_propose_intent",
    arguments: { agent, target: TARGET, value },
  });

/** A funded org with one worker under the root, a grant, a whitelisted target and one epoch run. */
async function hiredAndFunded(api: Api): Promise<{ worker: `0x${string}` }> {
  assertSimulatedWrite(await api.post("/sandbox/fund", { amount: USDC(1000) }), "fund");
  const hire = await govern(api, "/governance/propose-hire", { label: "researcher" });
  const worker = hire.account as `0x${string}`;
  await govern(api, "/governance/propose-set-grant", { account: worker, amount: USDC(100) });
  await govern(api, "/governance/propose-set-whitelist", { target: TARGET, allowed: true });
  const epoch = await api.post("/epoch");
  assertSimulatedWrite(epoch, "epoch");
  assert.equal(epoch.body.epochError, undefined, JSON.stringify(epoch.body));
  return { worker };
}

async function withEnv<T>(
  vars: Record<string, string | undefined>,
  run: () => Promise<T>,
): Promise<T> {
  const cleared = [
    "LACREW_MODE",
    "ANVIL_RPC",
    "RPC_URL",
    "PRIVATE_KEY",
    "CHAIN_ID",
    "DATABASE_URL",
  ];
  const keys = [...new Set([...cleared, ...Object.keys(vars)])];
  const before = keys.map((key) => [key, process.env[key]] as const);
  for (const key of keys) delete process.env[key];
  for (const [key, value] of Object.entries(vars)) {
    if (value !== undefined) process.env[key] = value;
  }
  try {
    return await run();
  } finally {
    for (const [key, value] of before) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe("sandbox mode is chosen by name, never fallen back to", () => {
  it("is still unavailable with no RPC and no flag", async () => {
    const boot = await withEnv({}, createRuntimeFromEnv);
    assert.equal(boot.ok, false);
    assert.equal(boot.ok === false && boot.reason, "no_rpc");
  });

  it("is still unavailable with no RPC when the mode is spelled chain", async () => {
    const boot = await withEnv({ LACREW_MODE: "chain" }, createRuntimeFromEnv);
    assert.equal(boot.ok === false && boot.reason, "no_rpc");
  });

  it("still fails a chain-mode runtime whose chain is dead", async () => {
    // A complete address book on a chain nothing answers for: the failure is
    // the unreachable endpoint, and no simulator is offered in its place.
    const book = Object.fromEntries(
      Object.values(ADDRESS_ENV_VARS).map((name, i) => [
        name,
        `0x${(i + 1).toString(16).padStart(40, "0")}`,
      ]),
    );
    const boot = await withEnv(
      {
        ...book,
        ANVIL_RPC: "http://127.0.0.1:1",
        PRIVATE_KEY: `0x${"1".repeat(64)}`,
        CHAIN_ID: "31338",
      },
      createRuntimeFromEnv,
    );
    assert.equal(boot.ok, false);
    assert.equal(boot.ok === false && boot.reason, "rpc_unreachable");
  });

  it("refuses a mode it does not know instead of guessing one", async () => {
    const boot = await withEnv({ LACREW_MODE: "demo" }, createRuntimeFromEnv);
    assert.equal(boot.ok === false && boot.reason, "invalid_mode");
  });

  it("boots the simulator only for LACREW_MODE=sandbox, and needs no RPC or key for it", async () => {
    const boot = await withEnv({ LACREW_MODE: "sandbox" }, createRuntimeFromEnv);
    assert.equal(boot.ok, true);
    if (!boot.ok) return;
    assert.equal(boot.runtime.mode, "sandbox");
    assert.equal(boot.runtime.ledger, "sandbox");
    assert.equal(boot.runtime.chainId, null);
    assert.equal(boot.runtime.sandbox?.storeName, "memory");
  });

  it("ignores an RPC that is also set: the flag decides, not what happens to be reachable", async () => {
    const boot = await withEnv(
      { LACREW_MODE: "sandbox", ANVIL_RPC: "http://127.0.0.1:1" },
      createRuntimeFromEnv,
    );
    assert.equal(boot.ok && boot.runtime.mode, "sandbox");
  });

  it("refuses a malformed sandbox root", async () => {
    const boot = await withEnv(
      { LACREW_MODE: "sandbox", LACREW_SANDBOX_ROOT: "root" },
      createRuntimeFromEnv,
    );
    assert.equal(boot.ok === false && boot.reason, "invalid_mode");
  });

  it("cannot be constructed half-way: the mode and the simulator come together", () => {
    const client = createLacrewClient({ useMock: true });
    assert.throws(() => new CrewRuntime({ client, mode: "sandbox" }), /sandbox CrewRuntime/);
    assert.throws(
      () => new CrewRuntime({ sandbox: new SandboxLedger(), mode: "onchain" }),
      /sandbox CrewRuntime/,
    );
    assert.throws(
      () => new CrewRuntime({ client, sandbox: new SandboxLedger(), mode: "sandbox" }),
      /sandbox CrewRuntime/,
    );
    assert.throws(() => new CrewRuntime({}), /needs a client/);
  });
});

describe("sandbox genesis and labels", () => {
  it("starts empty: one root node, no treasury, no fixtures", async () => {
    const api = appFor(createSandboxRuntime());
    const org = await api.get("/org");
    assert.deepEqual(org.body.nodes, [
      { account: DEFAULT_SANDBOX_ROOT, kind: "human_root", parent: null, active: true },
    ]);
    const status = await api.get("/sandbox");
    assert.equal(status.status, 200);
    assert.equal(status.body.treasury.total, "0");
    assert.equal(status.body.root, DEFAULT_SANDBOX_ROOT);
    assert.deepEqual((await api.get("/intents")).body.intents, []);
    assert.deepEqual((await api.get("/sessions")).body.sessions, []);
    assert.deepEqual((await api.get("/governance/proposals")).body.proposals, []);
  });

  it("reports the mode and the ledger on /health, and claims no chain", async () => {
    const { status, body } = await appFor(createSandboxRuntime()).get("/health");
    assert.equal(status, 200);
    assert.equal(body.mode, "sandbox");
    assert.equal(body.ledger, "sandbox");
    assert.equal(body.mocked, false);
    assert.equal(body.chainId, null);
    assert.deepEqual(body.chain, { reachable: false, chainId: null });
    assert.equal(body.sandbox.simulated, true);
    assert.equal(body.sandbox.store, "memory");
    assert.deepEqual(body.rootAuth, {
      required: false,
      kind: null,
      configError: null,
      simulated: true,
    });
  });

  it("labels every response, including refusals", async () => {
    const api = appFor(createSandboxRuntime());
    for (const path of ["/org", "/intents", "/sessions", "/audit", "/usage", "/epoch"]) {
      assert.equal((await api.get(path)).body.ledger, "sandbox", path);
    }
    const missing = await api.get("/no-such-route");
    assert.equal(missing.status, 404);
    assert.equal(missing.body.ledger, "sandbox");
  });

  it("serves the simulator's status: ledger, clock, treasury, version, limits", async () => {
    const before = Math.floor(Date.now() / 1000);
    const { body } = await appFor(createSandboxRuntime()).get("/sandbox");
    assert.equal(body.ledger, "sandbox");
    assert.equal(body.simulated, true);
    assert.equal(body.mode, "sandbox");
    assert.equal(body.orgId, "default");
    assert.equal(body.version, 0);
    assert.equal(body.clock.offsetSeconds, 0);
    assert.ok(body.clock.now >= before && body.clock.now <= before + 5);
    assert.equal(body.clock.nowIso, new Date(body.clock.now * 1000).toISOString());
    assert.deepEqual(
      {
        total: body.treasury.total,
        liquid: body.treasury.liquid,
        reserved: body.treasury.reserved,
      },
      { total: "0", liquid: "0", reserved: "0" },
    );
    assert.equal(body.treasury.decimals, 6);
    assert.equal(body.store, "memory");
    assert.deepEqual(body.limits, {
      maxFund: SANDBOX_MAX_FUND.toString(),
      maxAdvanceSeconds: SANDBOX_MAX_ADVANCE_SECONDS,
    });
  });
});

describe("sandbox story over HTTP", () => {
  it("funds, hires through governance, grants, streams, spends, escalates and approves", async () => {
    const api = appFor(createSandboxRuntime());

    // Play money, credited to the treasury and nowhere else.
    const funded = await api.post("/sandbox/fund", { amount: USDC(1000) });
    assertSimulatedWrite(funded, "fund");
    assert.match(funded.body.simTxId, /^simtx_\d+$/);
    assert.equal(funded.body.amount, USDC(1000));
    assert.equal(funded.body.treasury.total, USDC(1000));
    assert.deepEqual((await api.get("/treasury/balances")).body.balances[0].total, USDC(1000));

    // A hire is a governance proposal: propose, vote, execute.
    const hire = await govern(api, "/governance/propose-hire", { label: "researcher" });
    const worker = hire.account as string;
    const org = await api.get("/org");
    assert.deepEqual(
      org.body.nodes.map((n: Json) => [n.kind, n.parent, n.active]),
      [
        ["human_root", null, true],
        ["worker_agent", DEFAULT_SANDBOX_ROOT, true],
      ],
    );
    assert.equal(org.body.nodes[1].account, worker);

    // A grant and a whitelisted target, each its own proposal.
    await govern(api, "/governance/propose-set-grant", { account: worker, amount: USDC(100) });
    await govern(api, "/governance/propose-set-whitelist", { target: TARGET, allowed: true });

    // The epoch streams the grant into the worker's allowance.
    const epoch = await api.post("/epoch");
    assertSimulatedWrite(epoch, "epoch");
    assert.equal(epoch.body.epoch, 1);
    assert.match(epoch.body.simTxId, /^simtx_\d+$/);
    assert.equal((await api.get("/epoch")).body.currentEpoch, 1);

    // Inside the cap and the allowance: the simulated stack allows it.
    const allowed = await spend(api, worker, USDC(10));
    assertSimulatedWrite(allowed, "in-allowance spend");
    assert.equal(allowed.body.result.verdict, "ALLOW");
    assert.match(allowed.body.result.simTxId, /^simtx_\d+$/);
    assert.deepEqual((await api.get("/intents")).body.intents, []);

    // Over the 50 USDC cap: the same stack escalates it to the worker's parent.
    const escalated = await spend(api, worker, USDC(75));
    assertSimulatedWrite(escalated, "over-cap spend");
    assert.equal(escalated.body.result.verdict, "ESCALATE");
    const pending = (await api.get("/intents")).body.intents;
    assert.equal(pending.length, 1);
    assert.equal(pending[0].id, escalated.body.result.intentId);
    assert.equal(pending[0].awaitingApprover, DEFAULT_SANDBOX_ROOT);
    // The pending intent is enriched from the simulator, with a dry-run of the approval.
    assert.notEqual(pending[0].simulation.status, "revert");
    assert.ok(
      pending[0].simulation.warnings.some((w: string) => /dry-run succeeded \(simulated/.test(w)),
    );

    // The root approves. No signature exists, and the response says so.
    const approved = await api.post("/intents/resolve", {
      intentId: pending[0].id,
      approved: true,
    });
    assertSimulatedWrite(approved, "approval");
    assert.match(approved.body.simTxId, /^simtx_\d+$/);
    assert.equal(approved.body.authorizedBy, "root:simulated");
    assert.equal(approved.body.simulated, true);
    assert.equal(approved.body.approver, DEFAULT_SANDBOX_ROOT);
    assert.equal(approved.body.escalated, false);
    assert.equal(approved.body.intent.approved, true);
    assert.deepEqual((await api.get("/intents")).body.intents, []);

    // Both spends left the worker's allowance: 100 streamed, 10 + 75 spent.
    const policies = await api.get("/policies");
    assert.equal(policies.status, 200);
    const status = await api.get("/sandbox");
    assert.equal(status.body.treasury.total, USDC(1000 - 85));
  });

  it("names a revert by the contract's own error", async () => {
    const api = appFor(createSandboxRuntime());
    // Nothing is pending, so there is nothing for anyone to execute.
    const res = await api.post("/governance/execute", { proposalId: "99" });
    assert.equal(res.status, 422, JSON.stringify(res.body));
    assert.equal(res.body.reverted, true);
    assert.equal(res.body.simulated, true);
    assert.equal(res.body.ledger, "sandbox");
    assert.match(res.body.error, /^[A-Z][A-Za-z]+$/);
  });

  it("names the policy module behind a denied propose", async () => {
    const api = appFor(createSandboxRuntime());
    const { worker } = await hiredAndFunded(api);
    const stranger = addr("8");
    const res = await api.post("/mcp/call", {
      name: "lacrew_propose_intent",
      arguments: { agent: worker, target: stranger, value: USDC(1) },
    });
    assert.equal(res.status, 422, JSON.stringify(res.body));
    assert.equal(res.body.error, "UnexpectedVerdict");
    assert.equal(res.body.reverted, true);
    assert.equal(res.body.simulated, true);
    assert.equal(res.body.verdict, "DENY");
    const policies = (await api.get("/policies")).body;
    assert.equal(res.body.denial.kind, "whitelist");
    assert.equal(res.body.denial.reason, "target_not_allowlisted");
    assert.equal(res.body.denial.target, stranger);
    assert.match(res.body.denial.detail, /is not on the allowlist/);
    assert.ok(
      JSON.stringify(policies).includes(res.body.denial.module),
      "the module named is one of the org's own",
    );
    // Any other revert carries no verdict and no denial.
    const other = await api.post("/governance/execute", { proposalId: "99" });
    assert.equal(other.body.verdict, undefined);
    assert.equal("denial" in other.body, false);
  });

  it("serves each node's remaining allowance beside its grant, and moves it with a spend", async () => {
    const api = appFor(createSandboxRuntime());
    const { worker } = await hiredAndFunded(api);
    const row = async () =>
      ((await api.get("/allowances")).body.allowances as Json[]).find(
        (entry) => entry.account === worker,
      );
    const before = await row();
    assert.equal(before?.remaining, USDC(100));
    assert.equal(before?.grant, USDC(100));
    assert.equal(before?.epoch, 1);
    assert.match(before?.token, /^0x[0-9a-f]{40}$/);

    assert.equal((await spend(api, worker, USDC(10))).body.result?.verdict, "ALLOW");
    const after = await row();
    assert.equal(after?.remaining, USDC(90), "the spend left the allowance");
    assert.equal(after?.grant, USDC(100), "the grant is the per-period figure, unchanged");

    // The same figures on the two reads a control plane already makes.
    const org = (await api.get("/org")).body;
    assert.equal(org.allowancesAvailable, true);
    const { account: _account, ...figures } = after as Json;
    assert.deepEqual(
      (org.nodes as Json[]).find((node) => node.account === worker)?.allowance,
      figures,
    );
    assert.deepEqual((await api.get("/governance/grants")).body.grants, [
      { account: worker, amount: USDC(100), remaining: USDC(90) },
    ]);
    const unknownAsset = await api.get("/allowances?asset=WETH");
    assert.equal(unknownAsset.status, 400, JSON.stringify(unknownAsset.body));
  });

  it("issues a session key and expires it when time is advanced", async () => {
    const api = appFor(createSandboxRuntime());
    const { worker } = await hiredAndFunded(api);

    const booted = await api.post("/boot", { agent: worker });
    assertSimulatedWrite(booted, "boot");
    const first = booted.body.session;
    const now = (await api.get("/sandbox")).body.clock.now as number;
    // Expiry is counted on the simulator's clock.
    assert.ok(Math.abs(first.expiresAt - (now * 1000 + DEFAULT_SESSION_TTL_MS)) < 5_000);
    assert.deepEqual(
      (await api.get("/sessions")).body.sessions.map((s: Json) => [s.keyId, s.revoked]),
      [[first.keyId, false]],
    );

    const seconds = DEFAULT_SESSION_TTL_MS / 1000 + 60;
    const advanced = await api.post("/sandbox/time/advance", { seconds });
    assertSimulatedWrite(advanced, "advance");
    assert.equal(advanced.body.advancedSeconds, seconds);
    assert.equal(advanced.body.clock.offsetSeconds, seconds);
    assert.ok(advanced.body.clock.now >= now + seconds);

    // The simulated registry no longer honours the key.
    assert.deepEqual(
      (await api.get("/sessions")).body.sessions.map((s: Json) => [s.keyId, s.revoked]),
      [[first.keyId, true]],
    );
    // And the next spend is carried by a fresh one rather than the lapsed key.
    const after = await spend(api, worker, USDC(5));
    assert.equal(after.body.result.verdict, "ALLOW", JSON.stringify(after.body));
    const sessions = (await api.get("/sessions")).body.sessions as Json[];
    assert.equal(sessions.filter((s) => !s.revoked).length, 1);
    assert.notEqual(sessions.find((s) => !s.revoked)?.keyId, first.keyId);
  });

  it("revokes and rotates a session as the simulated root, and says so", async () => {
    const api = appFor(createSandboxRuntime());
    const { worker } = await hiredAndFunded(api);
    const { session } = (await api.post("/boot", { agent: worker })).body;

    const rotated = await api.post("/sessions/rotate", { sessionId: session.keyId });
    assertSimulatedWrite(rotated, "rotate");
    assert.equal(rotated.body.authorizedBy, "root:simulated");
    assert.equal(rotated.body.simulated, true);
    assert.match(rotated.body.revoked.simTxId, /^simtx_\d+$/);

    const revoked = await api.post("/sessions/revoke", { sessionId: rotated.body.session.keyId });
    assertSimulatedWrite(revoked, "revoke");
    assert.equal(revoked.body.authorizedBy, "root:simulated");
    assert.equal(revoked.body.simulated, true);
    assert.match(revoked.body.simTxId, /^simtx_\d+$/);

    const root = await api.get("/root-auth");
    assert.equal(root.body.required, false);
    assert.equal(root.body.simulated, true);
    const challenge = await api.post("/root-auth/challenge", {
      action: "session:revoke",
      subject: "1",
    });
    assert.deepEqual(
      { required: challenge.body.required, simulated: challenge.body.simulated },
      { required: false, simulated: true },
    );
  });

  it("does not consult a configured root proof: the caller stands in for the root", async () => {
    // The same surface that refuses every chain-mode call below.
    const api = appFor(createSandboxRuntime(), { rootAuth: REFUSING_ROOT_AUTH });
    const { worker } = await hiredAndFunded(api);
    const { session } = (await api.post("/boot", { agent: worker })).body;
    const revoked = await api.post("/sessions/revoke", { sessionId: session.keyId });
    assert.equal(revoked.status, 200, JSON.stringify(revoked.body));
    assert.equal(revoked.body.authorizedBy, "root:simulated");
  });

  it("bounds the controls", async () => {
    const api = appFor(createSandboxRuntime());
    for (const [amount, error] of [
      [undefined, "invalid_amount"],
      ["ten", "invalid_amount"],
      ["0", "invalid_amount"],
      ["-5", "invalid_amount"],
      [(SANDBOX_MAX_FUND + 1n).toString(), "amount_too_large"],
    ] as const) {
      const res = await api.post("/sandbox/fund", { amount });
      assert.equal(res.status, 400, `${amount}`);
      assert.equal(res.body.error, error, `${amount}`);
    }
    assert.equal(
      (await api.post("/sandbox/fund", { amount: SANDBOX_MAX_FUND.toString() })).status,
      200,
    );

    for (const [seconds, error] of [
      [undefined, "invalid_seconds"],
      ["60", "invalid_seconds"],
      [0, "invalid_seconds"],
      [-1, "invalid_seconds"],
      [1.5, "invalid_seconds"],
      [SANDBOX_MAX_ADVANCE_SECONDS + 1, "seconds_too_large"],
    ] as const) {
      const res = await api.post("/sandbox/time/advance", { seconds });
      assert.equal(res.status, 400, `${seconds}`);
      assert.equal(res.body.error, error, `${seconds}`);
    }
    assert.equal((await api.get("/sandbox")).body.clock.offsetSeconds, 0);
  });
});

describe("sandbox rows, events and meters", () => {
  it("stamps every audit event, and names none of them by a txHash", async () => {
    const api = appFor(createSandboxRuntime());
    const { worker } = await hiredAndFunded(api);
    await spend(api, worker, USDC(10));
    const { events } = (await api.get("/audit")).body as { events: Json[] };
    assert.ok(events.length > 10);
    assert.deepEqual(
      events.filter((e) => e.ledger !== "sandbox"),
      [],
    );
    assert.deepEqual(txHashesIn(events), []);
    for (const type of [
      "SandboxFunded",
      "ProposalExecuted",
      "AllowanceStreamed",
      "AllowanceSpent",
    ]) {
      assert.ok(
        events.some((e) => e.type === type && /^simtx_\d+$/.test(e.payload.simTxId)),
        `${type} carries a simTxId`,
      );
    }
  });

  it("labels intent and session rows, and keeps the simTxId beside them", async () => {
    const api = appFor(createSandboxRuntime());
    const { worker } = await hiredAndFunded(api);
    await spend(api, worker, USDC(10));
    const escalated = await spend(api, worker, USDC(75));
    await api.post("/intents/resolve", {
      intentId: escalated.body.result.intentId,
      approved: true,
    });

    const intents = (await api.get("/intents/history")).body.intents as Json[];
    assert.equal(intents.length, 2);
    for (const row of intents) {
      assert.equal(row.ledger, "sandbox");
      assert.match(row.simTxId, /^simtx_\d+$/);
      assert.equal(row.txHash, undefined);
      assert.equal(row.resolveTxHash, undefined);
    }
    const resolved = intents.find((row) => row.verdict === "ESCALATE")!;
    assert.equal(resolved.status, "approved");
    assert.match(resolved.resolveSimTxId, /^simtx_\d+$/);

    const sessions = (await api.get("/sessions/history")).body.sessions as Json[];
    assert.ok(sessions.length >= 1);
    for (const row of sessions) {
      assert.equal(row.ledger, "sandbox");
      assert.equal(row.mode, "sandbox");
    }
  });

  it("keeps simulated activity out of the counts a billing meter reads", async () => {
    const api = appFor(createSandboxRuntime());
    const { worker } = await hiredAndFunded(api);
    await spend(api, worker, USDC(10));

    const usage = await api.get("/usage?since=2000-01-01T00:00:00.000Z");
    assert.deepEqual(usage.body.counts, {}, "nothing billable happened");
    assert.ok(usage.body.sandboxCounts.AllowanceSpent >= 1);
    assert.ok(usage.body.sandboxCounts.ProposalExecuted >= 3);

    const daily = await api.get("/usage/daily");
    assert.equal(daily.status, 200);
    for (const day of daily.body.days as Json[]) assert.deepEqual(day.counts, {});
    assert.ok((daily.body.days as Json[]).some((d) => d.sandboxCounts.AllowanceSpent >= 1));
    // Gas is a chain's: unavailable, not zero.
    assert.deepEqual(daily.body.gas, { available: false, reason: "sandbox" });

    const byAgent = await api.get("/usage/daily?by=agent");
    for (const row of byAgent.body.agents as Json[]) assert.deepEqual(row.counts, {});
    assert.ok(
      (byAgent.body.agents as Json[]).some(
        (row) => row.agent === worker.toLowerCase() && row.sandboxCounts.AllowanceSpent >= 1,
      ),
    );
  });
});

describe("what only a chain can do", () => {
  it("answers needs_chain, by name, for every chain-only feature", async () => {
    const api = appFor(createSandboxRuntime());
    const { worker } = await hiredAndFunded(api);
    const refusals: Array<[string, Promise<{ status: number; body: Json }>]> = [
      ["faucet status", api.get("/faucet")],
      ["faucet top-up", api.post("/faucet/top-up", { account: worker })],
      [
        "marketplace purchase",
        api.post("/marketplace/purchase", { catalogId: "x", agent: worker }),
      ],
      ["marketplace listing", api.post("/marketplace/list", { catalogId: "x", price: "1" })],
      ["marketplace withdrawal", api.post("/marketplace/withdraw")],
      [
        "policy module deploy",
        api.post("/governance/propose-node-stack", {
          node: worker,
          modules: [{ kind: "rate_limit", maxActions: 2, windowSeconds: 60 }],
        }),
      ],
      [
        "policy module attach",
        api.post("/governance/attach-policy-module", { node: worker, listing: { kind: "x" } }),
      ],
      ["native balances", api.get("/agents/balances")],
      ["gas receipts", api.post("/usage/gas", { txHash: `0x${"ab".repeat(32)}` })],
      ["Safe approval", api.post("/intents/confirm", { intentId: "1", approved: true })],
    ];
    for (const [what, pending] of refusals) {
      const res = await pending;
      assert.equal(res.status, 409, `${what}: ${JSON.stringify(res.body)}`);
      assert.equal(res.body.error, "needs_chain", what);
      assert.match(res.body.detail, /needs a chain/, what);
      assert.equal(res.body.ledger, "sandbox", what);
    }
    // Reads that describe "nothing listed" stay answers, not refusals.
    const quote = await api.get("/marketplace/quote?catalogId=x");
    assert.equal(quote.status, 200);
    assert.equal(quote.body.listed, false);
  });
});

describe("sandbox reset", () => {
  it("rebuilds genesis and deletes the simulated trail, keeping directives and flows", async () => {
    const runtime = createSandboxRuntime();
    const api = appFor(runtime);
    const { worker } = await hiredAndFunded(api);
    await spend(api, worker, USDC(10));
    await api.post("/sandbox/time/advance", { seconds: 3600 });

    const brief = await api.put("/agents/brief", {
      agent: worker,
      layers: [{ label: "house rules", text: "Cite your sources." }],
    });
    assert.equal(brief.status, 200, JSON.stringify(brief.body));
    const [template] = (await api.get("/flows/templates")).body.templates as Json[];
    const saved = await api.post("/flows", { flow: { ...template!.definition, id: "kept-flow" } });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));

    const before = (await api.get("/sandbox")).body;
    const reset = await api.post("/sandbox/reset");
    assertSimulatedWrite(reset, "reset");
    assert.equal(reset.body.reset, true);
    assert.equal(reset.body.version, before.version + 1);
    assert.equal(reset.body.clock.offsetSeconds, 0);
    assert.equal(reset.body.treasury.total, "0");

    // Genesis again.
    assert.deepEqual(
      (await api.get("/org")).body.nodes.map((n: Json) => n.kind),
      ["human_root"],
    );
    assert.deepEqual((await api.get("/governance/proposals")).body.proposals, []);
    assert.deepEqual((await api.get("/sessions")).body.sessions, []);
    assert.equal((await api.get("/epoch")).body.currentEpoch, 0);

    // The trail of the simulation that was thrown away is gone with it.
    const events = (await api.get("/audit")).body.events as Json[];
    assert.deepEqual(
      events.map((e) => e.type),
      ["SandboxReset"],
    );
    assert.deepEqual((await api.get("/intents/history")).body.intents, []);
    assert.deepEqual((await api.get("/sessions/history")).body.sessions, []);
    assert.deepEqual((await api.get("/usage?since=2000-01-01T00:00:00.000Z")).body.sandboxCounts, {
      SandboxReset: 1,
    });

    // Configuration is not ledger state: it stays.
    const controls = (await api.get("/agents/controls")).body;
    assert.ok(JSON.stringify(controls).includes("Cite your sources."));
    assert.ok(((await api.get("/flows")).body.flows as Json[]).some((f) => f.id === "kept-flow"));

    // And the new simulation works from the start.
    const again = await hiredAndFunded(api);
    assert.equal((await spend(api, again.worker, USDC(10))).body.result.verdict, "ALLOW");
  });
});

describe("sandbox persistence", () => {
  it("resumes the stored simulation after a restart", async () => {
    const store = createMemorySandboxStateStore();
    const first = createSandboxRuntime({ store });
    assert.equal(await first.hydrateSandbox(), false, "nothing stored yet");
    const api = appFor(first);
    const { worker } = await hiredAndFunded(api);
    await spend(api, worker, USDC(10));
    await api.post("/sandbox/time/advance", { seconds: 7200 });
    const before = (await api.get("/sandbox")).body;
    assert.equal(before.persistError, undefined);
    assert.equal((await store.load())?.version, before.version);

    // A second process over the same store.
    const second = createSandboxRuntime({ store });
    assert.equal(await second.hydrateSandbox(), true);
    const resumed = appFor(second);
    const after = (await resumed.get("/sandbox")).body;
    assert.equal(after.version, before.version);
    assert.equal(after.clock.offsetSeconds, 7200);
    assert.deepEqual(after.treasury, before.treasury);
    assert.deepEqual((await resumed.get("/org")).body.nodes, (await api.get("/org")).body.nodes);
    assert.equal((await resumed.get("/epoch")).body.currentEpoch, 1);

    // It carries on from there: the worker hired before the restart can spend.
    const spent = await spend(resumed, worker, USDC(5));
    assert.equal(spent.body.result.verdict, "ALLOW", JSON.stringify(spent.body));
    assert.equal((await resumed.get("/sandbox")).body.version > before.version, true);
  });

  it("keeps the simulator's own events in the stored trail, each fact once", async () => {
    // A store that keeps what it is given, as Postgres does.
    const stored: ProtocolEvent[] = [];
    const auditStore: AuditStore = {
      ...createMemoryAuditStore(),
      append: async (event) => {
        stored.push(event);
      },
      recent: async (limit) => stored.slice(-limit),
    };
    const store = createMemorySandboxStateStore();
    const first = createSandboxRuntime({ store, auditStore });
    await first.hydrateSandbox();
    const api = appFor(first);
    const { worker } = await hiredAndFunded(api);
    const spent = await spend(api, worker, USDC(10));
    assert.equal(spent.body.result.verdict, "ALLOW", JSON.stringify(spent.body));

    const before = (await api.get("/audit")).body.events as Json[];
    const typesOf = (events: Json[], simTxId: string) =>
      events.filter((e) => e.payload.simTxId === simTxId).map((e) => e.type);
    // What only the simulator knows happened: the deposit behind a fund, the
    // execution behind a spend.
    const funded = before.find((e) => e.type === "SandboxFunded")!;
    assert.deepEqual(typesOf(before, funded.payload.simTxId).sort(), [
      "SandboxFunded",
      "TreasuryDeposit",
    ]);
    const spendTx = spent.body.result.simTxId as string;
    assert.ok(typesOf(before, spendTx).includes("ActionExecuted"));
    // What the runtime records itself is not recorded a second time.
    for (const type of ["ProposalCreated", "ProposalVoted", "ProposalExecuted", "AllowanceSpent"]) {
      const seen = before.filter((e) => e.type === type).map((e) => e.payload.simTxId);
      assert.ok(seen.length > 0, type);
      assert.equal(new Set(seen).size, seen.length, `${type} once per simulated transaction`);
    }
    assert.ok(before.every((e) => e.ledger === "sandbox"));

    // Reading the trail again adds nothing to it.
    const again = (await api.get("/audit")).body.events as Json[];
    assert.equal(again.length, before.length);
    await first.drain();
    assert.ok(stored.some((e) => e.type === "TreasuryDeposit" && e.ledger === "sandbox"));
    assert.equal(stored.length, before.length, "everything served is stored");

    // A second process over the same stores serves the same trail.
    const second = createSandboxRuntime({ store, auditStore });
    assert.equal(await second.hydrateSandbox(), true);
    await second.hydrateAudit();
    const after = (await appFor(second).get("/audit")).body.events as Json[];
    const key = (e: Json) => `${e.type}:${e.payload.simTxId ?? ""}:${e.payload.seq}`;
    assert.deepEqual(after.map(key).sort(), before.map(key).sort());
    assert.equal(stored.length, before.length, "and stores nothing twice");
  });

  it("records each fact once when a read settles the trail in the middle of a write", async () => {
    // A store that keeps what it is given under the identity it is given, as
    // Postgres does: an identity is stored once, and a record that supersedes
    // a key removes what was stored under it.
    let rows: Array<{ event: ProtocolEvent; key?: string; index?: number }> = [];
    let replaced = 0;
    const auditStore: AuditStore = {
      ...createMemoryAuditStore(),
      append: async (event, options) => {
        if (options?.supersedes) {
          const before = rows.length;
          rows = rows.filter((row) => row.key !== options.supersedes);
          replaced += before - rows.length;
        }
        const identity = options?.identity;
        if (identity && rows.some((r) => r.key === identity.key && r.index === identity.index)) {
          return;
        }
        rows.push({ event, ...(identity ? identity : {}) });
      },
      recent: async (limit) => rows.slice(-limit).map((row) => row.event),
    };
    const runtime = createSandboxRuntime({ auditStore });
    await runtime.hydrateSandbox();

    // The race, made certain: after every simulator transaction commits and
    // before the runtime records its own account of it, the trail is read.
    const client = runtime.sandbox!.client as unknown as Record<string, unknown>;
    const methods = Object.getOwnPropertyDescriptors(Object.getPrototypeOf(client) as object);
    let races = 0;
    for (const [name, descriptor] of Object.entries(methods)) {
      // Methods only: reading an accessor here would call it on the prototype.
      const method: unknown = descriptor.value;
      if (name === "constructor" || typeof method !== "function") continue;
      if (/^(get|read|simulate|check|list|as$)/.test(name)) continue;
      client[name] = (...args: unknown[]) => {
        const out = (method as (...a: unknown[]) => unknown).apply(client, args);
        if (!(out instanceof Promise)) return out;
        return out.then(async (value) => {
          races += 1;
          await runtime.audit();
          return value;
        });
      };
    }

    const api = appFor(runtime);
    const { worker } = await hiredAndFunded(api);
    const spent = await spend(api, worker, USDC(10));
    assert.equal(spent.body.result.verdict, "ALLOW", JSON.stringify(spent.body));
    assert.ok(races > 5, "reads ran inside the writes");

    const trail = (await api.get("/audit")).body.events as Json[];
    // What the runtime records itself appears once per simulated transaction,
    // although the simulator's copy of each was recorded first.
    for (const type of [
      "ProposalCreated",
      "ProposalVoted",
      "ProposalExecuted",
      "AllowanceStreamed",
      "AllowanceSpent",
    ]) {
      const seen = trail.filter((e) => e.type === type).map((e) => e.payload.simTxId);
      assert.ok(seen.length > 0, type);
      assert.equal(new Set(seen).size, seen.length, `${type} once per simulated transaction`);
    }
    assert.ok(replaced > 0, "the simulator's copies were replaced, in the store too");
    // What only the simulator knows is still there, once.
    assert.equal(trail.filter((e) => e.type === "TreasuryDeposit").length, 1);
    assert.equal(trail.filter((e) => e.type === "ActionExecuted").length, 1);

    await runtime.drain();
    const key = (e: Json | ProtocolEvent) =>
      `${e.type}:${String(e.payload.simTxId ?? "")}:${String(e.payload.seq)}`;
    assert.deepEqual(rows.map((row) => key(row.event)).sort(), trail.map(key).sort());

    // Settling again, and storing a simulator event again, change nothing.
    const stored = rows.length;
    await runtime.settleSandboxTrail();
    const copy = rows.find((row) => row.key !== undefined)!;
    await auditStore.append(copy.event, { identity: { key: copy.key!, index: copy.index! } });
    await runtime.drain();
    assert.equal(rows.length, stored);
    assert.equal(((await api.get("/audit")).body.events as Json[]).length, trail.length);
  });

  it("writes through on every committed call, one version each", async () => {
    const store = createMemorySandboxStateStore();
    const runtime = createSandboxRuntime({ store });
    await runtime.hydrateSandbox();
    const api = appFor(runtime);
    assert.equal((await store.load())?.version, 1, "genesis is stored");

    await api.post("/sandbox/fund", { amount: USDC(5) });
    assert.equal((await store.load())?.version, 2);
    await api.post("/sandbox/time/advance", { seconds: 10 });
    const stored = await store.load();
    assert.equal(stored?.version, 3);
    assert.equal(stored?.clockOffset, 10);
    // A refused call commits nothing.
    await api.post("/sandbox/fund", { amount: "0" });
    assert.equal((await store.load())?.version, 3);
  });

  it("reports a write that lost the version check instead of answering 200", async () => {
    const store = createMemorySandboxStateStore();
    const a = createSandboxRuntime({ store });
    await a.hydrateSandbox();
    const b = createSandboxRuntime({ store });
    await b.hydrateSandbox();
    const apiA = appFor(a);
    const apiB = appFor(b);

    assert.equal((await apiA.post("/sandbox/fund", { amount: USDC(100) })).status, 200);
    // B has not seen A's write: its own is discarded, and it adopts A's state.
    const lost = await apiB.post("/sandbox/fund", { amount: USDC(7) });
    assert.equal(lost.status, 409, JSON.stringify(lost.body));
    assert.equal(lost.body.error, "sandbox_conflict");
    assert.equal((await apiB.get("/sandbox")).body.treasury.total, USDC(100));
    // From the adopted state its next write lands.
    const retried = await apiB.post("/sandbox/fund", { amount: USDC(7) });
    assert.equal(retried.status, 200, JSON.stringify(retried.body));
    assert.equal(retried.body.treasury.total, USDC(107));
  });
});

describe("an orchestrator on a chain is unchanged", () => {
  /** Reads as onchain; answers only what these routes ask. */
  function chainRuntime(overrides: Record<string, unknown> = {}): CrewRuntime {
    const client = Object.assign(createLacrewClient({ useMock: true }), {
      publicClient: {},
      chainId: ANVIL_CHAIN_ID,
      addresses: { chainId: ANVIL_CHAIN_ID, sessionRegistry: addr("5"), humanRoot: addr("a") },
      revokeSession: async () => ({ txHash: `0x${"cd".repeat(32)}` as `0x${string}` }),
      ...overrides,
    });
    return new CrewRuntime({
      client,
      mode: "onchain",
      chainId: ANVIL_CHAIN_ID,
      workerAgent: addr("b"),
      managerAgent: addr("c"),
      spendTarget: addr("d"),
    });
  }

  it("answers not_sandbox on every simulator control, and starts no simulator", async () => {
    const runtime = chainRuntime();
    const api = appFor(runtime);
    for (const res of [
      await api.get("/sandbox"),
      await api.post("/sandbox/fund", { amount: USDC(1) }),
      await api.post("/sandbox/fund", {}),
      await api.post("/sandbox/time/advance", { seconds: 60 }),
      await api.post("/sandbox/time/advance", {}),
      await api.post("/sandbox/reset"),
    ]) {
      assert.equal(res.status, 409, JSON.stringify(res.body));
      assert.equal(res.body.error, "not_sandbox");
      assert.equal(res.body.ledger, undefined);
    }
    assert.equal(runtime.sandbox, undefined);
    assert.equal(await runtime.hydrateSandbox(), false);
  });

  it("reports the chain ledger on /health and adds no label elsewhere", async () => {
    const api = appFor(chainRuntime());
    const health = (await api.get("/health")).body;
    assert.equal(health.mode, "onchain");
    assert.equal(health.ledger, "chain");
    assert.deepEqual(health.chain, { reachable: true, chainId: ANVIL_CHAIN_ID });
    assert.equal(health.sandbox, undefined);
    assert.deepEqual(health.rootAuth, { required: false, kind: null, configError: null });
    for (const path of ["/org", "/intents", "/audit", "/usage", "/root-auth"]) {
      const { body } = await api.get(path);
      assert.equal(body.ledger, undefined, path);
      assert.equal(body.simulated, undefined, path);
    }
    assert.equal((await api.get("/usage")).body.sandboxCounts, undefined);
    assert.equal((await api.get("/usage/daily")).body.gas, undefined);
  });

  it("still demands the root proof a sandbox does not", async () => {
    const api = appFor(chainRuntime(), { rootAuth: REFUSING_ROOT_AUTH });
    for (const path of ["/sessions/revoke", "/sessions/rotate"]) {
      const res = await api.post(path, { sessionId: "1" });
      assert.equal(res.status, 401, `${path}: ${JSON.stringify(res.body)}`);
      assert.equal(res.body.error, "root_proof_required");
    }
  });

  it("names a chain write by its txHash and never by a simTxId", async () => {
    const api = appFor(chainRuntime());
    const res = await api.post("/sessions/revoke", { sessionId: "1", containment: true });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.txHash, `0x${"cd".repeat(32)}`);
    assert.equal(res.body.simTxId, undefined);
    assert.equal(res.body.simulated, undefined);
    assert.equal(res.body.ledger, undefined);
  });

  it("names the module behind a denied propose, with no simulator label", async () => {
    const denial = {
      module: addr("9"),
      kind: "time_window" as const,
      reason: "outside_time_window" as const,
      detail: "Outside the allowed time window (09:00-17:00 UTC; the ledger's clock reads 22:13).",
      startSecondOfDay: 32_400,
      endSecondOfDay: 61_200,
      secondOfDay: 80_000,
    };
    // The chain client's propose is what throws; the session issued ahead of
    // it needs a registry this stub does not have, so the denial starts here.
    const denying = (found: typeof denial | null) => {
      const runtime = chainRuntime();
      runtime.propose = async () => {
        throw new PolicyDeniedError(found);
      };
      return appFor(runtime);
    };
    const res = await spend(denying(denial), addr("b"), USDC(1));
    assert.equal(res.status, 422, JSON.stringify(res.body));
    assert.deepEqual(res.body, {
      error: "UnexpectedVerdict",
      reverted: true,
      verdict: "DENY",
      denial,
    });

    // A denial whose module could not be found afterwards is still a denial.
    const bare = await spend(denying(null), addr("b"), USDC(1));
    assert.equal(bare.status, 422, JSON.stringify(bare.body));
    assert.equal(bare.body.verdict, "DENY");
    assert.equal(bare.body.denial, null);
  });

  it("serves each node's remaining allowance beside its grant", async () => {
    const token = addr("e");
    const api = appFor(
      chainRuntime({
        getOrgTree: async () => [
          { account: addr("a"), kind: "human_root", parent: null, active: true },
          { account: addr("b"), kind: "worker_agent", parent: addr("a"), active: true },
        ],
        // The chain reports addresses in its own casing; the join ignores it.
        getAllowances: async () => [
          { node: addr("B"), token, balance: 40_000_000n, epoch: 3, cap: 25_000_000n },
        ],
        getGrants: async () => [
          { account: addr("b"), amount: USDC(100) },
          // A recipient the allowance read did not cover: unknown, not zero.
          { account: addr("f"), amount: USDC(5) },
        ],
      }),
    );
    const worker = {
      token,
      remaining: USDC(40),
      grant: USDC(100),
      cap: USDC(25),
      epoch: 3,
    };
    const allowances = await api.get("/allowances");
    assert.equal(allowances.status, 200, JSON.stringify(allowances.body));
    assert.deepEqual(allowances.body.allowances, [
      { account: addr("B"), ...worker },
      { account: addr("f"), token, remaining: null, grant: USDC(5), cap: null, epoch: null },
    ]);

    const org = (await api.get("/org")).body;
    assert.equal(org.allowancesAvailable, true);
    assert.deepEqual(
      org.nodes.map((node: Json) => node.allowance),
      [undefined, worker],
    );
    assert.deepEqual((await api.get("/governance/grants")).body.grants, [
      { account: addr("b"), amount: USDC(100), remaining: USDC(40) },
      { account: addr("f"), amount: USDC(5), remaining: null },
    ]);
  });

  it("serves the chart without allowances when that read fails, and says so", async () => {
    const api = appFor(
      chainRuntime({
        getAllowances: async () => {
          throw new Error("rpc down");
        },
      }),
    );
    const org = await api.get("/org");
    assert.equal(org.status, 200, JSON.stringify(org.body));
    assert.equal(org.body.allowancesAvailable, false);
    assert.ok(org.body.nodes.length > 0);
    assert.ok(org.body.nodes.every((node: Json) => node.allowance === undefined));
    const grants = (await api.get("/governance/grants")).body.grants as Json[];
    assert.ok(grants.length > 0 && grants.every((grant) => grant.remaining === null));
    assert.equal((await api.get("/allowances")).status, 400);
  });

  it("keeps the test client labelled as neither ledger", async () => {
    const runtime = new CrewRuntime({ client: createLacrewClient({ useMock: true }) });
    assert.equal(runtime.ledger, null);
    const health = (await appFor(runtime).get("/health")).body;
    assert.equal(health.mode, "mock");
    assert.equal(health.mocked, true);
    assert.equal(health.ledger, null);
  });
});
