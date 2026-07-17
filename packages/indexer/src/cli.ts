#!/usr/bin/env node
/**
 * CLI: watch EscalationRouter events into a local JSON file.
 *
 * Needs a JSON-RPC endpoint (Anvil by default). Without it, waits quietly.
 *
 *   # Terminal A
 *   anvil
 *   # Terminal B
 *   pnpm --filter @lacrew/cli exec tsx src/index.ts deploy --anvil
 *   # Terminal C
 *   pnpm --filter @lacrew/indexer dev
 */

import { resolve } from "node:path";
import { EventWatcher } from "./watcher.js";

const rpcUrl = process.env.ANVIL_RPC ?? process.env.RPC_URL ?? "http://127.0.0.1:8545";
const storePath = resolve(process.env.INDEXER_PATH ?? ".lacrew/indexer.json");
const chainId = Number(process.env.CHAIN_ID ?? 31337);
const pollMs = Number(process.env.INDEXER_RPC_POLL_MS ?? 3000);

async function rpcReady(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
      signal: AbortSignal.timeout(1500),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function waitForRpc(url: string): Promise<void> {
  if (await rpcReady(url)) return;

  console.log(`[@lacrew/indexer] waiting for RPC at ${url}`);
  console.log(`[@lacrew/indexer] start Anvil in another terminal: anvil`);
  console.log(`[@lacrew/indexer] then deploy: pnpm --filter @lacrew/cli exec tsx src/index.ts deploy --anvil`);

  for (;;) {
    await new Promise((r) => setTimeout(r, pollMs));
    if (await rpcReady(url)) {
      console.log(`[@lacrew/indexer] RPC ready`);
      return;
    }
  }
}

await waitForRpc(rpcUrl);

const watcher = new EventWatcher({ rpcUrl, storePath, chainId });
watcher.start();

process.on("SIGINT", () => {
  watcher.stop();
  process.exit(0);
});
