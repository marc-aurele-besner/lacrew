/**
 * Gas capture and its place in the usage reads: what a sent transaction's
 * receipt turns into, which agent it is listed under, and how `/usage/daily`
 * and `/audit` serve it.
 *
 * The client is a fake that reads as onchain and reports write receipts the way
 * the SDK client does (`observeWrites`) — no chain is dialed. The SDK half, a
 * real receipt becoming that report, is tested against a stub transport in
 * `@lacrew/sdk` (onchainWrites.test.ts).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BASE_CHAIN_ID, type ProtocolEvent } from "@lacrew/core";
import type { WriteReceipt } from "@lacrew/sdk";
import { createLacrewClient } from "@lacrew/sdk/testing";
import type { McpToolBackend } from "@lacrew/adapter-agents-mcp";
import { createFlowsSurface } from "./flows.js";
import { createMemoryFlowStore } from "./flowStore.js";
import { createMemoryGasStore, type GasStore } from "./gasStore.js";
import { createOrchestratorApp } from "./httpApp.js";
import { MemoryModelProvider } from "./model/index.js";
import { InMemoryQueue } from "./queue/index.js";
import { CrewRuntime } from "./runtime.js";

const addr = (n: string) => `0x${n.repeat(40)}` as `0x${string}`;
const hash = (n: string) => `0x${n.repeat(32)}` as `0x${string}`;
const SIGNER = addr("e");
const ALICE = "0xAbCdEfabcdefABCDEFabcdefabcdefABCDEFabcd" as `0x${string}`;
const BOB = addr("b");
const ROUTER = addr("d");
const SAFE = addr("5");

type Receipt = Omit<WriteReceipt, "action" | "from" | "status"> & Partial<WriteReceipt>;

/** A runtime on a fake onchain client, plus the levers a test pulls on it. */
function gasRuntime(opts: { gasStore?: GasStore } = {}) {
  let observer: ((receipt: WriteReceipt) => void) | undefined;
  /** What `eth_getTransactionReceipt` answers, as viem formats it. */
  const chainReceipts = new Map<string, unknown>();
  /** What the router still awaits an approver on. */
  const pending: Array<{ id: string; awaitingApprover: `0x${string}` }> = [];
  const report = (receipt: Receipt) =>
    observer?.({ action: "governance propose", from: SIGNER, status: "success", ...receipt });
  const client = {
    getAuditTrail: async () => [],
    getPendingIntents: async () => pending,
    publicClient: {
      getTransactionReceipt: async ({ hash: h }: { hash: string }) => {
        const receipt = chainReceipts.get(h);
        if (!receipt) throw new Error("receipt not found");
        return receipt;
      },
    },
    chainId: BASE_CHAIN_ID,
    addresses: { chainId: BASE_CHAIN_ID, escalationRouter: ROUTER },
    observeWrites: (fn: (receipt: WriteReceipt) => void) => {
      observer = fn;
      return () => {};
    },
  } as unknown as NonNullable<ConstructorParameters<typeof CrewRuntime>[0]["client"]>;
  const runtime = new CrewRuntime({
    client,
    mode: "onchain",
    chainId: BASE_CHAIN_ID,
    workerAgent: BOB,
    managerAgent: addr("a"),
    spendTarget: addr("f"),
    ...(opts.gasStore ? { gasStore: opts.gasStore } : {}),
  });
  /**
   * A cap proposal for `agent`: the client sends one transaction, reports its
   * receipt, and the runtime raises an audit event naming the agent and hash.
   */
  const proposeFor = async (agent: `0x${string}`, receipt: Receipt) => {
    Object.assign(client, {
      proposeSetAgentCap: async () => {
        report(receipt);
        return { proposalId: "1", agent, txHash: receipt.txHash };
      },
    });
    await runtime.proposeSetAgentCap({ agent, cap: 1n });
  };
  return { runtime, report, proposeFor, chainReceipts, pending };
}

const NONE = { feeWei: "0", txCount: 0 };

/** The gas fields of a row whose every fee the orchestrator's own keys paid. */
function paidByOrchestrator(feeWei: string, txCount: number) {
  return {
    gasFeeWei: feeWei,
    gasTxCount: txCount,
    gasByPayer: {
      orchestrator: { feeWei, txCount },
      agent: NONE,
      approver: NONE,
      sponsored: NONE,
    },
  };
}

