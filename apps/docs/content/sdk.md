---
title: "SDK reference (`@lacrew/sdk`)"
---

Typed client for the LaCrew protocol. Prefer `createLacrewClient({ useMock: true })` for demos; switch to `createOnchainClient` when `ANVIL_RPC` + a deployer key are available.

## Install (workspace)

```bash
pnpm add @lacrew/sdk @lacrew/core
# until npm publish: workspace / file: links from lacrew.xyz
```

## Mock client

```ts
import { createLacrewClient } from "@lacrew/sdk";

const client = createLacrewClient({ useMock: true });

const tree = await client.getOrgTree();
const pending = await client.getPendingIntents();
const { intentId } = await client.proposeIntent({
  agent: "0x…",
  target: "0x…",
  value: 50n * 10n ** 6n,
});
await client.resolveIntent(intentId, true);
```

## Onchain client

```ts
import { createOnchainClient } from "@lacrew/sdk";
import { http } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const client = createOnchainClient({
  transport: http(process.env.ANVIL_RPC),
  account: privateKeyToAccount(process.env.PRIVATE_KEY as `0x${string}`),
  chainId: 31337,
});

await client.getOrgTree();
await client.runEpoch();
await client.proposeHire({ label: "Researcher", kind: "worker_agent" });
```

## Surface map

| Area           | Methods                                                                                                                                                         |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Org            | `getOrgTree`, `getAllowances`                                                                                                                                   |
| Policies       | `getNodePolicies` (per-node stacks + module params, `asset`-selectable), `readNodeRateRecorder`                                                                 |
| Policy deploys | `deployRateLimitPolicy`, `deployTimeWindowPolicy`, `deployPolicyStack` (inert until governance binds them)                                                      |
| Intents        | `proposeIntent`, `getPendingIntents`, `resolveIntent`                                                                                                           |
| Simulation     | `simulateResolveApproval`, `simulateApprovalStateDiffs` (eth_simulateV1 measured movements), `traceApprovalCalls` (callTracer)                                  |
| Governance     | `proposeHire` / `Fire` / `Reparent` / `SetGrant(s)` / `SetNodePolicy` / `SetNodeRateRecorder` / policy mutators (`asset`-selectable), `vote`, `veto`, `execute` |
| Sessions       | `getSessions`, `issueSession`, `revokeSession`                                                                                                                  |
| Payroll        | `runEpoch`, `getCurrentEpoch`, `getGrants`, `getTreasuryBalances`                                                                                               |

## Related

- Orchestrator HTTP wraps the same surface (`POST /tick`, `/intents/resolve`, `/governance/*`, `/epoch`).
- MCP tools: `@lacrew/adapter-agents-mcp` + `GET /mcp/tools` on the orchestrator.
- Vercel AI shape: `@lacrew/adapter-agents-vercel-ai`.

## TODO

- Generate this page from TypeDoc once the docs site (F1.14) lands.
- Document simulation results attached to pending intents (F1.16).
