#!/usr/bin/env node
/**
 * CLI: watch EscalationRouter events into a local JSON file.
 *
 *   pnpm --filter @lacrew/indexer dev
 *   INDEXER_PATH=./.lacrew/indexer.json ANVIL_RPC=http://127.0.0.1:8545 …
 */

import { resolve } from "node:path";
import { EventWatcher } from "./watcher.js";

const rpcUrl = process.env.ANVIL_RPC ?? process.env.RPC_URL ?? "http://127.0.0.1:8545";
const storePath = resolve(
  process.env.INDEXER_PATH ?? ".lacrew/indexer.json",
);
const chainId = Number(process.env.CHAIN_ID ?? 31337);

const watcher = new EventWatcher({ rpcUrl, storePath, chainId });
watcher.start();

process.on("SIGINT", () => {
  watcher.stop();
  process.exit(0);
});
