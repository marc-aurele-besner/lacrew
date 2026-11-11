import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  gasReceiptFromTransaction,
  gasReceiptFromUserOperation,
  isGasPayer,
  reportGasReceipt,
  reportTransactionGas,
  reportUserOperationGas,
  type GasReceipt,
} from "./gas.js";

const TX = `0x${"ab".repeat(32)}` as `0x${string}`;
const OP = `0x${"cd".repeat(32)}` as `0x${string}`;
const FROM = "0x1111111111111111111111111111111111111111" as `0x${string}`;
const AGENT = "0x2222222222222222222222222222222222222222" as `0x${string}`;
const PAYMASTER = "0x3333333333333333333333333333333333333333" as `0x${string}`;

describe("gasReceiptFromTransaction", () => {
  it("multiplies gas used by the price and adds the L1 fee", () => {
    assert.deepEqual(
      gasReceiptFromTransaction(
        {
          transactionHash: TX,
          from: FROM,
          status: "success",
          gasUsed: 100n,
          effectiveGasPrice: 10n,
          l1Fee: 234n,
        },
        { chainId: 8453, kind: "goat send", payer: "agent", agent: AGENT },
      ),
      {
        chainId: 8453,
        txHash: TX,
        kind: "goat send",
        status: "success",
        gasUsed: 100n,
        effectiveGasPrice: 10n,
        l1Fee: 234n,
        feeWei: 1234n,
        payer: "agent",
        sender: FROM,
        agent: AGENT,
      },
    );
  });

  it("reads a raw JSON-RPC receipt's hex quantities", () => {
    const receipt = gasReceiptFromTransaction(
      { transactionHash: TX, status: "0x0", gasUsed: "0x5208", effectiveGasPrice: "0x2" },
      { chainId: 1, kind: "x", payer: "approver" },
    );
    assert.equal(receipt.status, "reverted");
    assert.equal(receipt.feeWei, 42_000n);
  });

  it("leaves the fee unknown without a price, even with an L1 fee", () => {
    const receipt = gasReceiptFromTransaction(
      { transactionHash: TX, status: "success", gasUsed: 90_000n, l1Fee: 7n },
      { chainId: 8453, kind: "x", payer: "orchestrator" },
    );
    assert.equal(receipt.l1Fee, 7n);
    assert.equal("feeWei" in receipt, false);
  });
});

describe("gasReceiptFromUserOperation", () => {
  const bundle = { transactionHash: TX, gasUsed: 999_999n, effectiveGasPrice: 99n };

  it("takes the operation's own cost, not the bundle transaction's", () => {
    const receipt = gasReceiptFromUserOperation(
      {
        userOpHash: OP,
        sender: AGENT,
        actualGasCost: 5_000n,
        actualGasUsed: 250n,
        success: true,
        receipt: bundle,
      },
      { chainId: 8453, kind: "user operation", agent: AGENT },
    );
    assert.deepEqual(receipt, {
      chainId: 8453,
      txHash: TX,
      userOpHash: OP,
      kind: "user operation",
      status: "success",
      gasUsed: 250n,
      feeWei: 5_000n,
      payer: "agent",
      sender: AGENT,
      agent: AGENT,
    });
  });

  it("marks a paymaster-paid operation sponsored and names the paymaster", () => {
    const receipt = gasReceiptFromUserOperation(
      {
        userOpHash: OP,
        sender: AGENT,
        paymaster: PAYMASTER,
        actualGasCost: "0x1388",
        actualGasUsed: "0xfa",
        success: false,
        receipt: bundle,
      },
      { chainId: 8453, kind: "user operation" },
    );
    assert.equal(receipt.payer, "sponsored");
    assert.equal(receipt.paymaster, PAYMASTER);
    assert.equal(receipt.feeWei, 5_000n);
    assert.equal(receipt.status, "reverted");
  });

  it("treats the zero address as no paymaster", () => {
    const receipt = gasReceiptFromUserOperation(
      {
        userOpHash: OP,
        paymaster: "0x0000000000000000000000000000000000000000",
        actualGasCost: 1n,
        actualGasUsed: 1n,
        success: true,
        receipt: bundle,
      },
      { chainId: 1, kind: "x", selfPayer: "orchestrator" },
    );
    assert.equal(receipt.payer, "orchestrator");
    assert.equal("paymaster" in receipt, false);
  });
});

describe("reporting", () => {
  const context = { chainId: 1, kind: "x", payer: "agent" } as const;
  const mined = { transactionHash: TX, status: "success", gasUsed: 1n, effectiveGasPrice: 3n };

  it("reads the receipt and hands the fee to the sink", async () => {
    const seen: GasReceipt[] = [];
    const reported = await reportTransactionGas(
      { waitForTransactionReceipt: async () => mined },
      TX,
      context,
      (receipt) => void seen.push(receipt),
    );
    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.feeWei, 3n);
    assert.equal(reported, seen[0]);
  });

  it("does not read the chain when nobody is listening", async () => {
    let reads = 0;
    const reported = await reportTransactionGas(
      {
        waitForTransactionReceipt: async () => {
          reads += 1;
          return mined;
        },
      },
      TX,
      context,
      undefined,
    );
    assert.equal(reported, undefined);
    assert.equal(reads, 0);
  });

  it("reports nothing for a receipt it cannot read, and never throws", async () => {
    const seen: GasReceipt[] = [];
    const reported = await reportTransactionGas(
      {
        waitForTransactionReceipt: async () => {
          throw new Error("rpc down");
        },
      },
      TX,
      context,
      (receipt) => void seen.push(receipt),
    );
    assert.equal(reported, undefined);
    assert.equal(seen.length, 0);
  });

  it("swallows a sink that throws or rejects", async () => {
    await reportGasReceipt(
      () => {
        throw new Error("sync");
      },
      gasReceiptFromTransaction(mined, context),
    );
    await reportGasReceipt(
      async () => {
        throw new Error("async");
      },
      gasReceiptFromTransaction(mined, context),
    );
  });

  it("reports a user operation from the bundler's receipt", async () => {
    const seen: GasReceipt[] = [];
    await reportUserOperationGas(
      {
        waitForUserOperationReceipt: async () => ({
          userOpHash: OP,
          paymaster: PAYMASTER,
          actualGasCost: 9n,
          actualGasUsed: 3n,
          success: true,
          receipt: { transactionHash: TX },
        }),
      },
      OP,
      { chainId: 1, kind: "user operation" },
      (receipt) => void seen.push(receipt),
    );
    assert.equal(seen[0]!.payer, "sponsored");
    assert.equal(seen[0]!.userOpHash, OP);
  });
});

describe("isGasPayer", () => {
  it("accepts the four payers and nothing else", () => {
    for (const payer of ["orchestrator", "agent", "approver", "sponsored"]) {
      assert.equal(isGasPayer(payer), true);
    }
    assert.equal(isGasPayer("bundler"), false);
    assert.equal(isGasPayer(undefined), false);
  });
});
