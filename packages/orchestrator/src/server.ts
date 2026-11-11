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
import { closeSharedDb } from "./dbPool.js";
import { createRuntimeFromEnv } from "./runtime.js";
import { createQueueFromEnv, type QueueProvider } from "./queue/index.js";
import { createModelProviderFromEnv, type ModelProvider } from "./model/index.js";
import { installShutdownHooks, listenHttp } from "./httpListen.js";
import { autoExecuteEnabled } from "./governanceSweep.js";
import { createUnavailableApp } from "./httpApp.js";
import { createOrgWorld } from "./orgWorld.js";

const port = Number(process.env.PORT ?? 8788);
const queue: QueueProvider = createQueueFromEnv();
/** The vendor client. Each org wraps it in its own cost guard before anything uses it. */
const rawModel: ModelProvider = createModelProviderFromEnv();
/** MCP HTTP binds to the live runtime; LACREW_MCP_MOCK=1 forces a detached SDK mock. */
const mcpUseMock = process.env.LACREW_MCP_MOCK === "1";
const authToken = getOrchToken();
/** Bind address. Unset = every interface (containers); `127.0.0.1` keeps a laptop's orchestrator local. */
const host = process.env.LACREW_ORCH_HOST?.trim() || undefined;
let dbReady = false;

if (!authToken) {
  // An open orchestrator is a local-demo convenience. It still holds a real
  // key, so the choice is made loudly rather than discovered later.
  console.warn(
    "[@lacrew/orchestrator] LACREW_ORCH_TOKEN is unset: every route is open to anything that can reach " +
      `this port${host ? "" : " on every interface"}. Set it (and LACREW_ORCH_HOST=127.0.0.1 for a local demo) before exposing the process.`,
  );
}

let migrationsRan = false;

async function main(): Promise<void> {
  dbReady = await checkDbReady();

  const boot = await createRuntimeFromEnv();
  if (!boot.ok) {
    // Listen anyway. A process that refuses to start is indistinguishable from
    // one that crashed, and the caller needs to know *which* thing is missing.
    console.error(`[@lacrew/orchestrator] no chain (${boot.reason}): ${boot.detail}`);
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
    await listenHttp(
      server,
      port,
      () => {
        console.log(
          `[@lacrew/orchestrator] listening on ${host ?? ""}:${port} with no chain — every data route answers 503 (${boot.reason})`,
        );
      },
      { ...(host ? { host } : {}) },
    );
    return;
  }
  const runtime = boot.runtime;
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
  const world = await createOrgWorld(
    runtime.orgId,
    { runtime, env: process.env },
    {
      queue,
      model: rawModel,
      ...(authToken ? { authToken } : {}),
      mcpUseMock,
      isDbReady: () => dbReady,
      isDbConfigured: () => Boolean(getDatabaseUrl()),
    },
  );
  const server = createServer(getRequestListener(world.app.fetch));

  await queue.start({
    onEpoch: world.onEpoch,
    onTick: world.onTick,
    onWebhook: world.onWebhook,
    onFlowCron: world.onFlowCron,
  });

  // pg-boss: EPOCH_CRON (default hourly). memory: EPOCH_INTERVAL_MS (>0) opt-in.
  // A cadence set at runtime persists in the durable queue, so honor an existing
  // schedule rather than clobbering it with the env default on every restart.
  const existingEpochCron = await queue.getScheduledEpochCron();
  await queue.scheduleEpoch(existingEpochCron ?? process.env.EPOCH_CRON ?? "0 * * * *");
  // Cron-triggered flows (F1.17) sweep every minute through the queue, so a
  // multi-replica deployment fires each due flow once rather than once each.
  await queue.scheduleFlowCron("* * * * *");

  installShutdownHooks(server, async () => {
    await queue.stop();
    await world.close();
    // Last: every store above writes through this pool.
    await closeSharedDb();
  });

  await listenHttp(
    server,
    port,
    () => {
      const q = queue.status();
      console.log(
        `[@lacrew/orchestrator] ${runtime.mode} server listening on ${host ?? ""}:${port}` +
          (runtime.chainId != null ? ` (chain ${runtime.chainId})` : "") +
          ` queue=${q.provider}` +
          (q.epochSchedule ? ` epoch=${q.epochSchedule}` : "") +
          ` model=${rawModel.name}` +
          ` auth=${authToken ? "on" : "off"}` +
          (autoExecuteEnabled() ? " gov-auto-execute=on" : "") +
          ` db=${dbReady ? "ready" : getDatabaseUrl() ? "unreachable" : "off"}` +
          ` migrations=${migrationsRan ? "ok" : "skipped"}`,
      );
      if (runtime.sandbox) {
        console.log(
          "[@lacrew/orchestrator] SANDBOX: no chain. The org's rules are simulated in this process " +
            "and enforced by no contract; nothing here was or will be mined.",
        );
      }
    },
    { ...(host ? { host } : {}) },
  );
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
