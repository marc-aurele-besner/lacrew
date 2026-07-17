#!/usr/bin/env node
/**
 * LaCrew CLI — scaffold orgs, inspect mock state, run a local crew tick.
 * Mocked: no chain RPCs; uses @lacrew/sdk mock client.
 * TODO: Add `lacrew init`, real deploy helpers, and self-host docker compose.
 */

import { createLacrewClient } from "@lacrew/sdk";
import { CrewRuntime } from "@lacrew/orchestrator";
import { PROTOCOL_NAME, PROTOCOL_VERSION } from "@lacrew/core";

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
}

async function main(): Promise<void> {
  const [cmd = "help", ...rest] = process.argv.slice(2);
  const client = createLacrewClient({ useMock: true });

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
      const runtime = new CrewRuntime({ client });
      printJson(await runtime.tick());
      return;
    }

    case "propose": {
      // Usage: lacrew propose <agent> <target> <value>
      const [agent, target, valueRaw] = rest;
      if (!agent || !target || !valueRaw) {
        console.error("Usage: lacrew propose <agent> <target> <value>");
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
      const intentId = rest[0];
      if (!intentId) {
        console.error("Usage: lacrew approve <intentId>");
        process.exitCode = 1;
        return;
      }
      printJson(await client.resolveIntent(intentId, true));
      return;
    }

    case "deny": {
      const intentId = rest[0];
      if (!intentId) {
        console.error("Usage: lacrew deny <intentId>");
        process.exitCode = 1;
        return;
      }
      printJson(await client.resolveIntent(intentId, false));
      return;
    }

    case "help":
    default:
      console.log(`LaCrew CLI (Mocked)

Commands:
  version                 Print CLI version
  org                     Print mocked org tree
  allowances              Print mocked allowances
  intents                 List pending escalations
  audit                   Print mocked audit trail
  sessions                List mocked session keys
  tick                    Run one mocked worker tick (over-budget propose)
  propose <a> <t> <v>     Propose an intent (value as decimal string)
  approve <id>            Approve a pending intent
  deny <id>               Deny a pending intent

TODO: lacrew init / deploy / self-host commands
`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
