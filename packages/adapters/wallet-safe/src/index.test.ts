import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createSafeWallet,
  createSafeWalletAdapter,
  safeWalletAdapter,
  type AdapterCheckInput,
} from "./index.js";

const SPEND: AdapterCheckInput = {
  agent: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  target: "0x4444444444444444444444444444444444444444",
  value: 200n * 10n ** 6n,
  data: "0x",
};

test("safe wallet stub reports its provider", async () => {
  const wallet = await createSafeWallet();
  assert.equal(wallet.provider, "safe");
  assert.equal(safeWalletAdapter.provider, "safe");
});

test("bound adapter reads the verdict from the policy reader", async () => {
  const adapter = createSafeWalletAdapter({
    async checkPolicy() {
      return "ALLOW";
    },
  });

  // 200 USDC is over the mock cap, so ALLOW can only come from the reader.
  assert.equal(await adapter.checkPolicy(SPEND), "ALLOW");
  assert.equal(await safeWalletAdapter.checkPolicy(SPEND), "ESCALATE");
});
