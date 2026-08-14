/**
 * The `WalletAdapter` conformance suite, shared by every wallet provider.
 *
 * It lives beside the interface rather than in any one adapter's tests because
 * the promises it checks are the reason feature code can depend on the
 * interface instead of a vendor SDK: the seat address a provider reports is
 * shaped like an address, and a verdict is either the chain's answer or an
 * error — never a guess. When those were asserted separately in each package,
 * "Safe does this" and "CDP does this" were four similar tests that could drift
 * apart one adapter at a time.
 *
 * Imported from `@lacrew/adapter-wallet-goat`, `-safe`, `-metamask` and this
 * package's own tests. It asserts with `node:assert` and registers no tests of
 * its own, so a caller keeps its own `test()` names and runner.
 */

import assert from "node:assert/strict";
import type { AdapterCheckInput, PolicyReader, WalletAdapter } from "./index.js";

/**
 * The spend every case is probed with. 200 USDC sits above `demoPolicyVerdict`'s
 * threshold, so an ALLOW returned for it cannot have come from the heuristic.
 */
export const CONTRACT_PROBE: AdapterCheckInput = {
  agent: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  target: "0x4444444444444444444444444444444444444444",
  value: 200n * 10n ** 6n,
  data: "0x",
};

export type WalletAdapterContractSubject = {
  /** The `provider` string every wallet from this adapter must report. */
  provider: string;
  /** The adapter built against a live policy module. */
  withReader: (reader: PolicyReader) => WalletAdapter | Promise<WalletAdapter>;
  /**
   * The same adapter with no reader bound. Omit only for the deliberately
   * mocked adapters, which answer from `demoPolicyVerdict` by design.
   */
  withoutReader?: () => WalletAdapter | Promise<WalletAdapter>;
  /**
   * Set when `createWallet()` resolves a seat address with no credentials and
   * no chain — Safe and CDP need both, so they opt out and cover provisioning
   * in their own fork/mock-server tests.
   */
  createsWalletOffline?: boolean;
};

/** Await a call that is expected to refuse, whether it throws or rejects. */
async function refusalFrom(call: () => unknown): Promise<string> {
  try {
    await call();
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  return assert.fail("expected a refusal, got a value");
}

/**
 * Hold one adapter to the shared contract. Throws on the first breach, so a
 * caller can run it inside a single `test()`.
 */
export async function assertWalletAdapterContract(
  subject: WalletAdapterContractSubject,
): Promise<void> {
  const seen: AdapterCheckInput[] = [];
  const reader: PolicyReader = {
    async checkPolicy(input) {
      seen.push(input);
      return "ALLOW";
    },
  };

  const bound = await subject.withReader(reader);
  assert.equal(bound.provider, subject.provider, "adapter reports the wrong provider");

  // The reader's answer, and the spend it was asked about, arrive intact.
  assert.equal(await bound.checkPolicy(CONTRACT_PROBE), "ALLOW");
  assert.deepEqual(seen, [CONTRACT_PROBE], "the spend reached the reader altered");

  // A reader that cannot answer must not read as permission.
  const failing = await subject.withReader({
    async checkPolicy() {
      throw new Error("rpc down");
    },
  });
  assert.match(
    await refusalFrom(() => failing.checkPolicy(CONTRACT_PROBE)),
    /rpc down/,
    "a reader failure was swallowed instead of surfacing",
  );

  if (subject.withoutReader) {
    const unbound = await subject.withoutReader();
    assert.match(
      await refusalFrom(() => unbound.checkPolicy(CONTRACT_PROBE)),
      /No PolicyReader bound/,
      "an unbound adapter answered instead of refusing",
    );
  }

  if (subject.createsWalletOffline) {
    const wallet = await bound.createWallet("contract-seat");
    assert.match(wallet.address, /^0x[0-9a-fA-F]{40}$/, "seat address is not an address");
    assert.equal(wallet.provider, subject.provider, "wallet reports a different provider");
  }
}
