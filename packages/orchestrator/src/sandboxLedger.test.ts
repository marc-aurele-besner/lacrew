/**
 * The sandbox ledger's state store and write-through, and the `ledger` column
 * that keeps simulated rows apart from chain rows.
 *
 * The memory store proves the logic; the Postgres cases are gated on
 * DATABASE_URL like every other store test and run in the Stores job, which
 * is the pass that proves the columns round-trip and the version check holds
 * in SQL.
 */

import assert from "node:assert/strict";
import { closeSharedDb, sharedDb } from "./dbPool.js";
import { after, describe, it } from "node:test";
import type { ProtocolEvent } from "@lacrew/core";
import { createPgAuditStore } from "./auditStore.js";
import { createSandboxRuntime } from "./runtime.js";
import { createMemoryRuntimeStore, createPgRuntimeStore } from "./runtimeStore.js";
import {
  SandboxControlError,
  SandboxLedger,
  createMemorySandboxStateStore,
  createPgSandboxStateStore,
  createSandboxStateStoreFromEnv,
  type SandboxStateStore,
} from "./sandboxLedger.js";

// One pool for the file, as one process has; closed so the runner can exit.
after(async () => closeSharedDb());

const PG = Boolean(process.env.DATABASE_URL);
/** An org of its own per run, so a shared database's other rows stay out. */
const uniqueOrg = () => `test-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
/** The org the tests below write under when they name no other. */
const orgId = uniqueOrg();

async function treasuryTotal(ledger: SandboxLedger): Promise<bigint> {
  return (await ledger.client.getTreasuryBalances())[0]!.total;
}

function storeContract(
  name: string,
  make: (orgId: string) => SandboxStateStore,
  skip: boolean,
): void {
  describe(`SandboxStateStore (${name})`, { skip }, () => {
    it("has nothing for an org never written", async () => {
      const store = make(uniqueOrg());
      try {
        assert.equal(await store.load(), null);
      } finally {
        await store.close();
      }
    });

    it("round-trips state, version and clock offset", async () => {
      const orgId = uniqueOrg();
      const store = make(orgId);
      try {
        const ledger = new SandboxLedger({ orgId, store });
        assert.equal(await ledger.hydrate(), false);
        await ledger.fund(250n);
        await ledger.advance(90);
        await ledger.flush();
        assert.equal(ledger.persistError, null);

        const stored = await store.load();
        assert.equal(stored?.version, 3, "genesis, fund, advance");
        assert.equal(stored?.clockOffset, 90);

        const resumed = new SandboxLedger({ orgId, store });
        assert.equal(await resumed.hydrate(), true);
        assert.equal(resumed.version, 3);
        assert.equal(resumed.clockOffset, 90);
        assert.equal(await treasuryTotal(resumed), 250n);
        assert.deepEqual(await resumed.client.getOrgTree(), await ledger.client.getOrgTree());
      } finally {
        await store.close();
      }
    });

    it("lands a write only against the version it read", async () => {
      const orgId = uniqueOrg();
      const store = make(orgId);
      try {
        const state = new SandboxLedger({ orgId }).client.snapshot();
        const record = (version: number) => ({ version, state, clockOffset: 0 });
        assert.equal(await store.save(record(1), 0), true, "first write inserts");
        assert.equal(await store.save(record(1), 0), false, "a second insert loses");
        assert.equal(await store.save(record(2), 1), true);
        assert.equal(await store.save(record(3), 1), false, "stale version loses");
        assert.equal((await store.load())?.version, 2);
      } finally {
        await store.close();
      }
    });

    it("keeps two orgs apart", async () => {
      const [a, b] = [uniqueOrg(), uniqueOrg()];
      const [storeA, storeB] = [make(a), make(b)];
      try {
        const first = new SandboxLedger({ orgId: a, store: storeA });
        const second = new SandboxLedger({ orgId: b, store: storeB });
        await first.hydrate();
        await second.hydrate();
        await first.fund(10n);
        await first.flush();
        assert.equal((await storeA.load())?.version, 2);
        assert.equal((await storeB.load())?.version, 1);
        assert.equal(await treasuryTotal(second), 0n);
      } finally {
        await storeA.close();
        await storeB.close();
      }
    });
  });
}

storeContract("memory", () => createMemorySandboxStateStore(), false);
storeContract("postgres", (orgId) => createPgSandboxStateStore({ db: sharedDb(), orgId }), !PG);

describe("SandboxLedger", () => {
  it("falls back to the memory store without DATABASE_URL", () => {
    const prev = process.env.DATABASE_URL;
    try {
      delete process.env.DATABASE_URL;
      assert.equal(createSandboxStateStoreFromEnv("default").name, "memory");
    } finally {
      if (prev !== undefined) process.env.DATABASE_URL = prev;
    }
  });

  it("starts from an empty genesis and counts one version per committed call", async () => {
    const ledger = new SandboxLedger();
    assert.equal(ledger.version, 0);
    assert.equal(await treasuryTotal(ledger), 0n);
    assert.equal((await ledger.client.getOrgTree()).length, 1);
    await ledger.fund(5n);
    assert.equal(ledger.version, 1);
    await ledger.client.proposeHire({ label: "worker" });
    assert.equal(ledger.version, 2);
    // A reverted call commits nothing and stores nothing.
    await assert.rejects(ledger.client.executeGovernance("42"));
    assert.equal(ledger.version, 2);
  });

  it("runs its clock ahead of wall time by exactly what was advanced", async () => {
    let wall = 1_800_000_000_000;
    const ledger = new SandboxLedger({ wallClock: () => wall });
    assert.equal(ledger.now(), 1_800_000_000);
    await ledger.advance(3600);
    assert.equal(ledger.now(), 1_800_003_600);
    wall += 5_000;
    assert.equal(ledger.now(), 1_800_003_605, "wall time still passes underneath");
    assert.equal(ledger.client.now(), ledger.now(), "the simulator reads the same clock");
  });

  it("refuses a control argument out of bounds", async () => {
    const ledger = new SandboxLedger();
    await assert.rejects(ledger.fund(0n), SandboxControlError);
    await assert.rejects(ledger.advance(0), SandboxControlError);
    await assert.rejects(ledger.advance(-10), SandboxControlError);
    assert.equal(ledger.version, 0);
  });

  it("adopts the stored state when another writer got there first", async () => {
    const store = createMemorySandboxStateStore();
    const a = new SandboxLedger({ store });
    await a.hydrate();
    const b = new SandboxLedger({ store });
    await b.hydrate();

    await a.fund(100n);
    await a.flush();
    await b.fund(7n);
    await b.fund(8n);
    await b.flush();

    assert.equal(b.conflicts, 1, "one lost check, however many writes were queued behind it");
    assert.equal(await treasuryTotal(b), 100n, "the stored state stands");
    assert.equal(b.version, a.version);
    assert.equal((await store.load())?.version, a.version, "nothing forked was written");
    assert.equal(a.conflicts, 0);
  });

  it("keeps serving, and says so, when the store cannot be written", async () => {
    let broken = true;
    const inner = createMemorySandboxStateStore();
    const store: SandboxStateStore = {
      ...inner,
      save: async (...args) => {
        if (broken) throw new Error("connection refused");
        return inner.save(...args);
      },
    };
    const ledger = new SandboxLedger({ store });
    await ledger.fund(5n);
    await ledger.flush();
    assert.equal(ledger.persistError, "connection refused");
    assert.equal(await treasuryTotal(ledger), 5n, "the simulator itself is unaffected");

    // The next write carries the whole state, so nothing is lost once it lands.
    broken = false;
    await ledger.fund(6n);
    await ledger.flush();
    assert.equal(ledger.persistError, null);
    const resumed = new SandboxLedger({ store });
    await resumed.hydrate();
    assert.equal(await treasuryTotal(resumed), 11n);
  });

  it("resets to genesis as one more version", async () => {
    const store = createMemorySandboxStateStore();
    const ledger = new SandboxLedger({ store });
    await ledger.hydrate();
    await ledger.fund(50n);
    await ledger.advance(60);
    const before = ledger.version;
    const old = ledger.client;
    await ledger.reset();
    assert.notEqual(ledger.client, old, "a reset replaces the simulator");
    assert.equal(ledger.version, before + 1);
    assert.equal(ledger.clockOffset, 0);
    assert.equal(await treasuryTotal(ledger), 0n);
    assert.equal((await store.load())?.version, before + 1);
  });
});

describe("the ledger column on runtime records (memory)", () => {
  it("keeps sandbox and chain records apart, and clears only the sandbox", async () => {
    const store = createMemoryRuntimeStore();
    const session = (keyId: string, ledger?: "sandbox") => ({
      keyId,
      agent: "0x2222222222222222222222222222222222222222",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      scopes: ["propose:intent"],
      mode: ledger ?? "onchain",
      status: "active",
      issuedAt: new Date().toISOString(),
      ...(ledger ? { ledger } : {}),
    });
    const intent = (intentId: string, ledger?: "sandbox") => ({
      intentId,
      agent: "0x2222222222222222222222222222222222222222",
      target: "0x4444444444444444444444444444444444444444",
      value: "1",
      verdict: "ESCALATE",
      status: "pending",
      proposedAt: new Date().toISOString(),
      ...(ledger ? { ledger } : {}),
    });
    // The same ids on both ledgers: a sandbox numbers from 1 as a chain does.
    await store.saveSession(session("1"));
    await store.saveSession(session("1", "sandbox"));
    await store.saveIntent(intent("1"));
    await store.saveIntent(intent("1", "sandbox"));

    assert.deepEqual(
      (await store.recentSessions(10)).map((s) => s.mode),
      ["onchain"],
    );
    assert.deepEqual(
      (await store.recentSessions(10, "sandbox")).map((s) => s.mode),
      ["sandbox"],
    );
    await store.markSessionRevoked("1", new Date().toISOString(), "sandbox");
    assert.equal((await store.recentSessions(10))[0]?.status, "active", "the chain key stands");
    assert.equal((await store.recentSessions(10, "sandbox"))[0]?.status, "revoked");

    await store.markIntentResolved("1", {
      status: "approved",
      resolveSimTxId: "simtx_00000009",
      resolvedAt: new Date().toISOString(),
      ledger: "sandbox",
    });
    assert.equal((await store.recentIntents(10))[0]?.status, "pending");
    const [simulated] = await store.recentIntents(10, "sandbox");
    assert.equal(simulated?.status, "approved");
    assert.equal(simulated?.resolveSimTxId, "simtx_00000009");

    await store.clearSandbox();
    assert.equal((await store.recentSessions(10)).length, 1);
    assert.equal((await store.recentIntents(10)).length, 1);
    assert.deepEqual(await store.recentSessions(10, "sandbox"), []);
    assert.deepEqual(await store.recentIntents(10, "sandbox"), []);
  });
});

describe("the ledger column (postgres)", { skip: !PG }, () => {
  it("counts and reads audit events per ledger, and never bills a sandbox row", async () => {
    // A chain id of its own, so this run sees only its own rows.
    const chainId = 1_000_000_000 + Math.floor(Math.random() * 1_000_000_000);
    const chain = createPgAuditStore({ db: sharedDb(), orgId, chainId });
    const sandbox = createPgAuditStore({ db: sharedDb(), orgId, chainId, ledger: "sandbox" });
    const event = (type: ProtocolEvent["type"], at: string): ProtocolEvent => ({
      type,
      at,
      payload: { agent: "0x1111111111111111111111111111111111111111" },
    });
    const from = "2026-05-01T00:00:00.000Z";
    const to = "2026-05-03T00:00:00.000Z";
    try {
      await chain.append(event("ActionExecuted", "2026-05-01T10:00:00.000Z"));
      await sandbox.append(event("ActionExecuted", "2026-05-01T11:00:00.000Z"));
      await sandbox.append(event("IntentCreated", "2026-05-02T11:00:00.000Z"));

      // The meter reads the chain-scoped store, where the simulated rows do not exist.
      assert.deepEqual(await chain.countByTypeSince(from), { ActionExecuted: 1 });
      assert.deepEqual(await chain.countByDayBetween(from, to), [
        { day: "2026-05-01", type: "ActionExecuted", count: 1 },
      ]);
      assert.equal((await chain.countByAgentBetween(from, to))?.length, 1);
      assert.deepEqual(
        (await chain.recent(10)).map((e) => e.ledger),
        [undefined],
      );

      assert.deepEqual(await sandbox.countByTypeSince(from), {
        ActionExecuted: 1,
        IntentCreated: 1,
      });
      assert.deepEqual(
        (await sandbox.recent(10)).map((e) => e.ledger),
        ["sandbox", "sandbox"],
      );
      assert.deepEqual(
        (await sandbox.between(from, to, 10))?.events.map((e) => e.ledger),
        ["sandbox", "sandbox"],
      );

      // A reset deletes the simulated rows and nothing else.
      await sandbox.clearSandbox();
      assert.deepEqual(await sandbox.recent(10), []);
      assert.deepEqual(await chain.countByTypeSince(from), { ActionExecuted: 1 });
    } finally {
      await chain.close();
      await sandbox.close();
    }
  });

  it("a sandbox runtime stores, labels, resumes and resets its own rows", async () => {
    const orgId = uniqueOrg();
    const stores: Array<{ close(): Promise<void> }> = [];
    const make = () => {
      const store = createPgSandboxStateStore({ db: sharedDb(), orgId });
      const auditStore = createPgAuditStore({ db: sharedDb(), orgId, ledger: "sandbox" });
      const runtimeStore = createPgRuntimeStore({ db: sharedDb(), orgId });
      stores.push(store, auditStore, runtimeStore);
      return createSandboxRuntime({ orgId, store, auditStore, runtimeStore });
    };
    const target = `0x${"7".repeat(40)}` as const;
    const since = "2000-01-01T00:00:00.000Z";
    /** Audit appends are not awaited by the runtime; wait for the store to show them. */
    const eventually = async (check: () => Promise<boolean>, what: string) => {
      for (let i = 0; i < 100; i++) {
        if (await check()) return;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.fail(`timed out waiting for ${what}`);
    };
    try {
      const first = make();
      // Other suites may have left simulated rows in a shared database.
      await first.sandboxReset();
      assert.equal(await first.hydrateSandbox(), true, "the reset stored a genesis");
      await first.sandboxFund(1_000_000_000n);
      const pass = async (proposalId: string) => {
        await first.voteGovernance(proposalId, true);
        await first.executeGovernance(proposalId);
      };
      const hire = await first.proposeHire({ label: "researcher" });
      await pass(hire.proposalId);
      await pass(
        (await first.proposeSetGrant({ account: hire.account, amount: 100_000_000n })).proposalId,
      );
      await pass((await first.proposeSetWhitelist({ target, allowed: true })).proposalId);
      await first.runEpoch();
      const spent = await first.propose({ agent: hire.account, target, value: 10_000_000n });
      assert.equal(spent.verdict, "ALLOW");
      await first.sandbox!.flush();
      assert.equal(first.sandbox!.persistError, null);

      // Counted from the full persisted trail, and none of it billable.
      await eventually(
        async () => ((await first.usage(since)).sandboxCounts?.AllowanceSpent ?? 0) >= 1,
        "the spend to be stored",
      );
      const usage = await first.usage(since);
      assert.equal(usage.store, "postgres");
      assert.equal(usage.complete, true);
      assert.deepEqual(usage.counts, {});
      assert.ok(usage.sandboxCounts!.SandboxFunded! >= 1);
      // A chain-ledger store reading the same table sees none of it.
      const chain = createPgAuditStore({ db: sharedDb(), orgId });
      stores.push(chain);
      assert.equal((await chain.countByTypeSince(since))?.SandboxFunded, undefined);

      // A second process resumes the simulation and its trail.
      const second = make();
      assert.equal(await second.hydrateSandbox(), true);
      assert.equal(second.sandbox!.version, first.sandbox!.version);
      assert.equal((await second.sandboxStatus()).treasury.total, "990000000");
      assert.ok((await second.hydrateAudit()) > 0);
      assert.ok((await second.audit()).every((e) => e.ledger === "sandbox"));
      const [intent] = await second.intentHistory(10);
      assert.equal(intent?.ledger, "sandbox");
      assert.match(intent?.simTxId ?? "", /^simtx_\d+$/);
      assert.equal(intent?.txHash, undefined);
      assert.ok((await second.sessionHistory(10)).every((s) => s.ledger === "sandbox"));
      assert.ok((await second.sessionHistory(10)).length >= 1);

      // Reset: genesis again, and the simulated rows are gone from the tables.
      await second.sandboxReset();
      assert.equal((await second.sandboxStatus()).treasury.total, "0");
      assert.deepEqual(await second.intentHistory(10), []);
      assert.deepEqual(await second.sessionHistory(10), []);
      await eventually(
        async () => (await second.usage(since)).sandboxCounts?.SandboxReset === 1,
        "the reset event to be stored",
      );
      assert.deepEqual((await second.usage(since)).sandboxCounts, { SandboxReset: 1 });
    } finally {
      for (const store of stores) await store.close();
    }
  });

  it("keys sessions by ledger and round-trips the simTxId columns", async () => {
    const store = createPgRuntimeStore({ db: sharedDb(), orgId });
    const keyId = `test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const intentId = `test-${keyId}`;
    const base = {
      keyId,
      agent: "0x2222222222222222222222222222222222222222",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      scopes: ["propose:intent"],
      status: "active",
      issuedAt: new Date().toISOString(),
    };
    try {
      // The same key id on both ledgers is two rows, not one overwritten.
      await store.saveSession({ ...base, mode: "onchain" });
      await store.saveSession({ ...base, mode: "sandbox", ledger: "sandbox" });
      const onChain = (await store.recentSessions(500)).find((s) => s.keyId === keyId);
      const simulated = (await store.recentSessions(500, "sandbox")).find((s) => s.keyId === keyId);
      assert.equal(onChain?.mode, "onchain");
      assert.equal(onChain?.ledger, "chain");
      assert.equal(simulated?.mode, "sandbox");
      assert.equal(simulated?.ledger, "sandbox");

      await store.markSessionRevoked(keyId, new Date().toISOString(), "sandbox");
      assert.equal(
        (await store.recentSessions(500)).find((s) => s.keyId === keyId)?.status,
        "active",
      );
      assert.equal(
        (await store.recentSessions(500, "sandbox")).find((s) => s.keyId === keyId)?.status,
        "revoked",
      );

      await store.saveIntent({
        intentId,
        agent: base.agent,
        target: "0x4444444444444444444444444444444444444444",
        value: "75000000",
        verdict: "ESCALATE",
        status: "pending",
        simTxId: "simtx_00000007",
        proposedAt: new Date().toISOString(),
        ledger: "sandbox",
      });
      await store.markIntentResolved(intentId, {
        status: "approved",
        resolveSimTxId: "simtx_00000008",
        resolvedAt: new Date().toISOString(),
        ledger: "sandbox",
      });
      assert.equal(
        (await store.recentIntents(500)).some((i) => i.intentId === intentId),
        false,
        "a sandbox intent is not in the chain history",
      );
      const row = (await store.recentIntents(500, "sandbox")).find((i) => i.intentId === intentId);
      assert.equal(row?.status, "approved");
      assert.equal(row?.ledger, "sandbox");
      assert.equal(row?.simTxId, "simtx_00000007");
      assert.equal(row?.resolveSimTxId, "simtx_00000008");
      assert.equal(row?.txHash, undefined);

      await store.clearSandbox();
      assert.equal(
        (await store.recentSessions(500, "sandbox")).some((s) => s.keyId === keyId),
        false,
      );
      assert.equal(
        (await store.recentIntents(500, "sandbox")).some((i) => i.intentId === intentId),
        false,
      );
      assert.equal(
        (await store.recentSessions(500)).some((s) => s.keyId === keyId),
        true,
        "the chain session is untouched",
      );
    } finally {
      await store.close();
    }
  });
});
