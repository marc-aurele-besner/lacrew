import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { closeSharedDb, sharedDb } from "./dbPool.js";
import {
  createGasStoreFromEnv,
  createMemoryGasStore,
  createPgGasStore,
  txGasFromReceipt,
  type TxGasRecord,
} from "./gasStore.js";
import type { GasPayer, GasReceipt } from "@lacrew/core";

// One pool for the file, as one process has; closed so the runner can exit.
after(async () => closeSharedDb());

const TX = `0x${"Ab".repeat(32)}` as `0x${string}`;
const SENDER = "0xAbCdEfabcdefABCDEFabcdefabcdefABCDEFabcd" as `0x${string}`;
const AT = "2026-03-01T12:00:00.000Z";

const receipt = (over: Partial<GasReceipt> = {}): GasReceipt => ({
  chainId: 8453,
  txHash: TX,
  kind: "propose",
  status: "success",
  gasUsed: 21_000n,
  payer: "orchestrator",
  ...over,
});

describe("txGasFromReceipt", () => {
  it("stores a receipt as lower-cased decimal strings", () => {
    const record = txGasFromReceipt(
      receipt({
        sender: SENDER,
        agent: SENDER,
        effectiveGasPrice: 1_500_000_000n,
        l1Fee: 234n,
        feeWei: 31_500_000_000_234n,
      }),
      AT,
    );
    assert.deepEqual(record, {
      chainId: 8453,
      txHash: TX.toLowerCase(),
      userOpHash: null,
      at: AT,
      action: "propose",
      sender: SENDER.toLowerCase(),
      payer: "orchestrator",
      paymaster: null,
      agent: SENDER.toLowerCase(),
      status: "success",
      gasUsed: "21000",
      effectiveGasPrice: "1500000000",
      l1FeeWei: "234",
      feeWei: "31500000000234",
    });
  });

  it("keeps a fee past 2^53 exact", () => {
    // 1.2e18 wei: a JS number would have rounded it.
    const record = txGasFromReceipt(receipt({ feeWei: 1_200_000_000_000_000_001n }), AT);
    assert.equal(record.feeWei, "1200000000000000001");
    assert.equal(record.sender, null);
  });

  it("leaves the fee null when the receipt states none", () => {
    const record = txGasFromReceipt(receipt({ l1Fee: 7n }), AT);
    assert.equal(record.effectiveGasPrice, null);
    assert.equal(record.l1FeeWei, "7");
    // Unknown, not zero: a zero would read as a transaction that cost nothing.
    assert.equal(record.feeWei, null);
  });

  it("keeps a sponsored user operation's own hash and its paymaster", () => {
    const record = txGasFromReceipt(
      receipt({
        userOpHash: `0x${"CD".repeat(32)}`,
        payer: "sponsored",
        paymaster: SENDER,
        status: "reverted",
        feeWei: 5n,
      }),
      AT,
    );
    assert.equal(record.userOpHash, `0x${"cd".repeat(32)}`);
    assert.equal(record.payer, "sponsored");
    assert.equal(record.paymaster, SENDER.toLowerCase());
    assert.equal(record.status, "reverted");
  });
});

