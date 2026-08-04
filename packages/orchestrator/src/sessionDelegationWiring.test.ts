/**
 * Delegation-provider wiring (F1.3): boot issues an account-level delegation
 * alongside the SessionRegistry key, revoke disables it, and every failure
 * stays a recorded failure — a boot without a delegation must read as
 * exactly that, never as one that has it.
 *
 * The chain is faked (the provider contract mechanics are fork-verified in
 * @lacrew/adapter-wallet-metamask); what this file pins is the seam.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CrewRuntime } from "./runtime.js";
import { createLacrewClient } from "@lacrew/sdk/testing";
import {
  ANVIL_CHAIN_ID,
  MOCK_WORKER,
  type BuiltTx,
  type DelegationProvider,
  type SessionDelegation,
} from "@lacrew/core";

const SEAT = "0x5ea70000000000000000000000000000000000a1" as const;
const ROOT = "0x00000000000000000000000000000000000000d7" as `0x${string}`;

function fakeDelegation(sessionKey: `0x${string}`, deployed: boolean): SessionDelegation {
  return {
    provider: "metamask",
    seat: SEAT,
    seatDeployed: deployed,
    delegate: sessionKey,
    delegationManager: "0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3",
    chainId: 8453,
    budget: {
      kind: "erc20Total",
      token: "0x8335683Ba1a4dbcb2ea9b1dd2c260345b3062913",
      amount: "200000000",
    },
    expiresAtSec: Math.floor(Date.now() / 1000) + 3600,
    salt: MOCK_WORKER,
    signed: { signature: "0xsigned" },
  };
}

/** An onchain-shaped client whose session writes are all local fakes. */
function sessionClient(log: string[]) {
  const base = createLacrewClient({ useMock: true }) as unknown as Record<string, unknown>;
  let sessionSeq = 0;
  return {
    ...base,
    publicClient: {
      async getBalance() {
        return 10n ** 18n; // funded: fundSessionKey stays a no-op
      },
    },
    addresses: {
      chainId: ANVIL_CHAIN_ID,
      sessionRegistry: "0x00000000000000000000000000000000000000aa",
    },
    walletClient: { account: { address: ROOT } },
    async issueSession() {
      log.push("issueSession");
      return { sessionId: `s-${(sessionSeq += 1)}`, txHash: "0xissue" };
    },
    async revokeSession(id: string) {
      log.push(`revokeSession:${id}`);
      return { txHash: "0xrevoke" };
    },
    async sendBuiltTx(tx: BuiltTx) {
      log.push(`sendBuiltTx:${tx.to}`);
      return { txHash: "0xsent" };
    },
    async fundEth() {
      log.push("fundEth");
      return { txHash: "0xfund" };
    },
    // The class instance spread drops prototype methods; audit() and
    // listSessions() need these two.
    async getAuditTrail() {
      return [];
    },
    async getSessions() {
      log.push("getSessions");
      // Chain-shaped rows: what SessionRegistry knows, which excludes any
      // delegation — the overlay under test must add it.
      return [{ agent: MOCK_WORKER, keyId: "s-1", expiresAt: Date.now() + 3600_000, scopes: [] }];
    },
  };
}

function runtimeWith(provider: DelegationProvider | undefined, log: string[]) {
  return new CrewRuntime({
    client: sessionClient(log) as never,
    mode: "onchain",
    chainId: ANVIL_CHAIN_ID,
    workerAgent: MOCK_WORKER,
    managerAgent: "0x00000000000000000000000000000000000000b1",
    spendTarget: "0x00000000000000000000000000000000000000b2",
    ...(provider ? { delegations: provider } : {}),
  });
}

