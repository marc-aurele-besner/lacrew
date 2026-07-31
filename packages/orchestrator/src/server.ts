/**
 * Orchestrator bootstrap: Hono app (httpApp.ts) served over node:http so the
 * reusePort/shutdown helpers keep working.
 *
 * Requires a reachable chain — there is no mock fallback. When one cannot be
 * built the process still listens and serves `createUnavailableApp`, so callers
 * get a reason instead of a connection refused, and 503 instead of an empty org.
 * Queue: QueueProvider — pg-boss when DATABASE_URL set, else in-memory.
 */

import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { getRequestListener } from "@hono/node-server";
import { checkDbReady, getDatabaseUrl, runDbMigrations } from "@lacrew/db";
import { getOrchToken } from "./auth.js";
import { createRuntimeFromEnv } from "./runtime.js";
import { createRuntimeMcpBackend } from "./mcpBackend.js";
import { createFlowsSurface } from "./flows.js";
import { createHeartbeatSurface } from "./heartbeat.js";
import { createWebhookSurface, type WebhookJob } from "./webhooks.js";
import { createConnectorRegistry, loadConnectorsFromEnv } from "./connectors.js";
import { createConnectorModes } from "./connectorPolicy.js";
import { connectorAskTtlMs, createConnectorAsks } from "./connectorAsks.js";
import { scopeOfThread } from "./conversation.js";
import { createQueueFromEnv, type QueueProvider } from "./queue/index.js";
import { createModelProviderFromEnv, type ModelProvider } from "./model/index.js";
import { installShutdownHooks, listenHttp } from "./httpListen.js";
import { autoExecuteEnabled } from "./governanceSweep.js";
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
  // A bad connector config stops the boot rather than starting an orchestrator
  // whose crews silently cannot reach the world they were configured for.
  const connectorDefs = loadConnectorsFromEnv(process.env, (path) =>
    readFileSync(path, "utf8"),
  );
  // Write policy (F2.24) is built whether or not connectors are registered:
  // the rules outlive any one config, and an operator who narrows a route
  // before wiring the connector should not find the rule gone afterwards.
  const connectorModes = createConnectorModes({ store: runtime.store });
  const connectorAsks = createConnectorAsks({
    store: runtime.store,
    postQuestion: ({ threadId, author, body, options }) =>
      runtime.postMessage({
        scope: scopeOfThread(threadId) ?? { kind: "org" },
        author,
        authorKind: "agent",
        kind: "question",
        body,
        options,
      }),
    onEvent: (event) => runtime.recordAudit(event),
    ttlMs: connectorAskTtlMs(),
  });
  // The answer that releases a suspended write is an ordinary message; nothing
  // in the conversation knows that, and this is the only place it is read.
  runtime.onMessage((message) => connectorAsks.observe(message));

  const connectors =
    connectorDefs.length > 0
      ? createConnectorRegistry({
          connectors: connectorDefs,
          onEvent: (event) => runtime.recordAudit(event),
          // Write routes are admitted by the same policy stack that admits a
          // spend, asked as the crew worker.
          checkPolicy: async (target) =>
            (await runtime.checkPolicy({ agent: runtime.defaultAgent, target, value: 0n }))
              .verdict,
          resolveMode: (route, id, subject) => connectorModes.resolve(route, id, subject),
          asks: connectorAsks,
        })
      : undefined;
  if (connectorDefs.length > 0) {
    console.log(
      `[@lacrew/orchestrator] ${connectorDefs.length} connector(s): ${connectors!.toolNames().join(", ")}`,
    );
  }
  const flows = createFlowsSurface({
    runtime,
    model,
    mcpBackend,
    connectors,
    asks: connectorAsks,
  });
  // Webhook deliveries are accepted on the HTTP thread and run on a queue
  // worker, so the surface is handed the enqueue rather than the queue itself —
  // it has no business scheduling anything else.
  const webhooks = createWebhookSurface({
    runtime,
    flows,
    enqueue: async (job) => {
      await queue.enqueue("webhook", job as unknown as Record<string, unknown>);
    },
  });

  // Crew heartbeats (F2.21). Built after flows: a checklist names flow ids, and
  // validating one against a surface that has not hydrated yet would refuse
  // every item on a config that is perfectly good.
  const heartbeats = createHeartbeatSurface({ runtime, flows });

  const app = createOrchestratorApp({
    runtime,
    queue,
    model,
    flows,
    mcpBackend,
    connectors,
    connectorModes,
    connectorAsks,
    webhooks,
    heartbeats,
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

    // Restore pauses and directives before anything can act. Unlike the
    // session restore above, a failure here does cost correctness: every
    // paused agent comes back running and every agent loses its guidelines,
    // resources and skills — so it is logged loudly rather than in passing.
    // The conversation is restored before controls: an agent that boots and
    // reads its thread must find the answers it was already given, or it asks
    // the same question again and the humans stop reading.
    const talk = await runtime.hydrateConversation();
    if (talk.loaded > 0) {
      console.log(`[@lacrew/orchestrator] ${talk.loaded} message(s) restored`);
    }

    const controls = await runtime.hydrateAgentControls();
    if (controls.ok) {
      if (controls.loaded > 0) {
        console.log(
          `[@lacrew/orchestrator] standing controls restored for ${controls.loaded} agent(s)`,
        );
      }
    } else {
      console.error(
        "[@lacrew/orchestrator] agent controls could not be read: every agent is running " +
          "with no directive. Paused agents are NOT paused. Fix the store and restart.",
      );
    }

    // Connector write policy (F2.24). Loud on failure for the same reason as
    // controls: with no rules loaded every write is back on its declared
    // default, and with no asks loaded a confirmation someone already spent
    // looks like a question that was never asked.
    try {
      const modes = await connectorModes.hydrate();
      const asks = await connectorAsks.hydrate();
      if (modes > 0 || asks > 0) {
        console.log(
          `[@lacrew/orchestrator] connector write policy: ${modes} rule(s), ${asks} ask(s) restored`,
        );
      }
    } catch (err) {
      console.error(
        "[@lacrew/orchestrator] connector write policy could not be read: every write route is " +
          "running at its declared default and past confirmations are unknown. Fix the store and restart.",
        err,
      );
    }
  }
  const hydrated = await flows.hydrate();
  if (hydrated.flows > 0 || hydrated.runs > 0) {
    console.log(
      `[@lacrew/orchestrator] flows hydrated: ${hydrated.flows} definitions, ${hydrated.runs} runs (${flows.storeName})`,
    );
  }
  // After flows: a trigger points at a definition, and hydrating it first would
  // make every restored hook look like it names a flow that does not exist.
  try {
    const restored = await webhooks.hydrate();
    if (restored > 0) {
      console.log(
        `[@lacrew/orchestrator] ${restored} webhook trigger(s) restored (${webhooks.storeName})`,
      );
    }
  } catch (err) {
    console.error("[@lacrew/orchestrator] webhook trigger hydration failed:", err);
  }
  // After flows, for the reason webhooks are: a checklist points at definitions,
  // and hydrating it first would make every restored heartbeat look like it
  // names flows that do not exist.
  try {
    const beats = await heartbeats.hydrate();
    if (beats > 0) {
      const on = heartbeats.list().filter((h) => h.enabled).length;
      console.log(
        `[@lacrew/orchestrator] ${beats} crew heartbeat(s) restored, ${on} enabled (${heartbeats.storeName})`,
      );
    }
  } catch (err) {
    console.error("[@lacrew/orchestrator] crew heartbeat hydration failed:", err);
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
    onWebhook: async (data) => webhooks.deliver(data as unknown as WebhookJob),
    onFlowCron: async () => {
      const result = await flows.runCronDue();
      // Ask-mode writes that nobody answered (F2.24). Rides the same minute
      // sweep so exactly one replica expires each ask; the suspended run then
      // resumes into a step that refuses instead of calling.
      try {
        const expired = await connectorAsks.sweep();
        if (expired.length > 0) {
          console.log(`[@lacrew/orchestrator] ${expired.length} connector ask(s) timed out`);
        }
      } catch (err) {
        console.error("[@lacrew/orchestrator] connector ask sweep failed:", err);
      }
      // Crew heartbeats (F2.21) ride the same minute sweep, which is what makes
      // a tick exactly-once across replicas: the queue hands this job to one
      // worker, and the sweep claims each crew's window before doing any work.
      try {
        const ticks = await heartbeats.sweep();
        if (ticks.length > 0) {
          console.log(
            `[@lacrew/orchestrator] ${ticks.length} crew heartbeat tick(s): ` +
              ticks.map((t) => `${t.crewId}=${t.status}`).join(", "),
          );
        }
      } catch (err) {
        console.error("[@lacrew/orchestrator] crew heartbeat sweep failed:", err);
      }
      // The governance auto-executor (F0.6) rides the same minute sweep: the
      // queue already dispatches it to exactly one replica per tick. Opt-in —
      // executing governance without a human press is a policy decision.
      if (autoExecuteEnabled()) {
        try {
          await runtime.executeDueProposals();
        } catch (err) {
          console.error("[@lacrew/orchestrator] governance auto-execute sweep failed:", err);
        }
      }
      return result;
    },
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
        (autoExecuteEnabled() ? " gov-auto-execute=on" : "") +
        ` db=${dbReady ? "ready" : getDatabaseUrl() ? "unreachable" : "off"}` +
        ` migrations=${migrationsRan ? "ok" : "skipped"}`,
    );
  });
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