/** A window holding the present moment, since receipts are stamped as read. */
function today() {
  const now = Date.now();
  return {
    from: new Date(now - 60_000).toISOString(),
    to: new Date(now + 60_000).toISOString(),
    day: new Date(now).toISOString().slice(0, 10),
  };
}

function appFor(runtime: CrewRuntime) {
  const model = new MemoryModelProvider();
  return createOrchestratorApp({
    runtime,
    queue: new InMemoryQueue(),
    model,
    flows: createFlowsSurface({
      runtime,
      model,
      mcpBackend: {} as McpToolBackend,
      store: createMemoryFlowStore(),
    }),
    mcpUseMock: true,
    isDbReady: () => false,
    isDbConfigured: () => false,
  });
}

describe("gas capture", () => {
  it("sums the fee of every sent transaction into its UTC day", async () => {
    const { runtime, proposeFor, report } = gasRuntime();
    await proposeFor(ALICE, {
      txHash: hash("11"),
      gasUsed: 100_000n,
      effectiveGasPrice: 2_000_000_000n,
    });
    // A transaction no caller is handed a hash for — an approve, a deploy.
    report({ txHash: hash("22"), gasUsed: 50_000n, effectiveGasPrice: 1_000_000_000n });

    const { from, to, day } = today();
    const usage = await runtime.usageDaily(from, to);
    const bucket = usage.days.find((d) => d.day === day)!;
    assert.equal(bucket.gasFeeWei, "250000000000000");
    assert.equal(bucket.gasTxCount, 2);
    // The event counts are served exactly as before.
    assert.deepEqual(bucket.counts, { ProposalCreated: 1 });
    // No database: the ring answered, for the counts and for the gas.
    assert.equal(usage.complete, false);
    assert.equal(usage.gasComplete, false);
  });

  it("keeps a transaction whose receipt lacks an effective gas price out of both figures", async () => {
    const { runtime, proposeFor } = gasRuntime();
    await proposeFor(ALICE, { txHash: hash("11"), gasUsed: 100_000n, effectiveGasPrice: 3n });
    await proposeFor(ALICE, { txHash: hash("22"), gasUsed: 100_000n });

    const { from, to, day } = today();
    const daily = await runtime.usageDaily(from, to);
    const bucket = daily.days.find((d) => d.day === day)!;
    // Two transactions, two events — and one fee, because one is unknown.
    assert.deepEqual(bucket.counts, { ProposalCreated: 2 });
    assert.equal(bucket.gasFeeWei, "300000");
    assert.equal(bucket.gasTxCount, 1);

    const byAgent = await runtime.usageByAgent(from, to);
    assert.deepEqual(byAgent.agents, [
      {
        agent: ALICE.toLowerCase(),
        counts: { ProposalCreated: 2 },
        ...paidByOrchestrator("300000", 1),
      },
    ]);
  });

  it("adds an OP-stack L1 fee to the fee", async () => {
    const { runtime, report } = gasRuntime();
    report({ txHash: hash("11"), gasUsed: 100n, effectiveGasPrice: 10n, l1Fee: 234n });
    const { from, to, day } = today();
    const usage = await runtime.usageDaily(from, to);
    assert.equal(usage.days.find((d) => d.day === day)!.gasFeeWei, "1234");
  });

  it("counts one transaction once however many times it is reported", async () => {
    const { runtime, report } = gasRuntime();
    const receipt = { txHash: hash("ab"), gasUsed: 10n, effectiveGasPrice: 10n };
    report(receipt);
    // The same hash in another casing is the same transaction.
    report({ ...receipt, txHash: hash("AB") });
    const { from, to, day } = today();
    const bucket = (await runtime.usageDaily(from, to)).days.find((d) => d.day === day)!;
    assert.equal(bucket.gasFeeWei, "100");
    assert.equal(bucket.gasTxCount, 1);
  });

  it("counts a reverted transaction: it was paid for", async () => {
    const { runtime, report } = gasRuntime();
    report({ txHash: hash("11"), status: "reverted", gasUsed: 30_000n, effectiveGasPrice: 2n });
    const { from, to, day } = today();
    const bucket = (await runtime.usageDaily(from, to)).days.find((d) => d.day === day)!;
    assert.equal(bucket.gasFeeWei, "60000");
    assert.equal(bucket.gasTxCount, 1);
  });

  it("leaves transactions outside the window out", async () => {
    const { runtime, report } = gasRuntime();
    report({ txHash: hash("11"), gasUsed: 10n, effectiveGasPrice: 10n });
    const usage = await runtime.usageDaily("2026-03-01T00:00:00.000Z", "2026-03-03T00:00:00.000Z");
    assert.deepEqual(usage.days, [
      { day: "2026-03-01", counts: {}, ...paidByOrchestrator("0", 0) },
      { day: "2026-03-02", counts: {}, ...paidByOrchestrator("0", 0) },
    ]);
  });
});

