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

  it("returns null for unknown events", () => {
    assert.equal(logToProtocolEvent("SomethingElse", {}, TX, AT), null);
  });
});
