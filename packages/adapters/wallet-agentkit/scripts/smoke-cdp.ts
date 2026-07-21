/**
 * Live CDP smoke check (PRD F1.8).
 *
 * The adapter's unit tests drive the real SDK against a local stand-in, which
 * proves the wiring but not the account lifecycle against a production CDP
 * project. This script closes that gap and must be run deliberately: it
 * provisions real accounts on whatever project the credentials belong to.
 *
 *   CDP_API_KEY_ID=… CDP_API_KEY_SECRET=… CDP_WALLET_SECRET=… \
 *     pnpm --filter @lacrew/adapter-wallet-agentkit smoke:cdp
 *
 * Flags:
 *   --name=<seat>    CDP account name to provision (default lacrew-smoke)
 *   --network=<net>  network for balance reads (default base-sepolia)
 *   --faucet         request testnet funds; testnet networks only
 *
 * It never spends: it provisions, re-provisions to prove idempotency, and
 * reads. Exit code is non-zero if any check fails.
 */

import { createCdpWallet } from "../src/index.js";

type Args = { name: string; network: string; faucet: boolean };

function parseArgs(argv: string[]): Args {
  const get = (flag: string) =>
    argv.find((a) => a.startsWith(`--${flag}=`))?.split("=").slice(1).join("=");
  return {
    name: get("name") ?? "lacrew-smoke",
    network: get("network") ?? "base-sepolia",
    faucet: argv.includes("--faucet"),
  };
}

const checks: { label: string; ok: boolean; detail: string }[] = [];

function record(label: string, ok: boolean, detail: string): void {
  checks.push({ label, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const missing = ["CDP_API_KEY_ID", "CDP_API_KEY_SECRET", "CDP_WALLET_SECRET"].filter(
    (k) => !process.env[k],
  );
  if (missing.length > 0) {
    console.error(
      `Missing ${missing.join(", ")}. This check talks to a real CDP project; ` +
        "create keys at https://portal.cdp.coinbase.com/projects/api-keys.",
    );
    process.exit(2);
  }

  console.log(`CDP smoke — account "${args.name}" on ${args.network}\n`);

  const wallet = await createCdpWallet({ name: args.name });
  record(
    "provisions a smart account over its owner",
    wallet.kind === "smart" && /^0x[0-9a-fA-F]{40}$/.test(wallet.address),
    `${wallet.address} (owner ${wallet.ownerAddress})`,
  );

  // Provisioning must be idempotent per name, or a restart would strand funds
  // at an address the previous run used.
  const again = await createCdpWallet({ name: args.name });
  record(
    "re-provisioning returns the same account",
    again.address === wallet.address && again.ownerAddress === wallet.ownerAddress,
    again.address === wallet.address ? "stable across calls" : `drifted to ${again.address}`,
  );

  const server = await createCdpWallet({ name: args.name, smartAccount: false });
  record(
    "server-account mode returns the owner",
    server.kind === "server" && server.address === wallet.ownerAddress,
    server.address,
  );

  const { CdpClient } = await import("@coinbase/cdp-sdk");
  const cdp = new CdpClient();

  if (args.faucet) {
    if (!args.network.includes("sepolia")) {
      record("faucet", false, `refusing to request funds on non-testnet ${args.network}`);
    } else {
      const res = await cdp.evm.requestFaucet({
        address: wallet.address,
        network: args.network as "base-sepolia" | "ethereum-sepolia",
        token: "eth",
      });
      record("faucet funds requested", Boolean(res.transactionHash), res.transactionHash);
    }
  }

  const balances = await cdp.evm.listTokenBalances({
    address: wallet.address as `0x${string}`,
    network: args.network as Parameters<typeof cdp.evm.listTokenBalances>[0]["network"],
  });
  record(
    "reads token balances for the smart account",
    Array.isArray(balances.balances),
    `${balances.balances.length} balance(s): ` +
      (balances.balances
        .map((b) => `${b.amount.amount} ${b.token.symbol ?? b.token.contractAddress}`)
        .join(", ") || "none"),
  );

  const failed = checks.filter((c) => !c.ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed.`);
  if (failed.length > 0) process.exit(1);
}

main().catch((err) => {
  console.error(`\nSmoke check threw: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
