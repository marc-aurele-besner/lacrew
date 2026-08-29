import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  EventWatcher,
  logToProtocolEvent,
  transferToDepositEvent,
  transferToOutflowEvent,
} from "./watcher.js";
import type { AssetStack } from "@lacrew/core";
import { MemoryEventSink } from "./sinks/memory.js";
import { loadStore } from "./store.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const AT = "2026-07-18T00:00:00.000Z";
const TX = "0xabc";

describe("transferToDepositEvent", () => {
  const stack = {
    symbol: "USDC",
    token: "0x1111111111111111111111111111111111111111",
    decimals: 6,
    treasury: "0x2222222222222222222222222222222222222222",
    escalationRouter: "0x0000000000000000000000000000000000000000",
    epochStreamer: "0x0000000000000000000000000000000000000000",
  } as AssetStack;

  it("folds a transfer into the treasury as a deposit with its denomination", () => {
    const event = transferToDepositEvent(
      { from: "0xf", to: stack.treasury.toUpperCase(), value: 100_000_000n },
      stack,
      AT,
      TX,
    );
    assert.equal(event?.type, "TreasuryDeposit");
    assert.deepEqual(event?.payload, {
      from: "0xf",
      amount: "100000000",
      token: stack.token,
      symbol: "USDC",
      decimals: 6,
      treasury: stack.treasury,
      txHash: TX,
    });
  });

  it("folds a transfer out of the treasury as an outflow carrying its destination", () => {
    const event = transferToOutflowEvent(
      { from: stack.treasury.toUpperCase(), to: "0xdead", value: 5_000_000n },
      stack,
      AT,
      TX,
    );
    assert.equal(event?.type, "TreasuryOutflow");
    assert.equal(event?.payload.to, "0xdead");
    assert.equal(event?.payload.amount, "5000000");
    assert.equal(event?.payload.symbol, "USDC");
  });

  it("refuses an outflow whose source is not this stack's treasury", () => {
    const event = transferToOutflowEvent(
      { from: "0x3333333333333333333333333333333333333333", to: "0xdead", value: 1n },
      stack,
      AT,
      TX,
    );
    assert.equal(event, null);
  });

  it("refuses a transfer to anything but this stack's treasury", () => {
    // The subscription filters on `to`, but a deposit attributed to the wrong
    // treasury would be a fabricated inflow — the address is re-checked.
    const event = transferToDepositEvent(
      { from: "0xf", to: "0x3333333333333333333333333333333333333333", value: 1n },
      stack,
      AT,
      TX,
    );
    assert.equal(event, null);
  });
});

describe("logToProtocolEvent", () => {
  it("maps IntentCreated with stringified id", () => {
    const event = logToProtocolEvent(
      "IntentCreated",
      { intentId: 7n, agent: "0xa", awaitingApprover: "0xb" },
      TX,
      AT,
    );
    assert.equal(event?.type, "IntentCreated");
    assert.equal(event?.at, AT);
    assert.deepEqual(event?.payload, {
      intentId: "7",
      agent: "0xa",
      awaitingApprover: "0xb",
    });
  });

  it("maps ActionExecuted with stringified value and txHash", () => {
    const event = logToProtocolEvent(
      "ActionExecuted",
      { agent: "0xa", target: "0xb", value: 75000000n, callOk: true },
      TX,
      AT,
    );
    assert.equal(event?.type, "ActionExecuted");
    assert.equal(event?.payload.value, "75000000");
    assert.equal(event?.payload.txHash, TX);
  });

  it("maps SessionIssued expiry to milliseconds", () => {
    const event = logToProtocolEvent(
      "SessionIssued",
      {
        sessionId: 1n,
        agent: "0xa",
        key: "0xk",
        expiresAt: 1_752_800_000n,
        maxValue: 200000000n,
        allowedTarget: "0xt",
      },
      TX,
      AT,
    );
    assert.equal(event?.payload.expiresAt, 1_752_800_000_000);
    assert.equal(event?.payload.maxValue, "200000000");
  });

  // The contract event is `Voted`; the consumer schema slot is ProposalVoted.
  it("maps Voted onto ProposalVoted with stringified weight", () => {
    const event = logToProtocolEvent(
      "Voted",
      { proposalId: 3n, voter: "0xv", support: true, weight: 5n },
      TX,
      AT,
    );
    assert.equal(event?.type, "ProposalVoted");
    assert.deepEqual(event?.payload, {
      proposalId: "3",
      voter: "0xv",
      support: true,
      weight: "5",
      txHash: TX,
    });
  });

  it("maps a no-vote as support false rather than dropping it", () => {
    const event = logToProtocolEvent(
      "Voted",
      { proposalId: 4n, voter: "0xv", support: false, weight: 2n },
      TX,
      AT,
    );
    assert.equal(event?.payload.support, false);
  });

  it("maps ProposalDefeated", () => {
    const event = logToProtocolEvent("ProposalDefeated", { proposalId: 9n }, TX, AT);
    assert.equal(event?.type, "ProposalDefeated");
    assert.deepEqual(event?.payload, { proposalId: "9", txHash: TX });
  });

  it("returns null for unknown events", () => {
    assert.equal(logToProtocolEvent("SomethingElse", {}, TX, AT), null);
  });
});

