/**
 * Runnable trading-crew demo against the SDK mock client (or live orch HTTP).
 *
 *   pnpm --filter @lacrew/example-trading-crew start
 *   ORCH_URL=http://127.0.0.1:8788 pnpm --filter @lacrew/example-trading-crew start
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MOCK_WORKER, MOCK_MANAGER } from "@lacrew/core";
import { createLacrewClient, simulateIntentAction } from "@lacrew/sdk";

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
  }>;
  mcpTools: string[];
};

const ROLE_AGENTS: Record<string, `0x${string}`> = {
  executor: MOCK_WORKER,
  scanner: "0x5555555555555555555555555555555555555555",
  risk: MOCK_MANAGER,
};

async function runViaOrch(base: string): Promise<void> {
  console.log(`[@lacrew/example-trading-crew] orch mode → ${base}`);
  const health = await fetch(`${base}/health`).then((r) => r.json());
  console.log("health", health);

  const tools = await fetch(`${base}/mcp/tools`).then((r) => r.json());
  console.log(
    "mcp tools",
    (tools as { tools?: Array<{ name: string }> }).tools?.map((t) => t.name),
  );

  for (const spend of policy.demoSpends) {
    const agent = ROLE_AGENTS[spend.agentRole] ?? MOCK_WORKER;
    const value = BigInt(spend.valueUsdc) * 10n ** 6n;
    const res = await fetch(`${base}/mcp/call`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "lacrew_propose_intent",
        arguments: { agent, target: spend.target, value: value.toString() },
      }),
    });
    const body = await res.json();
    console.log(`\n${spend.label}`);
    console.log(JSON.stringify(body, null, 2));
  }

  const pending = await fetch(`${base}/intents`).then((r) => r.json());
  console.log("\npending intents", JSON.stringify(pending, null, 2));
}

async function runViaMock(): Promise<void> {
  console.log("[@lacrew/example-trading-crew] mock SDK mode");
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
      simulation: i.simulation,
    })),
  );
}

const orch = process.env.ORCH_URL?.replace(/\/$/, "");
if (orch) {
  await runViaOrch(orch);
} else {
  await runViaMock();
}
