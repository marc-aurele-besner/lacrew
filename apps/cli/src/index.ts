#!/usr/bin/env node
/**
 * LaCrew CLI — scaffold orgs, inspect mock state, run a local crew tick.
 * Mocked: no chain RPCs; uses @lacrew/sdk mock client.
 * TODO: Add `lacrew init`, real deploy helpers, and self-host docker compose.
 */

import { createLacrewClient } from "@lacrew/sdk";
import { CrewRuntime } from "@lacrew/orchestrator";
import { PROTOCOL_NAME, PROTOCOL_VERSION } from "@lacrew/core";

async function main(): Promise<void> {
  const [cmd = "help", ...rest] = process.argv.slice(2);
  const client = createLacrewClient({ useMock: true });

  switch (cmd) {
    case "version":
      console.log(`${PROTOCOL_NAME} CLI ${PROTOCOL_VERSION}`);
      return;

    case "org": {
      const tree = await client.getOrgTree();
      console.log(JSON.stringify(tree, null, 2));
      return;
    }

    case "allowances": {
      const allowances = await client.getAllowances();
      console.log(
        JSON.stringify(allowances, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2),
      );
      return;
    }

    case "intents": {
      const intents = await client.getPendingIntents();
      console.log(
        JSON.stringify(intents, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2),
      );
      return;
    }

    case "tick": {
      const runtime = new CrewRuntime({ client });
      const result = await runtime.tick();
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    case "approve": {
      const intentId = rest[0];
      if (!intentId) {
        console.error("Usage: lacrew approve <intentId>");
        process.exitCode = 1;
        return;
      }
      const intent = await client.resolveIntent(intentId, true);
      console.log(
        JSON.stringify(intent, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2),
      );
      return;
    }

    case "help":
    default:
      console.log(`LaCrew CLI (Mocked)

Commands:
  version       Print CLI version
  org           Print mocked org tree
  allowances    Print mocked allowances
  intents       List pending escalations
  tick          Run one mocked worker tick (proposes over-budget intent)
  approve <id>  Approve a pending intent in the mock client

TODO: lacrew init / deploy / self-host commands
`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
