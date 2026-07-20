/**
 * Orchestrator bootstrap: Hono app (httpApp.ts) served over node:http so the
 * reusePort/shutdown helpers keep working. Mocked by default; onchain when
 * ANVIL_RPC + PRIVATE_KEY are set.
 * Queue: QueueProvider — pg-boss when DATABASE_URL set, else in-memory.
 */

import { createServer } from "node:http";
import { getRequestListener } from "@hono/node-server";
import { checkDbReady, getDatabaseUrl, runDbMigrations } from "@lacrew/db";
import { getOrchToken } from "./auth.js";
import { createRuntimeFromEnv } from "./runtime.js";
import { createRuntimeMcpBackend } from "./mcpBackend.js";
import { createFlowsSurface } from "./flows.js";
import { createQueueFromEnv, type QueueProvider } from "./queue/index.js";
import { createModelProviderFromEnv, type ModelProvider } from "./model/index.js";
import { installShutdownHooks, listenHttp } from "./httpListen.js";
import { createOrchestratorApp } from "./httpApp.js";

const runtime = createRuntimeFromEnv();
const port = Number(process.env.PORT ?? 8788);
const queue: QueueProvider = createQueueFromEnv();
const model: ModelProvider = createModelProviderFromEnv();
/** MCP HTTP binds to the live runtime; LACREW_MCP_MOCK=1 forces a detached SDK mock. */
const mcpUseMock = process.env.LACREW_MCP_MOCK === "1";
const mcpBackend = mcpUseMock ? undefined : createRuntimeMcpBackend(runtime);
const flows = createFlowsSurface({ runtime, model, mcpBackend });
const authToken = getOrchToken();
let dbReady = false;

const app = createOrchestratorApp({
  runtime,
  queue,
  model,
  flows,
  mcpBackend,
  mcpUseMock,
  authToken,
  isDbReady: () => dbReady,
  isDbConfigured: () => Boolean(getDatabaseUrl()),
});

const server = createServer(getRequestListener(app.fetch));

let migrationsRan = false;

async function main(): Promise<void> {
  dbReady = await checkDbReady();
  if (dbReady) {
    // Before anything queries. A pulled-but-unapplied migration otherwise
    // surfaces as a bare "column does not exist" at hydrate time, which reads
    // like a code bug instead of a schema that was never migrated.
    try {
      const migrated = await runDbMigrations();
      if (!migrated.skipped) migrationsRan = true;
    } catch (err) {
      console.error("[@lacrew/orchestrator] migrations failed:", err);
      dbReady = false;
    }
  }
  if (dbReady) {
    const replayed = await runtime.hydrateAudit();
    if (replayed > 0) {
      console.log(`[@lacrew/orchestrator] audit ring hydrated with ${replayed} persisted events`);
    }
  }
  const hydrated = await flows.hydrate();
  if (hydrated.flows > 0 || hydrated.runs > 0) {
    console.log(
      `[@lacrew/orchestrator] flows hydrated: ${hydrated.flows} definitions, ${hydrated.runs} runs (${flows.storeName})`,
    );
  }

  await queue.start({
    onEpoch: async () => {
      let result: unknown;
      try {
        result = await runtime.runEpoch();
      } catch (err) {
        console.error("[@lacrew/orchestrator] scheduled epoch failed:", err);
      }
      await flows.runTriggered("epoch");
      return result;
    },
    onTick: async () => runtime.tick(),
  });

  // pg-boss: EPOCH_CRON (default hourly). memory: EPOCH_INTERVAL_MS (>0) opt-in.
  await queue.scheduleEpoch(process.env.EPOCH_CRON ?? "0 * * * *");
  // Cron-triggered flows (F1.17): minute-resolution, provider-agnostic.
  flows.startCron();

  installShutdownHooks(server, async () => {
    flows.stopCron();
    await queue.stop();
  });

  await listenHttp(server, port, () => {
    const q = queue.status();
    console.log(
      `[@lacrew/orchestrator] ${runtime.mode} server listening on :${port}` +
        (runtime.chainId != null ? ` (chain ${runtime.chainId})` : "") +
        ` queue=${q.provider}` +
        (q.epochSchedule ? ` epoch=${q.epochSchedule}` : "") +
        ` model=${model.name}` +
        ` auth=${authToken ? "on" : "off"}` +
        ` db=${dbReady ? "ready" : getDatabaseUrl() ? "unreachable" : "off"}` +
        ` migrations=${migrationsRan ? "ok" : "skipped"}`,
    );
  });
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
