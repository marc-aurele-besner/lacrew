/**
 * `lacrew intents approve|deny|confirm` (F2.6 / F1.3).
 *
 * The CLI is the unit under test: what request it composes, what it refuses to
 * compose, and what it tells an operator who cannot sign here. A passkey — Safe
 * or otherwise — has no key at this terminal, so the command's job is to stop
 * with the challenge in hand rather than send an unproved request the
 * orchestrator would refuse anyway.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { privateKeyToAccount } from "viem/accounts";
import { cmdIntents } from "./intents.js";

type Call = { path: string; method: string; body: unknown };

const realFetch = globalThis.fetch;
let calls: Call[] = [];
let responder: (call: Call) => { status?: number; body: unknown };

const SAFE = "0x00000000000000000000000000000000000005a7";
const SAFE_TX_HASH = `0x${"7c".repeat(32)}`;
const SAFE_CHALLENGE = Buffer.from(SAFE_TX_HASH.slice(2), "hex").toString("base64url");
const ROOT_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

function installFetch(): void {
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const href = typeof url === "string" ? url : url.toString();
    const call: Call = {
      path: href.replace("http://127.0.0.1:8788", ""),
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    const { status = 200, body } = responder(call);
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

async function capture(args: string[]): Promise<{ out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const log = console.log;
  const error = console.error;
  console.log = (...parts: unknown[]) => out.push(parts.join(" "));
  console.error = (...parts: unknown[]) => err.push(parts.join(" "));
  try {
    await cmdIntents(args);
  } finally {
    console.log = log;
    console.error = error;
  }
  return { out: out.join("\n"), err: err.join("\n") };
}

beforeEach(() => {
  calls = [];
  responder = () => ({ body: {} });
  installFetch();
  delete process.env.ROOT_PRIVATE_KEY;
  process.exitCode = undefined;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.ROOT_PRIVATE_KEY;
  process.exitCode = undefined;
});

const safeChallenge = {
  required: true,
  kind: "safe-passkey",
  challenge: SAFE_CHALLENGE,
  action: "intent:approve",
  subject: "7",
  expiresAt: Date.now() + 60_000,
  statement: "",
  safeAddress: SAFE,
  safeTxHash: SAFE_TX_HASH,
  relayed: true,
};

describe("lacrew intents approve — Safe roots", () => {
  it("stops with the Safe's own hash rather than sending an unproved request", async () => {
    responder = (call) =>
      call.path === "/root-auth/challenge" ? { body: safeChallenge } : { body: {} };
    await assert.rejects(cmdIntents(["approve", "7"]), (err: Error) => {
      // Everything the operator needs to run the ceremony somewhere else: the
      // Safe, the hash that is also the transfer, and the UV requirement the
      // Safe's signer contract imposes.
      assert.match(err.message, /Safe owned by a passkey/);
      assert.match(err.message, new RegExp(SAFE));
      assert.match(err.message, new RegExp(SAFE_CHALLENGE.slice(0, 12)));
      assert.match(err.message, /userVerification: "required"/);
      return true;
    });
    // And nothing was sent: /intents/resolve was never reached.
    assert.deepEqual(
      calls.map((c) => c.path),
      ["/root-auth/challenge"],
    );
  });

  it("sends an assertion collected elsewhere with the challenge it answers", async () => {
    responder = (call) =>
      call.path === "/root-auth/challenge"
        ? { body: safeChallenge }
        : {
            body: { authorizedBy: "root:safe-passkey", txHash: "0xabc", safeTxHash: SAFE_TX_HASH },
          };
    const proof = {
      kind: "passkey",
      credentialId: "c",
      authenticatorData: "a",
      clientDataJSON: "c",
      signature: "s",
    };
    const { out } = await capture(["approve", "7", "--root-proof", JSON.stringify(proof)]);
    const resolve = calls.find((c) => c.path === "/intents/resolve")!;
    assert.deepEqual(resolve.body, {
      intentId: "7",
      approved: true,
      challenge: SAFE_CHALLENGE,
      rootProof: proof,
    });
    assert.match(out, /root:safe-passkey/);
  });

  it("prints the transaction to send when the orchestrator relays nowhere", async () => {
    responder = (call) =>
      call.path === "/root-auth/challenge"
        ? { body: { ...safeChallenge, relayed: false } }
        : {
            status: 409,
            body: {
              error: "safe_exec_unsigned",
              safeTxHash: SAFE_TX_HASH,
              transaction: { to: SAFE, data: "0xdeadbeef", value: "0" },
            },
          };
    const { err } = await capture([
      "approve",
      "7",
      "--root-proof",
      '{"kind":"passkey","credentialId":"c","authenticatorData":"a","clientDataJSON":"c","signature":"s"}',
    ]);
    // Not an error to swallow: the transaction is the answer, and the operator
    // has to be told plainly that nothing has been approved yet.
    assert.match(err, /still pending/);
    assert.match(err, /0xdeadbeef/);
    assert.match(err, /lacrew intents confirm 7 --approved --tx/);
    assert.equal(process.exitCode, 1);
  });
});

describe("lacrew intents approve — other roots", () => {
  it("signs locally for a wallet root", async () => {
    const account = privateKeyToAccount(ROOT_KEY);
    process.env.ROOT_PRIVATE_KEY = ROOT_KEY;
    responder = (call) =>
      call.path === "/root-auth/challenge"
        ? {
            body: {
              required: true,
              kind: "wallet",
              challenge: "nonce-1",
              action: "intent:deny",
              subject: "7",
              expiresAt: Date.now() + 60_000,
              statement: "LaCrew root authorization\naction: intent:deny\nsubject: 7",
            },
          }
        : { body: { authorizedBy: "root:wallet" } };
    await capture(["deny", "7"]);
    const resolve = calls.find((c) => c.path === "/intents/resolve")!.body as {
      approved: boolean;
      rootProof: { kind: string; address: string };
    };
    assert.equal(resolve.approved, false);
    assert.equal(resolve.rootProof.kind, "wallet");
    assert.equal(resolve.rootProof.address, account.address);
    // The challenge was minted for a denial; approving would need its own.
    assert.equal((calls[0]!.body as { action: string }).action, "intent:deny");
  });

  it("says who a manager-depth intent awaits, and asks for no proof", async () => {
    responder = (call) =>
      call.path === "/root-auth/challenge"
        ? {
            body: {
              required: false,
              challenge: null,
              kind: null,
              awaitingApprover: "0x00000000000000000000000000000000000000a5",
            },
          }
        : { body: { authorizedBy: "approver" } };
    const { err } = await capture(["approve", "7"]);
    assert.match(err, /awaits 0x0{38}a5, not the workspace root/);
    // Sent anyway — an ungated decision is the manager's to make.
    const resolve = calls.find((c) => c.path === "/intents/resolve")!;
    assert.deepEqual(resolve.body, { intentId: "7", approved: true });
  });
});

describe("lacrew intents confirm", () => {
  it("refuses to guess which decision a transaction carried", async () => {
    const { err } = await capture(["confirm", "7", "--tx", "0xabc"]);
    assert.match(err, /--approved or --denied/);
    assert.equal(process.exitCode, 1);
    assert.deepEqual(calls, []);
  });

  it("reports an unconfirmed intent as a failure, not a success", async () => {
    responder = () => ({ body: { confirmed: false, awaitingApprover: SAFE } });
    const { out } = await capture(["confirm", "7", "--approved", "--tx", "0xabc"]);
    assert.match(out, /"confirmed": false/);
    // Exit code, because a script that treats this as done clears a queue for a
    // spend the chain says has not happened.
    assert.equal(process.exitCode, 1);
    assert.deepEqual(calls[0]!.body, { intentId: "7", approved: true, txHash: "0xabc" });
  });
});