describe("gas by agent", () => {
  it("lists a fee under the agent its audit event names, the rest under null", async () => {
    const { runtime, proposeFor, report } = gasRuntime();
    await proposeFor(ALICE, { txHash: hash("11"), gasUsed: 100n, effectiveGasPrice: 10n });
    await proposeFor(BOB, { txHash: hash("22"), gasUsed: 100n, effectiveGasPrice: 20n });
    await proposeFor(ALICE, { txHash: hash("33"), gasUsed: 100n, effectiveGasPrice: 30n });
    report({ txHash: hash("44"), gasUsed: 100n, effectiveGasPrice: 1n });

    const { from, to } = today();
    const usage = await runtime.usageByAgent(from, to);
    assert.deepEqual(usage.agents, [
      {
        agent: ALICE.toLowerCase(),
        counts: { ProposalCreated: 2 },
        ...paidByOrchestrator("4000", 2),
      },
      { agent: BOB, counts: { ProposalCreated: 1 }, ...paidByOrchestrator("2000", 1) },
      // No event named an agent for it; it still counts toward the total.
      { agent: null, counts: {}, ...paidByOrchestrator("100", 1) },
    ]);
    assert.equal(usage.gasComplete, false);
  });

  it("tells the store which agent a transaction was sent for", async () => {
    const appended: string[] = [];
    const attributed: Array<[number, string, string]> = [];
    const gasStore: GasStore = {
      ...createMemoryGasStore(),
      append: async (record) => {
        appended.push(`${record.chainId}:${record.txHash}:${record.feeWei}`);
      },
      attributeAgent: async (chainId, txHash, agent) => {
        attributed.push([chainId, txHash, agent]);
      },
    };
    const { proposeFor } = gasRuntime({ gasStore });
    await proposeFor(ALICE, { txHash: hash("11"), gasUsed: 100n, effectiveGasPrice: 10n });
    assert.deepEqual(appended, [`${BASE_CHAIN_ID}:${hash("11")}:1000`]);
    assert.deepEqual(attributed, [[BASE_CHAIN_ID, hash("11"), ALICE.toLowerCase()]]);
  });
});

describe("gas from a wired store", () => {
  const gasStore: GasStore = {
    ...createMemoryGasStore(),
    name: "postgres",
    sumByDayBetween: async () => [
      { day: "2026-03-02", payer: "orchestrator", feeWei: "36893488147419103232", txCount: 2 },
    ],
    sumByAgentBetween: async () => [
      { agent: ALICE.toLowerCase(), payer: "orchestrator", feeWei: "7", txCount: 1 },
      { agent: null, payer: "orchestrator", feeWei: "36893488147419103225", txCount: 1 },
    ],
  };

  it("serves the persisted daily sums as complete, zero-filled around them", async () => {
    const { runtime } = gasRuntime({ gasStore });
    const usage = await runtime.usageDaily("2026-03-01T00:00:00.000Z", "2026-03-04T00:00:00.000Z");
    assert.deepEqual(usage.days, [
      { day: "2026-03-01", counts: {}, ...paidByOrchestrator("0", 0) },
      // Past 2^64: served as the string the store summed, not a double.
      { day: "2026-03-02", counts: {}, ...paidByOrchestrator("36893488147419103232", 2) },
      { day: "2026-03-03", counts: {}, ...paidByOrchestrator("0", 0) },
    ]);
    assert.equal(usage.gasComplete, true);
    // The audit store here is the memory one; each figure answers for itself.
    assert.equal(usage.complete, false);
  });

  it("serves the persisted per-agent sums, null agent last", async () => {
    const { runtime } = gasRuntime({ gasStore });
    const usage = await runtime.usageByAgent(
      "2026-03-01T00:00:00.000Z",
      "2026-03-04T00:00:00.000Z",
    );
    assert.deepEqual(usage.agents, [
      { agent: ALICE.toLowerCase(), counts: {}, ...paidByOrchestrator("7", 1) },
      { agent: null, counts: {}, ...paidByOrchestrator("36893488147419103225", 1) },
    ]);
    assert.equal(usage.gasComplete, true);
  });
});

