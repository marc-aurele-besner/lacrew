import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createGasStoreFromEnv,
  createMemoryGasStore,
  createPgGasStore,
  txGasFromReceipt,
  type TxGasRecord,
} from "./gasStore.js";

const TX = `0x${"Ab".repeat(32)}` as `0x${string}`;
const SENDER = "0xAbCdEfabcdefABCDEFabcdefabcdefABCDEFabcd" as `0x${string}`;
const AT = "2026-03-01T12:00:00.000Z";

describe("txGasFromReceipt", () => {
  it("multiplies gas used by the effective gas price, as decimal strings", () => {
    const record = txGasFromReceipt(
      {
        txHash: TX,
        action: "propose",
        from: SENDER,
        status: "success",
        gasUsed: 21_000n,
        effectiveGasPrice: 1_500_000_000n,
      },
      8453,
      AT,
    );
    assert.deepEqual(record, {
      chainId: 8453,
      txHash: TX.toLowerCase(),
      at: AT,
      action: "propose",
      sender: SENDER.toLowerCase(),
      agent: null,
      status: "success",
      gasUsed: "21000",
      effectiveGasPrice: "1500000000",
      l1FeeWei: null,
      feeWei: "31500000000000",
    });
  });

  it("keeps a fee past 2^53 exact", () => {
    const record = txGasFromReceipt(
      {
        txHash: TX,
        action: "deploy",
        status: "success",
        gasUsed: 3_000_000n,
        effectiveGasPrice: 400_000_000_000n,
      },
      1,
      AT,
    );
    // 1.2e18 wei: a JS number would have rounded it.
    assert.equal(record.feeWei, "1200000000000000000");
    assert.equal(record.sender, null);
  });

  it("leaves the fee null when the receipt lacks an effective gas price", () => {
    const record = txGasFromReceipt(
      { txHash: TX, action: "resolve", status: "success", gasUsed: 90_000n },
      31337,
      AT,
    );
    assert.equal(record.gasUsed, "90000");
    assert.equal(record.effectiveGasPrice, null);
    // Unknown, not zero: a zero would read as a transaction that cost nothing.
    assert.equal(record.feeWei, null);
  });

  it("does not pass an L1 fee off as the whole fee when the price is missing", () => {
    const record = txGasFromReceipt(
      { txHash: TX, action: "resolve", status: "success", gasUsed: 90_000n, l1Fee: 7n },
      8453,
      AT,
    );
    assert.equal(record.l1FeeWei, "7");
    assert.equal(record.feeWei, null);
  });

  it("adds an OP-stack L1 fee on top of the L2 gas", () => {
    const record = txGasFromReceipt(
      {
        txHash: TX,
        action: "propose",
        status: "success",
        gasUsed: 100n,
        effectiveGasPrice: 10n,
        l1Fee: 234n,
      },
      8453,
      AT,
    );
    assert.equal(record.l1FeeWei, "234");
    assert.equal(record.feeWei, "1234");
  });

  it("records a reverted transaction's gas as well", () => {
    const record = txGasFromReceipt(
      {
        txHash: TX,
        action: "session revoke",
        status: "reverted",
        gasUsed: 50_000n,
        effectiveGasPrice: 2n,
      },
      31337,
      AT,
    );
    assert.equal(record.status, "reverted");
    assert.equal(record.feeWei, "100000");
  });
});

describe("GasStore", () => {
  it("memory store is a safe no-op that cannot answer the sums", async () => {
    const store = createMemoryGasStore();
    await store.append(
      txGasFromReceipt({ txHash: TX, action: "propose", status: "success", gasUsed: 1n }, 1, AT),
    );
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
    "postgres store sums fees by UTC day and by agent, one row per transaction",
    { skip: !process.env.DATABASE_URL },
    async () => {
      // A chain id of its own, so the shared table's other rows stay out of
      // this run's sums.
      const chainId = 1_000_000_000 + Math.floor(Math.random() * 1_000_000_000);
      const store = createPgGasStore(undefined, chainId);
      const agent = "0xAbCdEfabcdefABCDEFabcdefabcdefABCDEFabcd";
      const other = "0x1111111111111111111111111111111111111111";
      let n = 0;
      const tx = (at: string, feeWei: string | null): TxGasRecord => {
        n += 1;
        return {
          chainId,
          txHash: `0x${n.toString(16).padStart(64, "0")}`,
          at,
          action: "propose",
          sender: SENDER.toLowerCase(),
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
        assert.deepEqual(await store.sumByDayBetween(from, to), [
          { day: "2026-03-01", feeWei: "36893488147419103232", txCount: 2 },
          // The transaction with no price adds to neither figure.
          { day: "2026-03-02", feeWei: "5", txCount: 1 },
        ]);
        const byAgent = await store.sumByAgentBetween(from, to);
        assert.ok(byAgent);
        assert.deepEqual(
          byAgent.find((row) => row.agent === agent.toLowerCase()),
          { agent: agent.toLowerCase(), feeWei: "18446744073709551621", txCount: 2 },
        );
        assert.deepEqual(
          byAgent.find((row) => row.agent === null),
          { agent: null, feeWei: big, txCount: 1 },
        );
        assert.equal(byAgent.length, 2);
      } finally {
        await store.close();
      }
    },
  );
});
