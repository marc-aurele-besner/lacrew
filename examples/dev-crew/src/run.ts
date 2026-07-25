/**
 * Runnable dev-crew demo (off-chain work, onchain budget).
 *
 *   pnpm --filter @lacrew/example-dev-crew start
 *   ORCH_URL=http://127.0.0.1:8788 pnpm --filter @lacrew/example-dev-crew start\n *   ANVIL_RPC=… PRIVATE_KEY=… pnpm --filter @lacrew/example-dev-crew start   # live chain
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  parseAbi,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { MOCK_WORKER, MOCK_MANAGER, getAddresses } from "@lacrew/core";
import {
  simulateIntentAction,
} from "@lacrew/sdk";
import { createLacrewClient } from "@lacrew/sdk/testing";
import {
  USDC,
  X402_VERSION,
  buildAuthorization,
  buildSettlementTxFromPayload,
  createPaymentRequirements,
  decodePaymentHeader,
  encodePaymentHeader,
  isAuthorizationUsed,
  networkForChainId,
  resolveDomain,
  signAuthorization,
  toWire,
  verifyAuthorization,
  type Eip712Domain,
  type PaymentPayload,
} from "@lacrew/x402";

const __dirname = dirname(fileURLToPath(import.meta.url));
const policy = JSON.parse(
  readFileSync(join(__dirname, "../policy.json"), "utf8"),
) as {
  name: string;
  latencyBoundary: string;
  demoSpends: Array<{
    label: string;
    agentRole: string;
    target: `0x${string}`;
    valueUsdc: number;
    x402?: boolean;
  }>;
  mcpTools: string[];
};

const ROLE_AGENTS: Record<string, `0x${string}`> = {
  coder: MOCK_WORKER,
  reviewer: "0x6666666666666666666666666666666666666666",
  ops: "0x5555555555555555555555555555555555555555",
  manager: MOCK_MANAGER,
};

const X402_RESOURCE = "https://api.example.com/v1/completions";

/**
 * Offline x402 demo: a genuinely signed and verified EIP-3009 authorization —
 * the signing and verification are the real `@lacrew/x402` code paths — that
 * is never settled, and says so. Settlement needs a chain (anvil mode).
 */
async function offlineX402Receipt(valueUsdc: number, payTo: `0x${string}`) {
  const asset = USDC["base-sepolia"]!;
  const payer = privateKeyToAccount(generatePrivateKey());
  const domain: Eip712Domain = {
    name: asset.name,
    version: asset.version,
    chainId: asset.chainId,
    verifyingContract: asset.address,
  };
  const requirements = createPaymentRequirements({
    network: "base-sepolia",
    payTo,
    maxAmountRequired: BigInt(valueUsdc) * 10n ** 6n,
    resource: X402_RESOURCE,
  });
  const authorization = buildAuthorization({
    from: payer.address,
    to: payTo,
    value: BigInt(valueUsdc) * 10n ** 6n,
  });
  const signature = await signAuthorization(payer, domain, authorization);
  const header = encodePaymentHeader({
    x402Version: X402_VERSION,
    scheme: "exact",
    network: "base-sepolia",
    payload: { signature, authorization: toWire(authorization) },
  } satisfies PaymentPayload);
  const verdict = await verifyAuthorization({
    domain,
    authorization,
    signature: decodePaymentHeader(header).payload.signature,
    requirements,
  });
  return {
    protocol: "x402",
    resource: X402_RESOURCE,
    amount: `${valueUsdc} USDC`,
    payer: payer.address,
    payTo,
    verified: verdict.valid,
    settled: false,
    note: "Authorization signed and verified locally — nothing settled. Run with ANVIL_RPC + PRIVATE_KEY to settle onchain.",
  };
}

/**
 * Real x402 settlement on the local chain: the ops seat (a payer wallet
 * holding zero ETH) signs an EIP-3009 authorization for the metered resource,
 * and the deployer relays it — one `transferWithAuthorization` call on
 * MockUSDC, no facilitator. This is the seat-pays-its-own-way rail, distinct
 * from the treasury allowance rail the proposes above exercise.
 */
