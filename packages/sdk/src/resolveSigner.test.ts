/**
 * Which key signs `EscalationRouter.resolve` (PRD F2.6 / F1.3).
 *
 * The contract reverts for any sender that is not the intent's
 * `awaitingApprover`, so the signer is the whole authorization story off-chain:
 * an approval signed by the manager key is a manager's approval, whatever the
 * inbox recorded, and on a deployment where one process holds both keys the
 * difference is invisible from the outside. These tests read the raw
 * transaction and recover who actually signed it.
 *
 * Hermetic — the transport is a stub, no chain is touched.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  custom,
  encodeAbiParameters,
  recoverTransactionAddress,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ANVIL_CHAIN_ID, getAddresses } from "@lacrew/core";
import { createOnchainClient } from "./onchain.js";

/** Anvil accounts 0, 1 and 2 — signing only; nothing is broadcast. */
const ROOT = privateKeyToAccount(
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
);
const MANAGER = privateKeyToAccount(
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
);
const STRANGER = "0x00000000000000000000000000000000000000ff" as `0x${string}`;

const WORKER = "0x3333333333333333333333333333333333333333" as `0x${string}`;
const TARGET = "0x4444444444444444444444444444444444444444" as `0x${string}`;

/** Answers just enough JSON-RPC to sign and "land" one transaction. */
function stubChain(awaitingApprover: `0x${string}`) {
  const intentRow = encodeAbiParameters(
    [
      { type: "address" },
      { type: "address" },
      { type: "uint256" },
      { type: "bytes" },
      { type: "address" },
      { type: "bool" },
      { type: "bool" },
    ],
    [WORKER, TARGET, 75n * 10n ** 6n, "0x", awaitingApprover, true, true],
  );
  const transport = custom({
    async request({ method }: { method: string }) {
      switch (method) {
        case "eth_chainId":
          return `0x${ANVIL_CHAIN_ID.toString(16)}`;
        case "eth_getTransactionCount":
          return "0x0";
        case "eth_estimateGas":
          return "0x186a0";
        case "eth_gasPrice":
          return "0x3b9aca00";
        case "eth_maxPriorityFeePerGas":
          return "0x3b9aca00";
        case "eth_getBlockByNumber":
          return { baseFeePerGas: "0x3b9aca00", number: "0x1", timestamp: "0x1" };
        case "eth_blockNumber":
          return "0x1";
        case "eth_sendRawTransaction":
          return "0x" + "11".repeat(32);
        case "eth_getTransactionReceipt":
          return {
            transactionHash: "0x" + "11".repeat(32),
            blockNumber: "0x1",
            blockHash: "0x" + "22".repeat(32),
            transactionIndex: "0x0",
            status: "0x1",
            gasUsed: "0x186a0",
            cumulativeGasUsed: "0x186a0",
            effectiveGasPrice: "0x3b9aca00",
            logs: [],
            type: "0x2",
            from: awaitingApprover,
            to: getAddresses(ANVIL_CHAIN_ID).escalationRouter,
            contractAddress: null,
            logsBloom: "0x" + "00".repeat(256),
          };
        case "eth_call":
          return intentRow;
        default:
          throw new Error(`unstubbed rpc: ${method}`);
      }
    },
  });
  return transport;
}

/** Who signed the one transaction this client broadcast. */
async function senderOf(raw: Hex): Promise<`0x${string}`> {
  return recoverTransactionAddress({ serializedTransaction: raw as never });
}

function clientFor(awaitingApprover: `0x${string}`) {
  const transport = stubChain(awaitingApprover);
  const sent: Hex[] = [];
  // Wrap the transport so the raw transaction is captured on its way out.
  const capturing = custom({
    async request(args: { method: string; params?: unknown }) {
      if (args.method === "eth_sendRawTransaction") {
        sent.push((args.params as Hex[])[0]!);
      }
      return (transport({}) as { request: (a: unknown) => Promise<unknown> }).request(args);
    },
  });
  const client = createOnchainClient({
    transport: capturing,
    account: ROOT,
    resolverAccount: MANAGER,
    chainId: ANVIL_CHAIN_ID,
    addresses: getAddresses(ANVIL_CHAIN_ID),
  });
  return { client, sent };
}

describe("resolveIntent signs as the seat the chain is waiting on", () => {
  it("uses the root key for an intent that climbed to the root", async () => {
    const { client, sent } = clientFor(ROOT.address);
    await client.resolveIntent("7", true, ROOT.address);
    assert.equal(sent.length, 1);
    // Not the manager key, which is what an unconditional resolver-signs would
    // have used — and which this contract would have reverted.
    assert.equal((await senderOf(sent[0]!)).toLowerCase(), ROOT.address.toLowerCase());
  });

  it("uses the manager key for a manager-depth intent", async () => {
    const { client, sent } = clientFor(MANAGER.address);
    await client.resolveIntent("7", true, MANAGER.address);
    assert.equal(sent.length, 1);
    assert.equal((await senderOf(sent[0]!)).toLowerCase(), MANAGER.address.toLowerCase());
  });

  it("reads the waiting approver off the chain when the caller names none", async () => {
    const { client, sent } = clientFor(ROOT.address);
    await client.resolveIntent("7", true);
    assert.equal((await senderOf(sent[0]!)).toLowerCase(), ROOT.address.toLowerCase());
  });

  it("refuses by name when it holds no key for the approver, and broadcasts nothing", async () => {
    const { client, sent } = clientFor(STRANGER);
    await assert.rejects(
      client.resolveIntent("7", true, STRANGER),
      /no_signer_for_approver/,
    );
    // A passkey or Safe root signs elsewhere; sending a transaction that the
    // chain will reject tells the approver nothing about why.
    assert.deepEqual(sent, []);
  });
});