describe("gas by payer", () => {
  const OP_A = hash("a1");
  const OP_B = hash("a2");

  it("splits the day by who paid, and keeps sponsored fees out of the total", async () => {
    const { runtime, report } = gasRuntime();
    report({ txHash: hash("11"), gasUsed: 100n, effectiveGasPrice: 10n });
    // What a wallet adapter hands the sink after an agent's own send.
    runtime.gasReceiptSink({
      chainId: BASE_CHAIN_ID,
      txHash: hash("22"),
      kind: "goat send",
      status: "success",
      gasUsed: 50n,
      effectiveGasPrice: 10n,
      feeWei: 500n,
      payer: "agent",
      sender: BOB,
      agent: BOB,
    });
    runtime.gasReceiptSink({
      chainId: BASE_CHAIN_ID,
      txHash: hash("33"),
      kind: "safe resolve",
      status: "reverted",
      gasUsed: 7n,
      feeWei: 70n,
      payer: "approver",
    });
    // Two user operations in one bundle, both paid by a paymaster.
    for (const userOpHash of [OP_A, OP_B, OP_B]) {
      runtime.gasReceiptSink({
        chainId: BASE_CHAIN_ID,
        txHash: hash("44"),
        userOpHash,
        kind: "user operation",
        status: "success",
        gasUsed: 9n,
        feeWei: 9_000n,
        payer: "sponsored",
        paymaster: addr("c"),
        agent: BOB,
      });
    }

    const { from, to, day } = today();
    const bucket = (await runtime.usageDaily(from, to)).days.find((d) => d.day === day)!;
    // 1000 + 500 + 70: what somebody in the org paid.
    assert.equal(bucket.gasFeeWei, "1570");
    assert.equal(bucket.gasTxCount, 3);
    assert.deepEqual(bucket.gasByPayer, {
      orchestrator: { feeWei: "1000", txCount: 1 },
      agent: { feeWei: "500", txCount: 1 },
      approver: { feeWei: "70", txCount: 1 },
      // Each operation once, however often it was reported.
      sponsored: { feeWei: "18000", txCount: 2 },
    });

    // The reporter named the agent, so no audit event is needed to place it.
    const byAgent = await runtime.usageByAgent(from, to);
    const bob = byAgent.agents.find((row) => row.agent === BOB)!;
    assert.equal(bob.gasFeeWei, "500");
    assert.deepEqual(bob.gasByPayer.sponsored, { feeWei: "18000", txCount: 2 });
  });

  it("stores a receipt from another chain but does not add its wei to this one's", async () => {
    const appended: number[] = [];
    const gasStore: GasStore = {
      ...createMemoryGasStore(),
      append: async (record) => {
        appended.push(record.chainId);
      },
    };
    const { runtime } = gasRuntime({ gasStore });
    runtime.gasReceiptSink({
      chainId: 1,
      txHash: hash("11"),
      kind: "goat send",
      status: "success",
      gasUsed: 1n,
      feeWei: 1_000n,
      payer: "agent",
    });
    assert.deepEqual(appended, [1]);
    const { from, to, day } = today();
    const bucket = (await runtime.usageDaily(from, to)).days.find((d) => d.day === day)!;
    assert.equal(bucket.gasFeeWei, "0");
  });
});

