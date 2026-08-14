/**
 * The selector's job is to refuse what it does not recognise. Everything else
 * about a provider is that adapter package's own test; what is pinned here is
 * that a typo cannot become a default, and that every advertised id actually
 * loads an adapter honouring the shared contract.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { assertWalletAdapterContract } from "@lacrew/adapter-wallet-agentkit/contract";
import {
  parseWalletAdapterId,
  resolveWalletAdapterFactory,
  walletAdapterFromEnv,
  walletAdapterIdFromEnv,
  WALLET_ADAPTER_IDS,
} from "./walletAdapters.js";

/** Minimal per-provider options; none of these reach a chain or a credential. */
const OPTIONS: Record<string, Record<string, unknown>> = {
  agentkit: { name: "worker-1" },
  safe: {
    provider: "http://127.0.0.1:8545",
    owners: ["0x1111111111111111111111111111111111111111"],
  },
  metamask: {
    client: { getChainId: async () => 8453, getCode: async () => "0x" },
    owner: { address: "0x1111111111111111111111111111111111111111" },
  },
  goat: {
    wallet: {
      getAddress: () => "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      getChain: () => ({ type: "evm", id: 8453 }),
      sendTransaction: async () => ({ hash: "0x" }),
    },
  },
};

test("an unknown provider is a boot error naming the supported set", () => {
  assert.throws(() => parseWalletAdapterId("goattt"), /Unknown LACREW_WALLET_ADAPTER "goattt"/);
  assert.throws(() => parseWalletAdapterId("goattt"), /agentkit, safe, metamask, goat/);
  assert.throws(
    () => walletAdapterIdFromEnv({ LACREW_WALLET_ADAPTER: "cdp" }),
    /Unknown LACREW_WALLET_ADAPTER/,
  );
});

test("no provider configured is a valid deployment, an empty one is not a provider", async () => {
  assert.equal(walletAdapterIdFromEnv({}), undefined);
  assert.equal(walletAdapterIdFromEnv({ LACREW_WALLET_ADAPTER: "  " }), undefined);
  assert.equal(await walletAdapterFromEnv({}, {}), undefined);
});

test("surrounding whitespace does not make a known provider unknown", () => {
  assert.equal(walletAdapterIdFromEnv({ LACREW_WALLET_ADAPTER: " goat\n" }), "goat");
});

for (const id of WALLET_ADAPTER_IDS) {
  test(`${id} resolves to an adapter that honours the shared contract`, async () => {
    const options = OPTIONS[id]!;
    const factory = await resolveWalletAdapterFactory(id);

    await assertWalletAdapterContract({
      provider: id,
      withReader: (reader) => factory({ ...options, reader }),
      withoutReader: () => factory(options),
    });

    // ...and the env path reaches the same provider.
    const fromEnv = await walletAdapterFromEnv(options, { LACREW_WALLET_ADAPTER: id });
    assert.equal(fromEnv?.provider, id);
  });
}
