#!/usr/bin/env node
/**
 * LaCrew CLI — init, deploy to Anvil, inspect mock or onchain state.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, readFileSync, copyFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createLacrewClient, createOnchainClient } from "@lacrew/sdk";
import { CrewRuntime } from "@lacrew/orchestrator";
import {
  PROTOCOL_NAME,
  PROTOCOL_VERSION,
  getAddresses,
  ANVIL_CHAIN_ID,
} from "@lacrew/core";
import { http } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../../..");

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

function flagValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  if (i >= 0 && args[i + 1] && !args[i + 1]!.startsWith("-")) return args[i + 1];
  return undefined;
}

function createClient(args: string[]) {
  const rpc =
    flagValue(args, "--rpc") ??
    process.env.ANVIL_RPC ??
    process.env.RPC_URL ??
    (hasFlag(args, "--rpc") ? "http://127.0.0.1:8545" : undefined);

  if (!rpc && !hasFlag(args, "--rpc")) {
    return createLacrewClient({ useMock: true });
  }

  const rpcUrl = rpc ?? "http://127.0.0.1:8545";
  const chainId = Number(process.env.CHAIN_ID ?? ANVIL_CHAIN_ID);
  const addresses = getAddresses(chainId);
  const pk = process.env.PRIVATE_KEY as `0x${string}` | undefined;
  const account = pk ? privateKeyToAccount(pk) : undefined;
  const indexerPath = process.env.INDEXER_PATH;

  return createOnchainClient({
    transport: http(rpcUrl),
    account,
    chainId,
    addresses,
    indexerPath,
  });
}

function cmdInit(): void {
  const cwd = process.cwd();
  const envExample = `# LaCrew local config
ANVIL_RPC=http://127.0.0.1:8545
CHAIN_ID=31337
# Anvil default key (do not use on mainnet)
PRIVATE_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
HUMAN_ROOT=
INDEXER_PATH=.lacrew/indexer.json
# Optional address overrides after deploy
# LACREW_ORG_REGISTRY=
# LACREW_TREASURY=
# LACREW_ESCALATION_ROUTER=
`;
  const config = {
    chainId: 31337,
    rpcUrl: "http://127.0.0.1:8545",
    createdAt: new Date().toISOString(),
  };

  mkdirSync(join(cwd, ".lacrew"), { recursive: true });
  writeFileSync(join(cwd, ".env.example"), envExample);
  writeFileSync(join(cwd, ".lacrew/config.json"), `${JSON.stringify(config, null, 2)}\n`);
  if (!existsSync(join(cwd, ".env"))) {
    writeFileSync(join(cwd, ".env"), envExample);
  }
  console.log("Wrote .env.example, .env (if missing), and .lacrew/config.json");
  console.log("Next: start Anvil, then `lacrew deploy --anvil`");
}

function cmdDeploy(args: string[]): void {
  const anvil = hasFlag(args, "--anvil");
  const contractsDir = join(repoRoot, "contracts");
  if (!existsSync(join(contractsDir, "foundry.toml"))) {
    console.error("Could not find contracts/foundry.toml — run from lacrew monorepo");
    process.exitCode = 1;
    return;
  }

  const rpcUrl =
    flagValue(args, "--rpc") ??
    process.env.ANVIL_RPC ??
    process.env.RPC_URL ??
    "http://127.0.0.1:8545";
  const privateKey =
    process.env.PRIVATE_KEY ??
    "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

  if (!anvil && !process.env.BASE_SEPOLIA_RPC_URL && !hasFlag(args, "--rpc")) {
    console.error("Usage: lacrew deploy --anvil");
    console.error("       lacrew deploy --rpc <url>  (needs PRIVATE_KEY)");
    console.error("Base Sepolia: set BASE_SEPOLIA_RPC_URL + PRIVATE_KEY");
    process.exitCode = 1;
    return;
  }

  const broadcastRpc =
    !anvil && process.env.BASE_SEPOLIA_RPC_URL
      ? process.env.BASE_SEPOLIA_RPC_URL
      : rpcUrl;

  console.log(`Deploying MockOrg via forge script → ${broadcastRpc}`);
  const forge = spawnSync(
    "forge",
    [
      "script",
      "script/DeployMockOrg.s.sol:DeployMockOrg",
      "--rpc-url",
      broadcastRpc,
      "--private-key",
      privateKey,
      "--broadcast",
    ],
    { cwd: contractsDir, encoding: "utf8", stdio: "inherit" },
  );
  if (forge.status !== 0) {
    process.exitCode = forge.status ?? 1;
    return;
  }

  // Sync ABIs + deployments into @lacrew/core
  const sync = spawnSync("node", ["packages/core/scripts/sync-abis.mjs"], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: "inherit",
  });
  if (sync.status !== 0) {
    process.exitCode = sync.status ?? 1;
    return;
  }

  // Copy deployment into cwd .lacrew if present
  const chainId = anvil ? "31337" : String(process.env.CHAIN_ID ?? "31337");
  const src = join(contractsDir, "deployments", `${chainId}.json`);
  if (existsSync(src)) {
    mkdirSync(join(process.cwd(), ".lacrew"), { recursive: true });
    copyFileSync(src, join(process.cwd(), ".lacrew", `deployments-${chainId}.json`));
    console.log(`Wrote .lacrew/deployments-${chainId}.json`);
    console.log(readFileSync(src, "utf8"));
  }
  console.log("Deploy complete. Run: lacrew org --rpc");
}

async function main(): Promise<void> {
  const [cmd = "help", ...rest] = process.argv.slice(2);

  if (cmd === "init") {
    cmdInit();
    return;
  }
  if (cmd === "deploy") {
    cmdDeploy(rest);
    return;
  }

  const client = createClient(rest);

  switch (cmd) {
    case "version":
      console.log(`${PROTOCOL_NAME} CLI ${PROTOCOL_VERSION}`);
      return;

    case "org": {
      printJson(await client.getOrgTree());
      return;
    }

    case "allowances": {
      printJson(await client.getAllowances());
      return;
    }

    case "intents": {
      printJson(await client.getPendingIntents());
      return;
    }

    case "audit": {
      printJson(await client.getAuditTrail());
      return;
    }

    case "sessions": {
      printJson(await client.getSessions());
      return;
    }

    case "tick": {
      // Mocked crew tick; onchain tick loop is TODO.
      const runtime = new CrewRuntime({ client: createLacrewClient({ useMock: true }) });
      printJson(await runtime.tick());
      return;
    }

    case "propose": {
      const [agent, target, valueRaw] = rest.filter((a) => !a.startsWith("-"));
      if (!agent || !target || !valueRaw) {
        console.error("Usage: lacrew propose <agent> <target> <value> [--rpc]");
        process.exitCode = 1;
        return;
      }
      printJson(
        await client.proposeIntent({
          agent: agent as `0x${string}`,
          target: target as `0x${string}`,
          value: BigInt(valueRaw),
        }),
      );
      return;
    }

    case "approve": {
      const positional = rest.filter((a) => !a.startsWith("-") && a !== flagValue(rest, "--rpc"));
      // strip rpc url if present after --rpc
      const cleaned = [...rest];
      const rpcIdx = cleaned.indexOf("--rpc");
      if (rpcIdx >= 0) cleaned.splice(rpcIdx, 2);
      const intentId = cleaned[0];
      if (!intentId) {
        console.error("Usage: lacrew approve <intentId> [approver] [--rpc]");
        process.exitCode = 1;
        return;
      }
      const approver = cleaned[1] as `0x${string}` | undefined;
      printJson(await client.resolveIntent(intentId, true, approver));
      return;
    }

    case "deny": {
      const cleaned = [...rest];
      const rpcIdx = cleaned.indexOf("--rpc");
      if (rpcIdx >= 0) cleaned.splice(rpcIdx, 2);
      const intentId = cleaned[0];
      if (!intentId) {
        console.error("Usage: lacrew deny <intentId> [approver] [--rpc]");
        process.exitCode = 1;
        return;
      }
      const approver = cleaned[1] as `0x${string}` | undefined;
      printJson(await client.resolveIntent(intentId, false, approver));
      return;
    }

    case "help":
    default:
      console.log(`LaCrew CLI

Commands:
  init                      Write .env.example + .lacrew/config.json
  deploy --anvil            Deploy MockOrg to Anvil and sync ABIs/addresses
  version                   Print CLI version
  org [--rpc [url]]         Print org tree (mock or onchain)
  allowances [--rpc]        Print allowances
  intents [--rpc]           List pending escalations
  audit [--rpc]             Print audit trail (indexer when INDEXER_PATH set)
  sessions                  List session keys (mock)
  tick                      Run one mocked worker tick
  propose <a> <t> <v>       Propose an intent
  approve <id> [approver]   Approve a pending intent
  deny <id> [approver]      Deny a pending intent

Env:
  ANVIL_RPC / RPC_URL       JSON-RPC endpoint
  PRIVATE_KEY               Deployer / writer key
  INDEXER_PATH              Local indexer JSON for audit/pending
  BASE_SEPOLIA_RPC_URL      Optional testnet deploy path
`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
