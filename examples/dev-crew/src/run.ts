/**
 * Runnable dev-crew demo (off-chain work, onchain budget).
 *
 *   pnpm --filter @lacrew/example-dev-crew start
 *   ORCH_URL=http://127.0.0.1:8788 pnpm --filter @lacrew/example-dev-crew start\n *   ANVIL_RPC=… PRIVATE_KEY=… pnpm --filter @lacrew/example-dev-crew start   # live chain
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MOCK_WORKER, MOCK_MANAGER } from "@lacrew/core";
import {
  simulateIntentAction,
} from "@lacrew/sdk";
import { createLacrewClient } from "@lacrew/sdk/testing";

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

/** Mocked x402-style payment receipt against an allowance (not a real HTTP 402). */
function mockX402Receipt(input: {
  agent: string;
  target: string;
  valueUsdc: number;
  verdict: string;
}) {
  return {
    protocol: "x402-mock",
    resource: "https://api.example.com/v1/completions",
    amount: `${input.valueUsdc} USDC`,
    payer: input.agent,
    payTo: input.target,
    status: input.verdict === "ALLOW" ? "paid" : "held_for_approval",
    note: "Demo only — real x402 settles from the funded smart account allowance.",
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
      console.log(
        "x402",
        mockX402Receipt({
          agent,
          target: spend.target,
          valueUsdc: spend.valueUsdc,
          verdict: body.result?.verdict ?? "ESCALATE",
        }),
      );
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
        console.log(
          "x402",
          mockX402Receipt({
            agent,
            target: spend.target,
            valueUsdc: spend.valueUsdc,
            verdict: result.verdict,
          }),
        );
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
          mockX402Receipt({
            agent: runtime.defaultAgent,
            target: runtime.defaultSpendTarget,
            valueUsdc: spend.valueUsdc,
            verdict: result.verdict,
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