async function anvilX402Receipt(opts: {
  rpc: string;
  chainId: number;
  valueUsdc: number;
}) {
  const addresses = getAddresses(opts.chainId);
  const token = addresses.mockUSDC;
  const payTo = addresses.x402Target;
  if (!token || !payTo) {
    throw new Error(`Chain ${opts.chainId} deployment has no mockUSDC/x402Target.`);
  }
  const chain = defineChain({
    id: opts.chainId,
    name: "lacrew-local",
    nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [opts.rpc] } },
  });
  const transport = http(opts.rpc);
  const publicClient = createPublicClient({ chain, transport });
  const relayer = privateKeyToAccount(process.env.PRIVATE_KEY as `0x${string}`);
  const relayerWallet = createWalletClient({ account: relayer, chain, transport });
  const value = BigInt(opts.valueUsdc) * 10n ** 6n;

  // The ops seat's spending wallet. Funded in mUSDC by the deployer (the mock
  // token's mint stands in for a streamed allowance) and never given ETH —
  // gasless payment is the property being demonstrated.
  const payer = privateKeyToAccount(generatePrivateKey());
  const tokenAbi = parseAbi([
    "function mint(address to, uint256 amount)",
    "function balanceOf(address) view returns (uint256)",
  ]);
  const mintHash = await relayerWallet.writeContract({
    address: token,
    abi: tokenAbi,
    functionName: "mint",
    args: [payer.address, value],
  });
  await publicClient.waitForTransactionReceipt({ hash: mintHash });
  if ((await publicClient.getBalance({ address: payer.address })) !== 0n) {
    throw new Error("Demo payer unexpectedly holds ETH; gasless claim would be untrue.");
  }

  // Resource server side: 402 requirements with the token's real domain.
  const domain = await resolveDomain(publicClient, token, opts.chainId);
  const requirements = createPaymentRequirements({
    network: networkForChainId(opts.chainId),
    payTo,
    maxAmountRequired: value,
    resource: X402_RESOURCE,
    asset: {
      address: token,
      decimals: 6,
      name: domain.name,
      version: domain.version,
      chainId: opts.chainId,
    },
  });

  // Payer side: sign, hand over the X-PAYMENT header.
  const authorization = buildAuthorization({
    from: payer.address,
    to: payTo,
    value,
  });
  const signature = await signAuthorization(payer, domain, authorization);
  const header = encodePaymentHeader({
    x402Version: X402_VERSION,
    scheme: "exact",
    network: networkForChainId(opts.chainId),
    payload: { signature, authorization: toWire(authorization) },
  } satisfies PaymentPayload);

  // Resource server side: verify before spending gas, then relay settlement.
  const payload = decodePaymentHeader(header);
  const verdict = await verifyAuthorization({
    domain,
    authorization,
    signature: payload.payload.signature,
    requirements,
  });
  if (!verdict.valid) {
    throw new Error(`x402 verification failed: ${verdict.reason}`);
  }
  const payeeBefore = (await publicClient.readContract({
    address: token,
    abi: tokenAbi,
    functionName: "balanceOf",
    args: [payTo],
  })) as bigint;
  const settlement = buildSettlementTxFromPayload(token, payload);
  const settleHash = await relayerWallet.sendTransaction({
    to: settlement.to,
    data: settlement.data,
    value: settlement.value,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: settleHash });
  const payeeAfter = (await publicClient.readContract({
    address: token,
    abi: tokenAbi,
    functionName: "balanceOf",
    args: [payTo],
  })) as bigint;
  const nonceBurned = await isAuthorizationUsed(
    publicClient,
    token,
    payer.address,
    authorization.nonce,
  );

  return {
    protocol: "x402",
    network: networkForChainId(opts.chainId),
    resource: X402_RESOURCE,
    amount: `${opts.valueUsdc} USDC`,
    payer: payer.address,
    payTo,
    settled: receipt.status === "success" && payeeAfter - payeeBefore === value,
    nonceBurned,
    txHash: settleHash,
  };
}

const orchHeaders: Record<string, string> = {
  "content-type": "application/json",
  ...(process.env.ORCH_TOKEN ? { authorization: `Bearer ${process.env.ORCH_TOKEN}` } : {}),
};

async function runViaOrch(base: string): Promise<void> {
  console.log(`[@lacrew/example-dev-crew] orch mode → ${base}`);
  for (const spend of policy.demoSpends) {
    const agent = ROLE_AGENTS[spend.agentRole] ?? MOCK_WORKER;
    const value = BigInt(spend.valueUsdc) * 10n ** 6n;
    const res = await fetch(`${base}/mcp/call`, {
      method: "POST",
      headers: orchHeaders,
      body: JSON.stringify({
        name: "lacrew_propose_intent",
        arguments: { agent, target: spend.target, value: value.toString() },
      }),
    });
    const body = (await res.json()) as {
      result?: { intentId?: string; verdict?: string };
    };
    console.log(`\n${spend.label}`);
    console.log(JSON.stringify(body, null, 2));
    if (spend.x402) {
      console.log("x402", await offlineX402Receipt(spend.valueUsdc, spend.target));
    }
  }
}

