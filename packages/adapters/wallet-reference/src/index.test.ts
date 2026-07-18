import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createReferenceWallet,
  checkReferencePolicy,
  referenceWalletAdapter,
  referenceWalletDemoSpend,
} from "./index.js";

test("reference wallet is deterministic per label", async () => {
  const a = await createReferenceWallet("alpha");
  const b = await createReferenceWallet("alpha");
  assert.equal(a.address, b.address);
  assert.equal(referenceWalletAdapter.provider, "reference");
});

test("policy check escalates over cap", () => {
  const v = checkReferencePolicy({
    agent: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    target: "0x4444444444444444444444444444444444444444",
    value: 200n * 10n ** 6n,
    data: "0x",
  });
  assert.equal(v, "ESCALATE");
});

test("demo spend returns verdict", async () => {
  const out = await referenceWalletDemoSpend({
    target: "0x4444444444444444444444444444444444444444",
    value: 75n * 10n ** 6n,
  });
  assert.ok(out.wallet.address.startsWith("0x"));
  assert.ok(out.verdict === "ALLOW" || out.verdict === "ESCALATE");
});