describe("recordTransactionGas", () => {
  it("reads the receipt of a transaction sent outside the SDK client", async () => {
    const { runtime, chainReceipts } = gasRuntime();
    chainReceipts.set(hash("11"), {
      transactionHash: hash("11"),
      from: SIGNER,
      status: "success",
      gasUsed: 80_000n,
      effectiveGasPrice: 5n,
    });
    // As viem formats a receipt with no effective gas price.
    chainReceipts.set(hash("22"), {
      transactionHash: hash("22"),
      from: SIGNER,
      status: "success",
      gasUsed: 80_000n,
      effectiveGasPrice: null,
    });
    const relay = { kind: "safe resolve relay", payer: "orchestrator" } as const;
    assert.deepEqual(await runtime.recordTransactionGas(hash("11"), relay), {
      recorded: true,
      chainId: BASE_CHAIN_ID,
      txHash: hash("11"),
      payer: "orchestrator",
      status: "success",
      feeWei: "400000",
    });
    const priceless = await runtime.recordTransactionGas(hash("22"), relay);
    assert.equal(priceless.recorded && priceless.feeWei, null);
    // No receipt, no fee to state — and no throw into the approval.
    assert.deepEqual(await runtime.recordTransactionGas(hash("33"), relay), {
      recorded: false,
      reason: "receipt_not_found",
    });

    const { from, to, day } = today();
    const bucket = (await runtime.usageDaily(from, to)).days.find((d) => d.day === day)!;
    assert.equal(bucket.gasFeeWei, "400000");
    assert.equal(bucket.gasTxCount, 1);
  });

  it("refuses a hash whose transaction went somewhere else", async () => {
    const { runtime, chainReceipts } = gasRuntime();
    const mined = { from: SIGNER, status: "success", gasUsed: 10n, effectiveGasPrice: 10n };
    chainReceipts.set(hash("11"), { ...mined, transactionHash: hash("11"), to: addr("9") });
    chainReceipts.set(hash("22"), { ...mined, transactionHash: hash("22"), to: ROUTER });
    // A deployment: no `to`, and the contract it created is the target.
    chainReceipts.set(hash("33"), {
      ...mined,
      transactionHash: hash("33"),
      to: null,
      contractAddress: ROUTER,
    });
    const reported = {
      kind: "reported",
      payer: "approver",
      targets: [ROUTER.toUpperCase()],
    } as const;
    assert.deepEqual(await runtime.recordTransactionGas(hash("11"), reported), {
      recorded: false,
      reason: "unexpected_target",
    });
    assert.equal((await runtime.recordTransactionGas(hash("22"), reported)).recorded, true);
    assert.equal((await runtime.recordTransactionGas(hash("33"), reported)).recorded, true);

    const { from, to, day } = today();
    const bucket = (await runtime.usageDaily(from, to)).days.find((d) => d.day === day)!;
    assert.deepEqual(bucket.gasByPayer.approver, { feeWei: "200", txCount: 2 });
  });

  it("records nothing on a runtime with no chain", async () => {
    const runtime = new CrewRuntime({ client: createLacrewClient({ useMock: true }) });
    assert.deepEqual(
      await runtime.recordTransactionGas(hash("11"), { kind: "x", payer: "orchestrator" }),
      { recorded: false, reason: "no_chain" },
    );
    const { from, to } = today();
    for (const bucket of (await runtime.usageDaily(from, to)).days) {
      assert.equal(bucket.gasFeeWei, "0");
      assert.equal(bucket.gasTxCount, 0);
    }
  });
});

describe("a Safe approval the approver's own wallet sent", () => {
  const mined = { from: ALICE, gasUsed: 100n, effectiveGasPrice: 3n };

  it("records the reported transaction's fee as paid by the approver", async () => {
    const { runtime, chainReceipts } = gasRuntime();
    chainReceipts.set(hash("11"), {
      ...mined,
      transactionHash: hash("11"),
      to: SAFE,
      status: "success",
      logs: [],
    });
    const outcome = await runtime.confirmSafeResolve({
      intentId: "7",
      approved: true,
      approver: SAFE,
      txHash: hash("11"),
    });
    assert.equal(outcome.confirmed, true);
    assert.equal(outcome.gas?.recorded && outcome.gas.payer, "approver");

    const { from, to, day } = today();
    const bucket = (await runtime.usageDaily(from, to)).days.find((d) => d.day === day)!;
    assert.deepEqual(bucket.gasByPayer.approver, { feeWei: "300", txCount: 1 });
    assert.deepEqual(bucket.gasByPayer.orchestrator, NONE);
  });

  it("records a reverted one too, while the intent stays unconfirmed", async () => {
    const { runtime, chainReceipts, pending } = gasRuntime();
    pending.push({ id: "7", awaitingApprover: SAFE });
    chainReceipts.set(hash("11"), {
      ...mined,
      transactionHash: hash("11"),
      to: SAFE,
      status: "reverted",
      logs: [],
    });
    const outcome = await runtime.confirmSafeResolve({
      intentId: "7",
      approved: true,
      approver: SAFE,
      txHash: hash("11"),
    });
    assert.equal(outcome.confirmed, false);
    assert.equal(outcome.gas?.recorded && outcome.gas.status, "reverted");
  });

  it("does not charge the org for a hash that was not sent to the Safe", async () => {
    const { runtime, chainReceipts } = gasRuntime();
    chainReceipts.set(hash("11"), {
      ...mined,
      transactionHash: hash("11"),
      to: addr("9"),
      status: "success",
      logs: [],
    });
    const outcome = await runtime.confirmSafeResolve({
      intentId: "7",
      approved: true,
      approver: SAFE,
      txHash: hash("11"),
    });
    // The chain still says the intent settled; only the fee is not this org's.
    assert.equal(outcome.confirmed, true);
    assert.deepEqual(outcome.gas, { recorded: false, reason: "unexpected_target" });
    const { from, to, day } = today();
    const bucket = (await runtime.usageDaily(from, to)).days.find((d) => d.day === day)!;
    assert.equal(bucket.gasFeeWei, "0");
  });
});

