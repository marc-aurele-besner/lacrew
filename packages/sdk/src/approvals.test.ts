/**
 * resolveIntentWithProof against a scripted orchestrator (PRD F2.6 / F1.3).
 *
 * Hermetic — fetchImpl is a stub, no orchestrator runs. What these tests pin
 * is the authorization choreography: which requests go out, what rides in
 * them, and that a proof the caller cannot produce is refused locally instead
 * of being "sent to see".
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { RootProof } from "@lacrew/core";
import {
  approveIntent,
  denyIntent,
  resolveIntentWithProof,
  SafeExecutionRequired,
} from "./approvals.js";
import { rootChallengeStatement } from "@lacrew/core";

const ROOT_ADDRESS = "0x1111111111111111111111111111111111111111" as const;

type Call = { url: string; body: Record<string, unknown>; headers: Record<string, string> };

/** A fetch stub that answers each POST from a script and records what it saw. */
function stubOrchestrator(responses: Array<{ status?: number; json: unknown }>): {
  fetchImpl: typeof fetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  let i = 0;
  const fetchImpl = (async (url: unknown, init?: RequestInit) => {
    calls.push({
      url: String(url),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    const scripted = responses[i++] ?? { status: 500, json: { error: "unscripted request" } };
    const status = scripted.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: "scripted",
      json: async () => scripted.json,
    } as Response;
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const noChallenge = { required: false, challenge: null, kind: null };

const walletChallenge = {
  required: true,
  kind: "wallet",
  challenge: "nonce-1",
  action: "intent:approve",
  subject: "7",
  expiresAt: 9999999999999,
  statement: rootChallengeStatement({
    action: "intent:approve",
    subject: "7",
    challenge: "nonce-1",
  }),
};

describe("resolveIntentWithProof", () => {
  it("resolves without any proof when the orchestrator requires none", async () => {
    const { fetchImpl, calls } = stubOrchestrator([
      { json: noChallenge },
      { json: { escalated: false, authorizedBy: "approver", approver: null, intent: {} } },
    ]);
    const result = await resolveIntentWithProof({
      intentId: "7",
      approved: true,
      url: "http://orch.local",
      fetchImpl,
    });
    assert.equal(result.authorizedBy, "approver");
    assert.equal(calls.length, 2);
    assert.equal(calls[0]!.url, "http://orch.local/root-auth/challenge");
    assert.deepEqual(calls[0]!.body, { action: "intent:approve", subject: "7" });
    assert.equal(calls[1]!.url, "http://orch.local/intents/resolve");
    // No challenge was issued, so no proof rides along — sending a stale or
    // invented one would be worse than sending none.
    assert.equal("rootProof" in calls[1]!.body, false);
  });

  it("signs a wallet root's statement locally and sends the proof", async () => {
    const signed: string[] = [];
    const { fetchImpl, calls } = stubOrchestrator([
      { json: walletChallenge },
      {
        json: { escalated: false, authorizedBy: "root:wallet", approver: ROOT_ADDRESS, intent: {} },
      },
    ]);
    const result = await resolveIntentWithProof({
      intentId: "7",
      approved: true,
      url: "http://orch.local",
      fetchImpl,
      rootAccount: {
        address: ROOT_ADDRESS,
        signMessage: async ({ message }) => {
          signed.push(message);
          return "0xsigned";
        },
      },
    });
    assert.equal(result.authorizedBy, "root:wallet");
    // The signature is over exactly the statement the orchestrator issued.
    assert.deepEqual(signed, [walletChallenge.statement]);
    const resolveBody = calls[1]!.body;
    assert.equal(resolveBody.challenge, "nonce-1");
    assert.deepEqual(resolveBody.rootProof, {
      kind: "wallet",
      address: ROOT_ADDRESS,
      signature: "0xsigned",
    });
  });

  it("passes through a proof collected elsewhere without needing a signer", async () => {
    const proof: RootProof = { kind: "wallet", address: ROOT_ADDRESS, signature: "0xelsewhere" };
    const { fetchImpl, calls } = stubOrchestrator([
      { json: walletChallenge },
      { json: { escalated: false, authorizedBy: "root:wallet", approver: null, intent: {} } },
    ]);
    await resolveIntentWithProof({
      intentId: "7",
      approved: false,
      url: "http://orch.local",
      fetchImpl,
      proof,
    });
    assert.deepEqual(calls[1]!.body.rootProof, proof);
    assert.equal(calls[1]!.body.approved, false);
  });

  it("refuses a passkey root locally instead of sending an unprovable request", async () => {
    const { fetchImpl, calls } = stubOrchestrator([
      { json: { ...walletChallenge, kind: "passkey" } },
    ]);
    await assert.rejects(
      () => resolveIntentWithProof({ intentId: "7", approved: true, url: "http://o", fetchImpl }),
      /root_proof_required.*passkey root/s,
    );
    // Only the challenge went out; nothing was sent "to see".
    assert.equal(calls.length, 1);
  });

  it("names the Safe when a safe-passkey root must sign elsewhere", async () => {
    const { fetchImpl } = stubOrchestrator([
      {
        json: {
          ...walletChallenge,
          kind: "safe-passkey",
          safeAddress: "0x5afe5afe5afe5afe5afe5afe5afe5afe5afe5afe",
        },
      },
    ]);
    await assert.rejects(
      () => resolveIntentWithProof({ intentId: "7", approved: true, url: "http://o", fetchImpl }),
      /0x5afe5afe5afe5afe5afe5afe5afe5afe5afe5afe/,
    );
  });

  it("refuses to sign a relay statement issued for a different action or intent", async () => {
    // A genuine challenge — for approving intent 8 — handed to a caller denying intent 7.
    const swapped = {
      ...walletChallenge,
      action: "intent:approve",
      subject: "8",
      statement: rootChallengeStatement({
        action: "intent:approve",
        subject: "8",
        challenge: "nonce-1",
      }),
    };
    const signed: string[] = [];
    const { fetchImpl, calls } = stubOrchestrator([{ json: swapped }]);
    await assert.rejects(
      resolveIntentWithProof({
        intentId: "7",
        approved: false,
        url: "http://orch.local",
        fetchImpl,
        rootAccount: {
          address: ROOT_ADDRESS,
          signMessage: async ({ message }) => {
            signed.push(message);
            return "0xsigned";
          },
        },
      }),
      /root_challenge_mismatch/,
    );
    // Nothing was signed and no resolve was attempted.
    assert.deepEqual(signed, []);
    assert.equal(calls.length, 1);
  });

  it("refuses a wallet root with neither signer nor proof, quoting the statement", async () => {
    const { fetchImpl } = stubOrchestrator([{ json: walletChallenge }]);
    await assert.rejects(
      () => resolveIntentWithProof({ intentId: "7", approved: true, url: "http://o", fetchImpl }),
      /root_proof_required.*LaCrew root authorization/s,
    );
  });

  it("raises SafeExecutionRequired with the unsent transaction, not a settled result", async () => {
    const transaction = { to: ROOT_ADDRESS, data: "0xdead", value: "0" };
    const { fetchImpl } = stubOrchestrator([
      { json: noChallenge },
      {
        status: 409,
        json: {
          error: "safe_exec_unsigned",
          detail: "Broadcast it, then confirm.",
          transaction,
          safeTxHash: "0xsafe",
        },
      },
    ]);
    await assert.rejects(
      () => resolveIntentWithProof({ intentId: "7", approved: true, url: "http://o", fetchImpl }),
      (err: unknown) => {
        assert.ok(err instanceof SafeExecutionRequired);
        assert.deepEqual(err.transaction, transaction);
        assert.equal(err.safeTxHash, "0xsafe");
        return true;
      },
    );
  });

  it("surfaces the orchestrator's error name on any other refusal", async () => {
    const { fetchImpl } = stubOrchestrator([
      { json: noChallenge },
      { status: 403, json: { error: "not_the_approver" } },
    ]);
    await assert.rejects(
      () => resolveIntentWithProof({ intentId: "7", approved: true, url: "http://o", fetchImpl }),
      /not_the_approver/,
    );
  });

  it("normalizes a trailing slash and carries the bearer token on every request", async () => {
    const { fetchImpl, calls } = stubOrchestrator([
      { json: noChallenge },
      { json: { escalated: false, authorizedBy: "approver", approver: null, intent: {} } },
    ]);
    await resolveIntentWithProof({
      intentId: "7",
      approved: true,
      url: "http://orch.local/",
      token: "tok-1",
      fetchImpl,
    });
    for (const call of calls) {
      assert.ok(!call.url.includes("//root-auth") && !call.url.includes("//intents"));
      assert.equal(call.headers.authorization, "Bearer tok-1");
    }
  });

  it("approveIntent and denyIntent set the verdict and nothing else", async () => {
    for (const [helper, approved] of [
      [approveIntent, true],
      [denyIntent, false],
    ] as const) {
      const { fetchImpl, calls } = stubOrchestrator([
        { json: noChallenge },
        { json: { escalated: false, authorizedBy: "approver", approver: null, intent: {} } },
      ]);
      await helper({ intentId: "9", url: "http://o", fetchImpl });
      assert.equal(calls[0]!.body.action, approved ? "intent:approve" : "intent:deny");
      assert.equal(calls[1]!.body.approved, approved);
    }
  });
});
