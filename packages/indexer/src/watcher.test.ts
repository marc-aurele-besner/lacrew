import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { logToProtocolEvent } from "./watcher.js";

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