describe("every event a watcher emits carries its chain id", () => {
  // Two indexer processes (one per CHAIN_ID) may share one DATABASE_URL. The
  // Postgres identity is (chain_id, tx_hash, log_index), so the same
  // (tx_hash, log_index) pair seen by two chains must reach the sink as two
  // events distinguished by chain — not collapse, and not cross-attribute.
  it("stamps the same log from two chains with each watcher's chain", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lacrew-watcher-"));
    const log = {
      eventName: "IntentResolved",
      args: { intentId: 1n, approved: true },
      transactionHash: TX,
      logIndex: 0,
      blockNumber: null,
    };

    const sinks: MemoryEventSink[] = [];
    for (const chainId of [11155111, 8453]) {
      const sink = new MemoryEventSink();
      sinks.push(sink);
      const watcher = new EventWatcher({
        rpcUrl: "http://127.0.0.1:1",
        storePath: join(dir, `store-${chainId}.json`),
        chainId,
        sinks: [sink],
      });
      await (
        watcher as unknown as { processLog: (log: unknown) => Promise<void> }
      ).processLog(log);
    }

    assert.equal(sinks[0]?.written[0]?.event.chainId, 11155111);
    assert.equal(sinks[1]?.written[0]?.event.chainId, 8453);
    // Same chain coordinates — only the chain id separates the two rows.
    assert.equal(sinks[0]?.written[0]?.txHash, sinks[1]?.written[0]?.txHash);
    assert.equal(sinks[0]?.written[0]?.logIndex, sinks[1]?.written[0]?.logIndex);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("an intent whose row cannot be read is not a zero-value spend", () => {
  it("marks it unreadable instead of inventing target and value", async () => {
    // Port 1 refuses, so `readContract` throws — the RPC blip / ABI mismatch
    // case. This used to record target 0x0000…0000 and value 0, which renders
    // in an approval queue as "0 USDC → 0x0000…0000": a spend request nobody
    // made, indistinguishable from one that was read successfully.
    const dir = mkdtempSync(join(tmpdir(), "lacrew-watcher-"));
    const storePath = join(dir, "store.json");
    const watcher = new EventWatcher({
      rpcUrl: "http://127.0.0.1:1",
      storePath,
      sinks: [],
    });

    await (
      watcher as unknown as {
        upsertFromChain: (
          id: bigint,
          agent: `0x${string}`,
          awaiting: `0x${string}`,
        ) => Promise<void>;
      }
    ).upsertFromChain(1n, "0xaaa" as `0x${string}`, "0xbbb" as `0x${string}`);

    const stored = loadStore(storePath);
    const intent = stored.pendingIntents[0];
    assert.equal(intent?.id, "1");
    // The intent is still listed — it exists and somebody is waiting on it.
    assert.equal(intent?.unreadable, true);
    rmSync(dir, { recursive: true, force: true });
  });
});