describe("POST /usage/gas", () => {
  const post = (runtime: CrewRuntime, body: unknown) =>
    appFor(runtime).request("/usage/gas", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  it("records a reported transaction sent to this deployment", async () => {
    const { runtime, chainReceipts } = gasRuntime();
    chainReceipts.set(hash("11"), {
      transactionHash: hash("11"),
      from: ALICE,
      to: ROUTER,
      status: "success",
      gasUsed: 100n,
      effectiveGasPrice: 4n,
    });
    const res = await post(runtime, {
      txHash: hash("11"),
      kind: "cli governance vote",
      payer: "agent",
      agent: BOB,
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      recorded: true,
      chainId: BASE_CHAIN_ID,
      txHash: hash("11"),
      payer: "agent",
      status: "success",
      feeWei: "400",
    });
    const { from, to } = today();
    const bob = (await runtime.usageByAgent(from, to)).agents.find((row) => row.agent === BOB)!;
    assert.deepEqual(bob.gasByPayer.agent, { feeWei: "400", txCount: 1 });
  });

  it("defaults the payer to the operator's own keys", async () => {
    const { runtime, chainReceipts } = gasRuntime();
    chainReceipts.set(hash("11"), {
      transactionHash: hash("11"),
      to: ROUTER,
      status: "success",
      gasUsed: 1n,
      effectiveGasPrice: 1n,
    });
    const body = (await (await post(runtime, { txHash: hash("11") })).json()) as { payer: string };
    assert.equal(body.payer, "orchestrator");
  });

  it("refuses what it cannot verify", async () => {
    const { runtime, chainReceipts } = gasRuntime();
    chainReceipts.set(hash("11"), {
      transactionHash: hash("11"),
      to: addr("9"),
      status: "success",
      gasUsed: 1n,
      effectiveGasPrice: 1n,
    });
    const refusal = async (body: unknown) => {
      const res = await post(runtime, body);
      return [res.status, ((await res.json()) as { error: string }).error];
    };
    assert.deepEqual(await refusal({}), [400, "txHash_required"]);
    assert.deepEqual(await refusal({ txHash: "0x1234" }), [400, "txHash_required"]);
    // Sponsorship is a user operation's property; a transaction hash cannot prove it.
    assert.deepEqual(await refusal({ txHash: hash("11"), payer: "sponsored" }), [
      400,
      "invalid_payer",
    ]);
    assert.deepEqual(await refusal({ txHash: hash("11"), agent: "bob" }), [400, "invalid_agent"]);
    assert.deepEqual(await refusal({ txHash: hash("22") }), [404, "receipt_not_found"]);
    // Mined, but sent to nothing this deployment owns.
    assert.deepEqual(await refusal({ txHash: hash("11") }), [422, "unexpected_target"]);
  });

  it("answers 409 on a runtime with no chain", async () => {
    const runtime = new CrewRuntime({ client: createLacrewClient({ useMock: true }) });
    const res = await post(runtime, { txHash: hash("11") });
    assert.equal(res.status, 409);
  });
});

describe("GET /usage/daily gas fields", () => {
  it("adds gasFeeWei and gasTxCount to each day, beside the existing fields", async () => {
    const { runtime, proposeFor } = gasRuntime();
    await proposeFor(ALICE, { txHash: hash("11"), gasUsed: 100n, effectiveGasPrice: 10n });
    const { to, day } = today();
    const res = await appFor(runtime).request(`/usage/daily?to=${encodeURIComponent(to)}`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, unknown> & {
      days: Array<Record<string, unknown>>;
    };
    assert.deepEqual(Object.keys(body).sort(), [
      "complete",
      "days",
      "from",
      "gasComplete",
      "mode",
      "store",
      "to",
    ]);
    assert.deepEqual(
      body.days.find((d) => d.day === day),
      { day, counts: { ProposalCreated: 1 }, ...paidByOrchestrator("1000", 1) },
    );
    // Quiet days carry the fields too, as a string zero and a zero count.
    assert.deepEqual(body.days[0], {
      day: body.days[0]!.day,
      counts: {},
      ...paidByOrchestrator("0", 0),
    });
  });

  it("adds them to each agent row with ?by=agent", async () => {
    const { runtime, proposeFor } = gasRuntime();
    await proposeFor(ALICE, { txHash: hash("11"), gasUsed: 100n, effectiveGasPrice: 10n });
    const { to } = today();
    const res = await appFor(runtime).request(`/usage/daily?by=agent&to=${encodeURIComponent(to)}`);
    const body = (await res.json()) as { agents: unknown[]; gasComplete: boolean };
    assert.deepEqual(body.agents, [
      {
        agent: ALICE.toLowerCase(),
        counts: { ProposalCreated: 1 },
        ...paidByOrchestrator("1000", 1),
      },
    ]);
    assert.equal(body.gasComplete, false);
  });
});

describe("GET /audit chain id", () => {
  it("stamps each event with the chain the orchestrator is bound to", async () => {
    const { runtime, proposeFor } = gasRuntime();
    await proposeFor(ALICE, { txHash: hash("11"), gasUsed: 100n, effectiveGasPrice: 10n });
    const app = appFor(runtime);
    const health = (await (await app.request("/health")).json()) as { chainId: number };
    const body = (await (await app.request("/audit")).json()) as { events: ProtocolEvent[] };
    assert.equal(body.events.length, 1);
    assert.equal(body.events[0]!.type, "ProposalCreated");
    // The same id /health reports.
    assert.equal(body.events[0]!.chainId, BASE_CHAIN_ID);
    assert.equal(health.chainId, BASE_CHAIN_ID);
  });

  it("serves a row written before chain ids without one, and keeps a row's own", async () => {
    const old: ProtocolEvent = {
      type: "ActionExecuted",
      at: "2026-01-01T00:00:00.000Z",
      payload: { marker: "old" },
    };
    const foreign: ProtocolEvent = {
      type: "ActionExecuted",
      at: "2026-01-02T00:00:00.000Z",
      chainId: 31337,
      payload: { marker: "foreign" },
    };
    const client = {
      getAuditTrail: async () => [old, foreign],
      publicClient: {},
      chainId: BASE_CHAIN_ID,
      addresses: { chainId: BASE_CHAIN_ID },
    } as unknown as NonNullable<ConstructorParameters<typeof CrewRuntime>[0]["client"]>;
    const runtime = new CrewRuntime({
      client,
      mode: "onchain",
      chainId: BASE_CHAIN_ID,
      workerAgent: BOB,
      managerAgent: addr("a"),
      spendTarget: addr("f"),
    });
    const body = (await (await appFor(runtime).request("/audit")).json()) as {
      events: ProtocolEvent[];
    };
    const byMarker = (marker: string) => body.events.find((e) => e.payload.marker === marker)!;
    // Not guessed: an event that arrived without a chain is served without one.
    assert.equal("chainId" in byMarker("old"), false);
    assert.equal(byMarker("foreign").chainId, 31337);
  });

  it("carries no chain id on a runtime with no chain", async () => {
    const runtime = new CrewRuntime({ client: createLacrewClient({ useMock: true }) });
    const app = appFor(runtime);
    await app.request("/tick", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const body = (await (await app.request("/audit")).json()) as { events: ProtocolEvent[] };
    assert.ok(body.events.length > 0);
    for (const event of body.events) assert.equal(event.chainId, undefined);
  });
});
