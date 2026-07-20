#!/usr/bin/env node
/**
 * LaCrew CLI — init, deploy to Anvil, inspect mock or onchain state.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, readFileSync, copyFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createLacrewClient, createOnchainClient, type OnchainLacrewClient } from "@lacrew/sdk";
import { CrewRuntime, createEphemeralSession } from "@lacrew/orchestrator";
import {
  PROTOCOL_NAME,
  PROTOCOL_VERSION,
  getAddresses,
  ANVIL_CHAIN_ID,
} from "@lacrew/core";
import { http, parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { cmdFlows } from "./flows.js";
import { loadEnvFile } from "./env.js";
import { listTemplateIds, scaffoldTemplate } from "./scaffold.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../../..");

// Before any getAddresses() call, so the CLI and the orchestrator agree.
loadEnvFile(join(repoRoot, ".env"));

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
  const managerPk = process.env.MANAGER_PRIVATE_KEY as `0x${string}` | undefined;
  const resolverAccount = managerPk ? privateKeyToAccount(managerPk) : undefined;
  const indexerPath = process.env.INDEXER_PATH;

  return createOnchainClient({
    transport: http(rpcUrl),
    account,
    resolverAccount,
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

function cmdScaffold(args: string[]): void {
  const [template] = args.filter((a) => !a.startsWith("-"));
  if (!template) {
    console.log("Usage: lacrew scaffold <template> [--dir <path>]");
    console.log(`Templates: ${listTemplateIds().join(", ")}`);
    return;
  }
  try {
    const result = scaffoldTemplate({
      template,
      dir: flagValue(args, "--dir"),
      repoRoot,
    });
    console.log(`Scaffolded ${result.template.name} → ${result.dir}`);
    for (const file of result.files) console.log(`  ${file}`);
    console.log("Next: cd in, `pnpm install`, then `pnpm start` (mock) or set ORCH_URL.");
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
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

  const sepoliaRpc = process.env.SEPOLIA_RPC_URL ?? process.env.BASE_SEPOLIA_RPC_URL;
  if (!anvil && !sepoliaRpc && !hasFlag(args, "--rpc")) {
    console.error("Usage: lacrew deploy --anvil");
    console.error("       lacrew deploy --rpc <url>  (needs PRIVATE_KEY)");
    console.error("Ethereum Sepolia: set SEPOLIA_RPC_URL + PRIVATE_KEY (+ CHAIN_ID=11155111)");
    process.exitCode = 1;
    return;
  }

  const broadcastRpc = !anvil && sepoliaRpc ? sepoliaRpc : rpcUrl;

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
  if (cmd === "flows") {
    await cmdFlows(rest);
    return;
  }
  if (cmd === "scaffold") {
    cmdScaffold(rest);
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
      if ("getSessions" in client) {
        printJson(await client.getSessions());
      } else {
        printJson([]);
      }
      return;
    }

    case "session-revoke": {
      const cleaned = [...rest];
      const rpcIdx = cleaned.indexOf("--rpc");
      if (rpcIdx >= 0) cleaned.splice(rpcIdx, 2);
      const sessionId = cleaned[0];
      if (!sessionId) {
        console.error("Usage: lacrew session-revoke <sessionId> [--rpc]");
        process.exitCode = 1;
        return;
      }
      if (!("revokeSession" in client)) {
        console.error("session-revoke requires onchain client (--rpc + PRIVATE_KEY)");
        process.exitCode = 1;
        return;
      }
      printJson(await (client as { revokeSession: (id: string) => Promise<unknown> }).revokeSession(sessionId));
      return;
    }

    case "epoch": {
      if (!("runEpoch" in client)) {
        console.error("epoch requires onchain client (--rpc + PRIVATE_KEY)");
        process.exitCode = 1;
        return;
      }
      printJson(await (client as { runEpoch: () => Promise<unknown> }).runEpoch());
      return;
    }

    case "tick": {
      // Mock by default; --rpc (or ANVIL_RPC + PRIVATE_KEY) runs the session-signed onchain tick.
      const client = createClient(rest);
      const onchain = "publicClient" in client;
      const chainId = Number(process.env.CHAIN_ID ?? ANVIL_CHAIN_ID);
      const addresses = getAddresses(chainId);
      const runtime = onchain
        ? new CrewRuntime({
            client,
            mode: "onchain",
            chainId,
            workerAgent: addresses.worker,
            spendTarget: addresses.x402Target,
            managerAgent: addresses.manager,
          })
        : new CrewRuntime({ client });
      const valueRaw = flagValue(rest, "--value");
      printJson(await runtime.tick(valueRaw ? BigInt(valueRaw) : undefined));
      return;
    }

    case "propose": {
      const [agent, target, valueRaw] = rest.filter((a) => !a.startsWith("-"));
      if (!agent || !target || !valueRaw) {
        console.error("Usage: lacrew propose <agent> <target> <value> [--rpc]");
        process.exitCode = 1;
        return;
      }
      const agentAddr = agent as `0x${string}`;
      const targetAddr = target as `0x${string}`;
      const value = BigInt(valueRaw);

      // Onchain + SessionRegistry: issue an ephemeral key and sign propose with it.
      if (
        "issueSession" in client &&
        (client as OnchainLacrewClient).addresses?.sessionRegistry
      ) {
        const onchain = client as OnchainLacrewClient;
        const ephemeral = createEphemeralSession({
          agent: agentAddr,
          scopes: ["spend:whitelist", "propose:intent"],
        });
        const maxValue = process.env.SESSION_MAX_VALUE
          ? BigInt(process.env.SESSION_MAX_VALUE)
          : 200n * 10n ** 6n;
        const allowedTarget = (process.env.SESSION_ALLOWED_TARGET?.trim() ||
          targetAddr) as `0x${string}`;
        const { sessionId } = await onchain.issueSession({
          agent: ephemeral.agent,
          key: ephemeral.keyAddress!,
          expiresAtSec: ephemeral.expiresAtSec,
          scopesHash: ephemeral.scopesHash,
          maxValue,
          allowedTarget,
        });
        await onchain.fundEth(ephemeral.keyAddress!, parseEther("0.05"));
        const sessionAccount = privateKeyToAccount(ephemeral.privateKey);
        printJson({
          sessionId,
          keyAddress: ephemeral.keyAddress,
          maxValue: maxValue.toString(),
          allowedTarget,
          ...(await onchain.proposeIntent({
            agent: agentAddr,
            target: targetAddr,
            value,
            account: sessionAccount,
          })),
        });
        return;
      }

      printJson(
        await client.proposeIntent({
          agent: agentAddr,
          target: targetAddr,
          value,
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

    case "gov": {
      const cleaned = [...rest];
      const rpcIdx = cleaned.indexOf("--rpc");
      if (rpcIdx >= 0) cleaned.splice(rpcIdx, 2);
      const sub = cleaned[0];
      if (sub === "propose") {
        const tier = cleaned[1];
        const target = cleaned[2];
        const data = (cleaned[3] ?? "0x") as `0x${string}`;
        if (tier !== "low" && tier !== "high" || !target) {
          console.error("Usage: lacrew gov propose <low|high> <target> [dataHex] [--rpc]");
          process.exitCode = 1;
          return;
        }
        if (!("proposeGovernance" in client)) {
          console.error("Governance propose requires a client with proposeGovernance");
          process.exitCode = 1;
          return;
        }
        printJson(
          await (client as { proposeGovernance: Function }).proposeGovernance({
            tier,
            target: target as `0x${string}`,
            data,
          }),
        );
        return;
      }
      if (sub === "hire") {
        const label = cleaned[1];
        if (!label) {
          console.error("Usage: lacrew gov hire <label> [--rpc]");
          process.exitCode = 1;
          return;
        }
        if (!("proposeHire" in client)) {
          console.error("gov hire requires onchain client");
          process.exitCode = 1;
          return;
        }
        printJson(await (client as { proposeHire: Function }).proposeHire({ label }));
        return;
      }
      if (sub === "fire") {
        const account = cleaned[1] as `0x${string}` | undefined;
        if (!account) {
          console.error("Usage: lacrew gov fire <account> [--rpc]");
          process.exitCode = 1;
          return;
        }
        if (!("proposeFire" in client)) {
          console.error("gov fire requires onchain client");
          process.exitCode = 1;
          return;
        }
        printJson(await (client as { proposeFire: Function }).proposeFire({ account }));
        return;
      }
      if (sub === "reparent") {
        const account = cleaned[1] as `0x${string}` | undefined;
        const newParent = cleaned[2] as `0x${string}` | undefined;
        if (!account || !newParent) {
          console.error("Usage: lacrew gov reparent <account> <newParent> [--rpc]");
          process.exitCode = 1;
          return;
        }
        if (!("proposeReparent" in client)) {
          console.error("gov reparent requires onchain client");
          process.exitCode = 1;
          return;
        }
        printJson(
          await (client as { proposeReparent: Function }).proposeReparent({ account, newParent }),
        );
        return;
      }
      if (sub === "grant") {
        const account = cleaned[1] as `0x${string}` | undefined;
        const amountRaw = cleaned[2];
        if (!account || amountRaw === undefined) {
          console.error("Usage: lacrew gov grant <account> <amountWei> [--rpc]");
          process.exitCode = 1;
          return;
        }
        if (!("proposeSetGrant" in client)) {
          console.error("gov grant requires onchain client");
          process.exitCode = 1;
          return;
        }
        printJson(
          await (client as { proposeSetGrant: Function }).proposeSetGrant({
            account,
            amount: BigInt(amountRaw),
          }),
        );
        return;
      }
      if (sub === "whitelist") {
        const target = cleaned[1] as `0x${string}` | undefined;
        const allowed = cleaned[2] !== "no" && cleaned[2] !== "false";
        if (!target) {
          console.error("Usage: lacrew gov whitelist <target> [yes|no] [--rpc]");
          process.exitCode = 1;
          return;
        }
        if (!("proposeSetWhitelist" in client)) {
          console.error("gov whitelist requires onchain client");
          process.exitCode = 1;
          return;
        }
        printJson(
          await (client as { proposeSetWhitelist: Function }).proposeSetWhitelist({
            target,
            allowed,
          }),
        );
        return;
      }
      if (sub === "cap") {
        const agent = cleaned[1] as `0x${string}` | undefined;
        const capRaw = cleaned[2];
        if (!agent || capRaw === undefined) {
          console.error("Usage: lacrew gov cap <agent> <capWei> [--rpc]");
          process.exitCode = 1;
          return;
        }
        if (!("proposeSetAgentCap" in client)) {
          console.error("gov cap requires onchain client");
          process.exitCode = 1;
          return;
        }
        printJson(
          await (client as { proposeSetAgentCap: Function }).proposeSetAgentCap({
            agent,
            cap: BigInt(capRaw),
          }),
        );
        return;
      }
      if (sub === "policy") {
        const node = cleaned[1] as `0x${string}` | undefined;
        const policyModule = cleaned[2] as `0x${string}` | undefined;
        if (!node || !policyModule) {
          console.error("Usage: lacrew gov policy <node> <policyModule> [--rpc]");
          process.exitCode = 1;
          return;
        }
        if (!("proposeSetNodePolicy" in client)) {
          console.error("gov policy requires onchain client");
          process.exitCode = 1;
          return;
        }
        printJson(
          await (client as { proposeSetNodePolicy: Function }).proposeSetNodePolicy({
            node,
            policyModule,
          }),
        );
        return;
      }
      if (sub === "vote" || sub === "veto" || sub === "execute") {
        const id = cleaned[1];
        if (!id) {
          console.error(`Usage: lacrew gov ${sub} <proposalId> [--rpc]`);
          process.exitCode = 1;
          return;
        }
        if (sub === "vote") {
          const support = cleaned[2] !== "no";
          await (client as { voteGovernance: Function }).voteGovernance(id, support);
        } else if (sub === "veto") {
          await (client as { vetoGovernance: Function }).vetoGovernance(id);
        } else {
          await (client as { executeGovernance: Function }).executeGovernance(id);
        }
        printJson({ ok: true, proposalId: id, action: sub });
        return;
      }
      console.error(
        "Usage: lacrew gov <propose|hire|fire|reparent|grant|whitelist|cap|policy|vote|veto|execute> …",
      );
      process.exitCode = 1;
      return;
    }

    case "help":
    default:
      console.log(`LaCrew CLI

Commands:
  init                      Write .env.example + .lacrew/config.json
  deploy --anvil            Deploy MockOrg to Anvil and sync ABIs/addresses
  scaffold <template>       Generate a runnable crew project from a flow template
  version                   Print CLI version
  org [--rpc [url]]         Print org tree (mock or onchain)
  allowances [--rpc]        Print allowances
  intents [--rpc]           List pending escalations
  audit [--rpc]             Print audit trail (indexer when INDEXER_PATH set)
  sessions [--rpc]          List session keys (onchain SessionRegistry when --rpc)
  session-revoke <id> [--rpc]  Revoke a session (root/issuer key)
  epoch [--rpc]             Run next payroll epoch (EpochStreamer)
  tick                      Run one mocked worker tick
  propose <a> <t> <v>       Propose an intent
  approve <id> [approver]   Approve a pending intent
  deny <id> [approver]      Deny a pending intent
  gov propose <low|high> <target> [data]  Constitutional proposal
  gov hire <label>          Propose OrgRegistry.addNode (--rpc)
  gov fire <account>        Propose OrgRegistry.removeNode (--rpc)
  gov reparent <acct> <parent>  Propose OrgRegistry.reparent (--rpc)
  gov grant <acct> <amountWei>  Propose EpochStreamer.setGrant (high tier, --rpc)
  gov whitelist <target> [yes|no]  Propose WhitelistPolicy.setAllowed (--rpc)
  gov cap <agent> <capWei>  Propose SpendCapPolicy.setAgentCap (--rpc)
  gov policy <node> <module>  Propose EscalationRouter.setNodePolicy (--rpc)
  gov vote <id> [yes|no]    Vote on a proposal (onchain --rpc)
  gov veto <id>             Human-root veto (high tier, --rpc)
  gov execute <id>          Execute after quorum/timelock (--rpc)
  flows <sub>               Agent logic pipelines — templates, list, save,
                            run (--local offline, --as <agent>), runs, code
                            (see: lacrew flows help)

Env:
  ANVIL_RPC / RPC_URL       JSON-RPC endpoint
  PRIVATE_KEY               Deployer / writer key
  INDEXER_PATH              Local indexer JSON for audit/pending
  SEPOLIA_RPC_URL           Ethereum Sepolia deploy (first testnet)
  DATABASE_URL              Neon or Docker Postgres (pg-boss / @lacrew/db)
`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
