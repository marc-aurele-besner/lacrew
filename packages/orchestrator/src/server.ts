/**
 * Orchestrator bootstrap: Hono app (httpApp.ts) served over node:http so the
 * reusePort/shutdown helpers keep working.
 *
 * Requires a reachable chain — there is no mock fallback. When one cannot be
 * built the process still listens and serves `createUnavailableApp`, so callers
 * get a reason instead of a connection refused, and 503 instead of an empty org.
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
import { createOrchestratorApp, createUnavailableApp } from "./httpApp.js";

const port = Number(process.env.PORT ?? 8788);
const queue: QueueProvider = createQueueFromEnv();
const model: ModelProvider = createModelProviderFromEnv();
/** MCP HTTP binds to the live runtime; LACREW_MCP_MOCK=1 forces a detached SDK mock. */
const mcpUseMock = process.env.LACREW_MCP_MOCK === "1";
const authToken = getOrchToken();
let dbReady = false;

let migrationsRan = false;

async function main(): Promise<void> {
  dbReady = await checkDbReady();

  const boot = await createRuntimeFromEnv();
  if (!boot.ok) {
    // Listen anyway. A process that refuses to start is indistinguishable from
    // one that crashed, and the caller needs to know *which* thing is missing.
    console.error(
      `[@lacrew/orchestrator] no chain (${boot.reason}): ${boot.detail}`,
    );
    const server = createServer(
      getRequestListener(
        createUnavailableApp({
          reason: boot.reason,
          detail: boot.detail,
          isDbReady: () => dbReady,
          isDbConfigured: () => Boolean(getDatabaseUrl()),
          ...(authToken ? { authToken } : {}),
        }).fetch,
      ),
    );
    installShutdownHooks(server, async () => {});
    await listenHttp(server, port, () => {
      console.log(
        `[@lacrew/orchestrator] listening on :${port} with no chain — every data route answers 503 (${boot.reason})`,
      );
    });
    return;
  }
  const runtime = boot.runtime;
  const mcpBackend = mcpUseMock ? undefined : createRuntimeMcpBackend(runtime);
  const flows = createFlowsSurface({ runtime, model, mcpBackend });
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
    // Reclaim sealed session keys so a restart reuses the live onchain sessions
    // rather than issuing — and gas-funding — replacements for them.
    try {
      const sessions = await runtime.hydrateSessions();
      if (sessions > 0) {
        console.log(`[@lacrew/orchestrator] ${sessions} session key(s) restored from store`);
      }
    } catch (err) {
      // Never fatal: the runtime issues fresh sessions on demand, so a failure
      // here costs gas, not correctness.
      console.error("[@lacrew/orchestrator] session hydration failed:", err);
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
    onFlowCron: async () => flows.runCronDue(),
  });

  // pg-boss: EPOCH_CRON (default hourly). memory: EPOCH_INTERVAL_MS (>0) opt-in.
  await queue.scheduleEpoch(process.env.EPOCH_CRON ?? "0 * * * *");
  // Cron-triggered flows (F1.17) sweep every minute through the queue, so a
  // multi-replica deployment fires each due flow once rather than once each.
  await queue.scheduleFlowCron("* * * * *");

  installShutdownHooks(server, async () => {
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