describe("session delegation wiring", () => {
  it("boot without a provider issues no delegation and claims none", async () => {
    const log: string[] = [];
    const session = await runtimeWith(undefined, log).boot();
    assert.equal(session.delegation, undefined);
  });

  it("boot attaches the issued delegation and audits it", async () => {
    const log: string[] = [];
    const issued: Array<{ agent: string; maxValue: bigint }> = [];
    const provider: DelegationProvider = {
      provider: "metamask",
      async issue(args) {
        issued.push({ agent: args.agent, maxValue: args.maxValue });
        return { delegation: fakeDelegation(args.sessionKey, true) };
      },
      async buildRevokeTx() {
        throw new Error("not expected here");
      },
    };
    const runtime = runtimeWith(provider, log);
    const session = await runtime.boot();
    assert.ok(session.delegation, "the session carries its delegation");
    assert.equal(session.delegation!.seat, SEAT);
    assert.equal(session.delegation!.delegate, session.keyAddress);
    assert.equal(issued.length, 1);
    // Budget bound to the session's own enforced ceiling.
    assert.equal(issued[0]!.maxValue.toString(), session.maxValue);
    const audit = await runtime.audit();
    assert.ok(audit.some((e) => e.type === "SessionDelegationIssued"));
    // Seat already deployed: no deploy broadcast happened.
    assert.ok(!log.some((l) => l.startsWith("sendBuiltTx")));
  });

  it("an undeployed seat's deploy tx is broadcast and seatDeployed flips only then", async () => {
    const log: string[] = [];
    const provider: DelegationProvider = {
      provider: "metamask",
      async issue(args) {
        return {
          delegation: fakeDelegation(args.sessionKey, false),
          seatDeployTx: {
            to: "0xfac70000000000000000000000000000000000ff",
            data: "0xdeadbeef",
            value: 0n,
          },
        };
      },
      async buildRevokeTx() {
        throw new Error("not expected here");
      },
    };
    const session = await runtimeWith(provider, log).boot();
    assert.equal(session.delegation!.seatDeployed, true);
    assert.ok(log.includes("sendBuiltTx:0xfac70000000000000000000000000000000000ff"));
  });

  it("a provider failure is audited and never fails the boot", async () => {
    const log: string[] = [];
    const provider: DelegationProvider = {
      provider: "metamask",
      async issue() {
        throw new Error("factory unreachable");
      },
      async buildRevokeTx() {
        throw new Error("not expected here");
      },
    };
    const runtime = runtimeWith(provider, log);
    const session = await runtime.boot();
    assert.equal(session.delegation, undefined);
    const audit = await runtime.audit();
    const failed = audit.find((e) => e.type === "SessionDelegationFailed");
    assert.ok(failed, "the failure is its own audit event");
    assert.match(String(failed!.payload.reason), /factory unreachable/);
  });

  it("listSessions overlays the delegation, stripped of its signature", async () => {
    const log: string[] = [];
    const provider: DelegationProvider = {
      provider: "metamask",
      async issue(args) {
        return { delegation: fakeDelegation(args.sessionKey, true) };
      },
      async buildRevokeTx() {
        throw new Error("not expected here");
      },
    };
    const runtime = runtimeWith(provider, log);
    const booted = await runtime.boot();
    const listed = await runtime.listSessions();
    const row = listed.find((s) => s.keyId === booted.keyId);
    assert.ok(row?.delegation, "the listed session carries its delegation");
    assert.equal(row!.delegation!.seat, SEAT);
    // The signature stays with the held record — read surfaces never need it.
    assert.equal(row!.delegation!.signed, undefined);
  });

  it("revoke disables the delegation through one root transaction", async () => {
    const log: string[] = [];
    const revoked: SessionDelegation[] = [];
    const provider: DelegationProvider = {
      provider: "metamask",
      async issue(args) {
        return { delegation: fakeDelegation(args.sessionKey, true) };
      },
      async buildRevokeTx(delegation, beneficiary) {
        revoked.push(delegation);
        assert.equal(beneficiary, ROOT);
        return { to: "0x0000000071727De22E5E9d8BAf0edAc6f37da032", data: "0x01", value: 0n };
      },
    };
    const runtime = runtimeWith(provider, log);
    const session = await runtime.boot();
    await runtime.revokeSessionById(session.keyId);
    assert.equal(revoked.length, 1);
    assert.ok(log.includes("sendBuiltTx:0x0000000071727De22E5E9d8BAf0edAc6f37da032"));
    const audit = await runtime.audit();
    assert.ok(audit.some((e) => e.type === "SessionDelegationDisabled"));
  });

  it("a failed disable is recorded as failed, with the expiry that still bounds it", async () => {
    const log: string[] = [];
    const provider: DelegationProvider = {
      provider: "metamask",
      async issue(args) {
        return { delegation: fakeDelegation(args.sessionKey, true) };
      },
      async buildRevokeTx() {
        throw new Error("entrypoint unreachable");
      },
    };
    const runtime = runtimeWith(provider, log);
    const session = await runtime.boot();
    // The protocol revoke must still succeed — it is the enforcement path.
    const { txHash } = await runtime.revokeSessionById(session.keyId);
    assert.equal(txHash, "0xrevoke");
    const audit = await runtime.audit();
    const failed = audit.find((e) => e.type === "SessionDelegationDisableFailed");
    assert.ok(failed);
    assert.equal(typeof failed!.payload.expiresAtSec, "number");
    assert.ok(!audit.some((e) => e.type === "SessionDelegationDisabled"));
  });
});
