/**
 * What the gate has to be right about: a GOAT tool cannot spend past the policy
 * stack, and the question the stack is asked is the call the tool actually
 * makes — not the plain transfer an unencoded request would look like.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { encodeFunctionData, parseAbi } from "viem";
import {
  gateGoatWallet,
  goatCallData,
  GoatPolicyError,
  toAdapterCheckInput,
  type AdapterCheckInput,
  type GoatBlockedSpend,
  type GoatTransaction,
  type GoatWalletClient,
} from "./index.js";

const SEAT = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const;
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;
const PAYEE = "0x4444444444444444444444444444444444444444" as const;
const ERC20 = parseAbi(["function transfer(address to, uint256 amount) returns (bool)"]);

/** Records what the underlying client was asked to broadcast, if anything. */
function recordingWallet(): { wallet: GoatWalletClient; sent: GoatTransaction[] } {
  const sent: GoatTransaction[] = [];
  return {
    sent,
    wallet: {
      getAddress: () => SEAT,
      getChain: () => ({ type: "evm", id: 8453 }),
      async sendTransaction(transaction) {
        sent.push(transaction);
        return { hash: "0xfeed" };
      },
    },
  };
}

function readerReturning(verdict: "ALLOW" | "ESCALATE" | "DENY", seen: AdapterCheckInput[] = []) {
  return {
    seen,
    reader: {
      async checkPolicy(input: AdapterCheckInput) {
        seen.push(input);
        return verdict;
      },
    },
  };
}

test("an allowed spend reaches the chain unchanged", async () => {
  const { wallet, sent } = recordingWallet();
  const { reader, seen } = readerReturning("ALLOW");
  const gated = gateGoatWallet({ wallet, reader });

  const tx: GoatTransaction = { to: PAYEE, value: 5n * 10n ** 6n };
  assert.deepEqual(await gated.sendTransaction(tx), { hash: "0xfeed" });
  assert.deepEqual(sent, [tx]);
  assert.deepEqual(seen, [{ agent: SEAT, target: PAYEE, value: 5n * 10n ** 6n, data: "0x" }]);
});

for (const verdict of ["DENY", "ESCALATE"] as const) {
  test(`a ${verdict} stops the send before it is broadcast`, async () => {
    const { wallet, sent } = recordingWallet();
    const { reader } = readerReturning(verdict);
    const blocked: GoatBlockedSpend[] = [];
    const gated = gateGoatWallet({ wallet, reader, onBlocked: (e) => void blocked.push(e) });

    const err = await gated
      .sendTransaction({ to: PAYEE, value: 900n * 10n ** 6n })
      .then(() => null)
      .catch((e: unknown) => e);

    assert.ok(err instanceof GoatPolicyError);
    assert.equal(err.verdict, verdict);
    assert.equal(err.spend.target, PAYEE);
    // The point of the gate: nothing was broadcast.
    assert.deepEqual(sent, []);
    assert.equal(blocked.length, 1);
    assert.equal(blocked[0]?.verdict, verdict);
  });
}

test("a reader that cannot answer is not permission", async () => {
  const { wallet, sent } = recordingWallet();
  const gated = gateGoatWallet({
    wallet,
    reader: {
      async checkPolicy() {
        throw new Error("rpc down");
      },
    },
  });
  await assert.rejects(() => gated.sendTransaction({ to: PAYEE, value: 1n }), /rpc down/);
  assert.deepEqual(sent, []);
});

test("a tool's ABI call is checked as that call, not as a bare transfer", async () => {
  const { wallet } = recordingWallet();
  const { reader, seen } = readerReturning("ALLOW");
  const gated = gateGoatWallet({ wallet, reader });

  await gated.sendTransaction({
    to: USDC,
    abi: ERC20,
    functionName: "transfer",
    args: [PAYEE, 25n * 10n ** 6n],
  });

  const expected = encodeFunctionData({
    abi: ERC20,
    functionName: "transfer",
    args: [PAYEE, 25n * 10n ** 6n],
  });
  assert.deepEqual(seen, [{ agent: SEAT, target: USDC, value: 0n, data: expected }]);
  // A selector-aware module has something to match on.
  assert.equal(expected.slice(0, 10), "0xa9059cbb");
});

test("a call with no ABI to encode is refused rather than checked as 0x", () => {
  assert.throws(
    () => goatCallData({ to: USDC, functionName: "transfer", args: [PAYEE, 1n] }),
    /carries no ABI/,
  );
});

test("a target that is not an address never reaches the policy stack", () => {
  assert.throws(() => toAdapterCheckInput({ to: "vitalik.eth" }, SEAT), /is not an address/);
});

test("the agent defaults to the seat and can be overridden", () => {
  const manager = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as const;
  assert.equal(toAdapterCheckInput({ to: PAYEE }, manager).agent, manager);
  assert.equal(toAdapterCheckInput({ to: PAYEE }, SEAT).value, 0n);
});

test("the gate keeps the client's reads intact", () => {
  const { wallet } = recordingWallet();
  const { reader } = readerReturning("ALLOW");
  const gated = gateGoatWallet({ wallet, reader });
  assert.equal(gated.getAddress(), SEAT);
  assert.deepEqual(gated.getChain(), { type: "evm", id: 8453 });
});
