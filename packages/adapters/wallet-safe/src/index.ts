/**
 * Safe smart-account wallet adapter.
 * Mocked: stub Safe address only.
 * TODO: Integrate Safe{Core} / protocol-kit and map module guards to IPolicyModule.
 */

export interface SafeWallet {
  address: `0x${string}`;
  provider: "safe";
  /** Mocked threshold; unused until real Safe wiring. */
  threshold: number;
}

export async function createSafeWallet(owners: `0x${string}`[] = []): Promise<SafeWallet> {
  // TODO: Deploy or connect a Safe with session-key / allowance modules.
  void owners;
  return {
    address: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    provider: "safe",
    threshold: 1,
  };
}