describe("GasStore", () => {
  it("memory store is a safe no-op that cannot answer the sums", async () => {
    const store = createMemoryGasStore();
    await store.append(txGasFromReceipt(receipt(), AT));
    await store.attributeAgent(1, TX, SENDER);
    // Null, not []: the caller must fall back to its ring and say it is partial.
    assert.equal(await store.sumByDayBetween(AT, AT), null);
    assert.equal(await store.sumByAgentBetween(AT, AT), null);
    await store.close();
  });

  it("falls back to memory without DATABASE_URL", () => {
    const prev = process.env.DATABASE_URL;
    try {
      delete process.env.DATABASE_URL;
      assert.equal(createGasStoreFromEnv().name, "memory");
    } finally {
      if (prev !== undefined) process.env.DATABASE_URL = prev;
    }
  });

  it(
    "postgres store sums fees by UTC day, agent and payer, one row per transaction",
    { skip: !process.env.DATABASE_URL },
    async () => {
      // A chain id of its own, so the shared table's other rows stay out of
      // this run's sums.
      const chainId = 1_000_000_000 + Math.floor(Math.random() * 1_000_000_000);
      const store = createPgGasStore({ db: sharedDb(), chainId });
      const agent = "0xAbCdEfabcdefABCDEFabcdefabcdefABCDEFabcd";
      const other = "0x1111111111111111111111111111111111111111";
      let n = 0;
      const tx = (
        at: string,
        feeWei: string | null,
        payer: GasPayer = "orchestrator",
      ): TxGasRecord => {
        n += 1;
        return {
          chainId,
          txHash: `0x${n.toString(16).padStart(64, "0")}`,
          userOpHash: null,
          at,
          action: "propose",
          sender: SENDER.toLowerCase(),
          payer,
          paymaster: null,
          agent: null,
          status: "success",
          gasUsed: "21000",
          effectiveGasPrice: feeWei === null ? null : "1",
          l1FeeWei: null,
          feeWei,
        };
      };
      try {
        // 2^64 wei each: the sum has to survive as a string, not a double.
        const big = "18446744073709551616";
        const first = tx("2026-03-01T00:00:00.000Z", big);
        const second = tx("2026-03-01T23:59:59.999Z", big);
        const third = tx("2026-03-02T00:00:00.000Z", "5");
        const priceless = tx("2026-03-02T09:00:00.000Z", null);
        for (const record of [first, second, third, priceless]) await store.append(record);
        // The same transaction reported again is still one fee.
        await store.append(first);
        // On and before the edges: `to` itself is outside the window.
        await store.append(tx("2026-02-28T23:59:59.999Z", "1000"));
        await store.append(tx("2026-03-04T00:00:00.000Z", "1000"));

        await store.attributeAgent(chainId, first.txHash.toUpperCase().replace("0X", "0x"), agent);
        await store.attributeAgent(chainId, third.txHash, agent);
        // The first attribution stands.
        await store.attributeAgent(chainId, third.txHash, other);

        const from = "2026-03-01T00:00:00.000Z";
        const to = "2026-03-04T00:00:00.000Z";
        // An agent wallet's own transaction, and two user operations that
        // share one bundle transaction: each operation is a fee of its own.
        const own = tx("2026-03-03T10:00:00.000Z", "11", "agent");
        own.agent = other;
        await store.append(own);
        const bundle = tx("2026-03-03T11:00:00.000Z", "40", "sponsored");
        const op = (suffix: string): TxGasRecord => ({
          ...bundle,
          userOpHash: `0x${suffix.repeat(32)}`,
          paymaster: other,
          agent: other,
        });
        await store.append(op("a1"));
        await store.append(op("a2"));
        await store.append(op("a2"));

        assert.deepEqual(await store.sumByDayBetween(from, to), [
          {
            day: "2026-03-01",
            payer: "orchestrator",
            feeWei: "36893488147419103232",
            txCount: 2,
          },
          // The transaction with no price adds to neither figure.
          { day: "2026-03-02", payer: "orchestrator", feeWei: "5", txCount: 1 },
          { day: "2026-03-03", payer: "agent", feeWei: "11", txCount: 1 },
          { day: "2026-03-03", payer: "sponsored", feeWei: "80", txCount: 2 },
        ]);
        const byAgent = await store.sumByAgentBetween(from, to);
        assert.ok(byAgent);
        assert.deepEqual(
          byAgent.find((row) => row.agent === agent.toLowerCase()),
          {
            agent: agent.toLowerCase(),
            payer: "orchestrator",
            feeWei: "18446744073709551621",
            txCount: 2,
          },
        );
        assert.deepEqual(
          byAgent.find((row) => row.agent === null),
          { agent: null, payer: "orchestrator", feeWei: big, txCount: 1 },
        );
        assert.deepEqual(
          byAgent.filter((row) => row.agent === other),
          [
            { agent: other, payer: "agent", feeWei: "11", txCount: 1 },
            { agent: other, payer: "sponsored", feeWei: "80", txCount: 2 },
          ],
        );
        assert.equal(byAgent.length, 4);
      } finally {
        await store.close();
      }
    },
  );
});
