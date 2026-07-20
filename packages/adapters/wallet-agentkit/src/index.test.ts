import assert from "node:assert/strict";
import { test } from "node:test";
import {
  agentKitWalletAdapter,
  checkWithPolicy,
  createAgentKitWalletAdapter,
  type AdapterCheckInput,
} from "./index.js";

const SPEND: AdapterCheckInput = {
  agent: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  target: "0x4444444444444444444444444444444444444444",
  value: 200n * 10n ** 6n,
  data: "0x",
};

test("mocked policy escalates over cap", () => {
  assert.equal(checkWithPolicy(SPEND), "ESCALATE");
  assert.equal(checkWithPolicy({ ...SPEND, value: 10n * 10n ** 6n }), "ALLOW");
});

test("bound adapter reads the verdict from the policy reader", async () => {
  const seen: AdapterCheckInput[] = [];
  const adapter = createAgentKitWalletAdapter({
    async checkPolicy(input) {
      seen.push(input);
      return "DENY";
    },
  });

  // The reader wins over the mock heuristic: 200 USDC would be ESCALATE.
  assert.equal(await adapter.checkPolicy(SPEND), "DENY");
  assert.deepEqual(seen, [SPEND]);
  assert.equal(adapter.provider, agentKitWalletAdapter.provider);
});

test("bound adapter keeps wallet creation intact", async () => {
  const adapter = createAgentKitWalletAdapter({
    async checkPolicy() {
      return "ALLOW";
    },
  });
  const wallet = await adapter.createWallet("worker-1");
  assert.equal(wallet.provider, "agentkit");
  assert.ok(wallet.address.startsWith("0x"));
});

test("reader failures surface instead of reading as ALLOW", async () => {
  const adapter = createAgentKitWalletAdapter({
    async checkPolicy() {
      throw new Error("rpc down");
    },
  });
  await assert.rejects(() => Promise.resolve(adapter.checkPolicy(SPEND)), /rpc down/);
});
