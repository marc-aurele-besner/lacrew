import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventWatcher, logToProtocolEvent } from "./watcher.js";
import { loadStore } from "./store.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const AT = "2026-07-18T00:00:00.000Z";
const TX = "0xabc";

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