async function runViaMock(): Promise<void> {
  console.log("[@lacrew/example-dev-crew] mock SDK mode");
  console.log(`crew=${policy.name}`);
  console.log(`boundary: ${policy.latencyBoundary}`);
  console.log(`mcp tools: ${policy.mcpTools.join(", ")}`);

  const client = createLacrewClient({ useMock: true });
  for (const spend of policy.demoSpends) {
    const agent = ROLE_AGENTS[spend.agentRole] ?? MOCK_WORKER;
    const value = BigInt(spend.valueUsdc) * 10n ** 6n;
    try {
      const result = await client.proposeIntent({
        agent,
        target: spend.target,
        value,
      });
      const sim = simulateIntentAction({
        agent,
        target: spend.target,
        value,
        verdict: result.verdict,
      });
      console.log(`\n${spend.label}`);
      console.log({ intentId: result.intentId, verdict: result.verdict, simulation: sim });
      if (spend.x402) {
        console.log("x402", await offlineX402Receipt(spend.valueUsdc, spend.target));
      }
    } catch (err) {
      console.log(`\n${spend.label} → ${err instanceof Error ? err.message : err}`);
    }
  }

  const pending = await client.getPendingIntents();
  console.log(
    "\npending",
    pending.map((i) => ({
      id: i.id,
      value: i.value.toString(),
      verdict: i.verdict,
      simulation: i.simulation?.status,
    })),
  );
}


async function runViaAnvil(): Promise<void> {
  const { createRuntimeFromEnv } = await import("@lacrew/orchestrator");
  const boot = await createRuntimeFromEnv();
  if (!boot.ok) {
    // The example demonstrates the real thing. Printing an invented org tree
    // here is exactly the failure this change removes, so it stops instead.
    console.error(`[@lacrew/example-dev-crew] no chain (${boot.reason}): ${boot.detail}`);
    process.exitCode = 1;
    return;
  }
  const runtime = boot.runtime;
  console.log(`[@lacrew/example-dev-crew] anvil mode → chain ${runtime.chainId}`);
  console.log(`crew=${policy.name}`);

  const nodes = await runtime.getClient().getOrgTree();
  console.log(
    "org",
    nodes.map((n) => `${n.kind}:${n.account.slice(0, 10)}…`).join("  "),
  );

  for (const spend of policy.demoSpends) {
    const value = BigInt(spend.valueUsdc) * 10n ** 6n;
    try {
      // Session-signed propose for the deployed worker → whitelisted target;
      // policy.json targets are demo-only, the chain enforces the real ones.
      const result = await runtime.propose({ value });
      console.log(`\n${spend.label}`);
      console.log({ intentId: result.intentId, verdict: result.verdict, txHash: result.txHash });
      if (spend.x402) {
        console.log(
          "x402",
          await anvilX402Receipt({
            rpc: rpc!,
            chainId: runtime.chainId ?? 31337,
            valueUsdc: spend.valueUsdc,
          }),
        );
      }
    } catch (err) {
      console.log(`\n${spend.label} → ${err instanceof Error ? err.message : err}`);
    }
  }

  const pending = await runtime.listPending();
  console.log(
    "\npending",
    pending.map((i) => ({
      id: i.id,
      value: i.value.toString(),
      simulation: i.simulation?.status,
      warnings: i.simulation?.warnings,
    })),
  );

  const first = pending[0];
  if (first && process.env.MANAGER_PRIVATE_KEY) {
    const resolved = await runtime.resolve(first.id, true);
    console.log("\napproved", {
      intentId: first.id,
      escalated: resolved.escalated,
      txHash: resolved.txHash,
    });
  } else if (first) {
    console.log("\nset MANAGER_PRIVATE_KEY to approve the escalation");
  }
}

const rpc = process.env.ANVIL_RPC ?? process.env.RPC_URL;
const orch = process.env.ORCH_URL?.replace(/\/$/, "");
if (rpc && process.env.PRIVATE_KEY) {
  await runViaAnvil();
} else if (orch) {
  await runViaOrch(orch);
} else {
  await runViaMock();
}
