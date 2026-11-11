/**
 * What a relayed Safe transaction reports about its own cost.
 *
 * The RPC is a local stub that mines whatever it is sent with a chosen status,
 * because the case that matters cannot be staged on a real node at will: a
 * transaction that passed gas estimation and then reverted once mined. It was
 * paid for, so the relay has to hand its hash back and report the fee even
 * though nothing was approved.
 */

import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { keccak256 } from "viem";
import type { GasReceipt } from "@lacrew/core";
import { relaySafeExecution, SafeExecutionRevertedError } from "./index.js";

const CHAIN_ID = 31337;
const SAFE = "0x00000000000000000000000000000000000005a7" as const;
const KEY = `0x${"11".repeat(32)}` as const;
const BLOCK_HASH = `0x${"bb".repeat(32)}`;

/** What the next mined transaction's receipt says. */
let minedStatus: "0x1" | "0x0" = "0x1";
const sentRaw = new Map<string, string>();

function answer(method: string, params: unknown[]): unknown {
  switch (method) {
    case "eth_chainId":
      return `0x${CHAIN_ID.toString(16)}`;
    case "eth_getTransactionCount":
      return "0x0";
    case "eth_estimateGas":
      return "0x5208";
    case "eth_gasPrice":
      return "0x3b9aca00";
    case "eth_maxPriorityFeePerGas":
      return "0x0";
    case "eth_blockNumber":
      return "0x2";
    case "eth_getBlockByNumber":
      // No base fee: a legacy-priced chain, so the price is `eth_gasPrice`.
      return { number: "0x2", hash: BLOCK_HASH, timestamp: "0x1", transactions: [] };
    case "eth_sendRawTransaction": {
      const raw = params[0] as `0x${string}`;
      const hash = keccak256(raw);
      sentRaw.set(hash, minedStatus);
      return hash;
    }
    case "eth_getTransactionReceipt": {
      const hash = params[0] as string;
      const status = sentRaw.get(hash);
      if (!status) return null;
      return {
        transactionHash: hash,
        transactionIndex: "0x0",
        blockHash: BLOCK_HASH,
        blockNumber: "0x1",
        from: "0x19e7e376e7c213b7e7e7e46cc70a5dd086daff2a",
        to: SAFE,
        cumulativeGasUsed: "0x5208",
        gasUsed: "0x5208",
        effectiveGasPrice: "0x3b9aca00",
        contractAddress: null,
        logs: [],
        logsBloom: `0x${"00".repeat(256)}`,
        status,
        type: "0x0",
      };
    }
    default:
      return null;
  }
}

const server = createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    const call = JSON.parse(body) as { id: number; method: string; params?: unknown[] };
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        jsonrpc: "2.0",
        id: call.id,
        result: answer(call.method, call.params ?? []),
      }),
    );
  });
});
let rpc = "";

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  rpc = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => {
  server.close();
});

const relay = (onReceipt: (receipt: GasReceipt) => void) =>
  relaySafeExecution({
    provider: rpc,
    privateKey: KEY,
    allowChainIds: [CHAIN_ID],
    execution: { to: SAFE, data: "0x", value: 0n },
    onReceipt,
  });

test("a relayed Safe transaction reports what it cost the relayer", async () => {
  minedStatus = "0x1";
  const seen: GasReceipt[] = [];
  const relayed = await relay((receipt) => void seen.push(receipt));
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.txHash, relayed.hash);
  assert.equal(seen[0]!.chainId, CHAIN_ID);
  assert.equal(seen[0]!.status, "success");
  assert.equal(seen[0]!.payer, "orchestrator");
  // 21000 gas at 1 gwei.
  assert.equal(seen[0]!.feeWei, 21_000_000_000_000n);
});

test("a mined revert throws with the hash, and its fee is still reported", async () => {
  minedStatus = "0x0";
  const seen: GasReceipt[] = [];
  const err = await relay((receipt) => void seen.push(receipt)).then(
    () => null,
    (e: unknown) => e,
  );
  assert.ok(err instanceof SafeExecutionRevertedError);
  assert.match(err.message, /safe_exec_reverted/);
  assert.match(err.hash, /^0x[0-9a-f]{64}$/);
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.txHash, err.hash);
  assert.equal(seen[0]!.status, "reverted");
  assert.equal(seen[0]!.feeWei, 21_000_000_000_000n);
});

test("a sink that throws does not turn a landed approval into a failure", async () => {
  minedStatus = "0x1";
  const relayed = await relay(() => {
    throw new Error("ledger down");
  });
  assert.match(relayed.hash, /^0x[0-9a-f]{64}$/);
});
