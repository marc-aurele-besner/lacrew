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
import {
  createExternalMcpRegistry,
  externalMcpAuditArgKeys,
  externalMcpRefreshMinutes,
  loadExternalMcpServersFromEnv,
} from "./externalMcp.js";
import { loadMcpEgressPolicyFromEnv } from "./mcpEgress.js";
import { createMcpSecrets } from "./mcpSecrets.js";
import { createHumanGates, humanGateTtlMs } from "./humanGates.js";
import { createPlanRequirements, planRequiredFromEnv } from "./planRequired.js";
import { createCrewBindings } from "./crewBindings.js";
import { createDualControl, dualControlFromEnv } from "./dualControl.js";
import { createEvalRunner } from "./evalRunner.js";
import { scopeOfThread } from "./conversation.js";
import { createQueueFromEnv, type QueueProvider } from "./queue/index.js";
import {
  createModelProviderFromEnv,
  withInferenceBudget,
  type ModelProvider,
} from "./model/index.js";
import { createInferenceBudgets, crewIdForSeat } from "./inferenceBudgets.js";
import { connectorPricesFromEnv, createPnl } from "./pnl.js";
import { ancestorsOf } from "./flowScope.js";
import type { OrgNode } from "@lacrew/core";
import { installShutdownHooks, listenHttp } from "./httpListen.js";
import { autoExecuteEnabled } from "./governanceSweep.js";
import { createOrchestratorApp, createUnavailableApp } from "./httpApp.js";
import { createRootAuthSurface, readRootAuthConfig } from "./rootAuth.js";
import {
  createSafeApprovalSurface,
  safeApprovalRelayChains,
  safeApprovalRelayer,
} from "./safeApproval.js";

const port = Number(process.env.PORT ?? 8788);
const queue: QueueProvider = createQueueFromEnv();
/** The vendor client. Wrapped by the cost guard below before anything uses it. */
const rawModel: ModelProvider = createModelProviderFromEnv();
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
  const connectorDefs = loadConnectorsFromEnv(process.env, (path) => readFileSync(path, "utf8"));
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
  // Blocking human gates (F2.27). Built beside asks and for the same reason:
  // the questions outlive any one flow definition, and a gate whose record went
  // missing is a paused run nobody can release.
  const humanGates = createHumanGates({
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
    ttlMs: humanGateTtlMs(),
  });
  // Blueprint seat bindings (F2.25). Bookkeeping rather than a control: it
  // records which account each blueprint seat landed on, so `/org` can serve a
  // role id the chain has no room for and a renamed seat still resolves.
  const crewBindings = createCrewBindings({
    store: runtime.store,
    onEvent: (event) => runtime.recordAudit(event),
  });
  // Plan-required mode (F2.31). Built before the surfaces it guards, and from
  // the environment as well as the store: a self-host operator sets
  // LACREW_PLAN_REQUIRED once, and a bad value stops the boot rather than
  // starting an orchestrator whose crews are unsupervised in a way its config
  // says they are not.
  const planRequired = createPlanRequirements({
    store: runtime.store,
    // Read live from the conversation: a plan posted a second ago by the run
    // being checked has to count.
    messagesIn: (threadId) => runtime.thread(scopeOfThread(threadId) ?? { kind: "org" }, 200),
    seed: [planRequiredFromEnv() ?? []].flat(),
    onEvent: (event) => runtime.recordAudit(event),
  });
  // Dual control (F2.32). Built beside plan-required and from the environment
  // too, and a bad value stops the boot for the stronger reason: an
  // orchestrator whose reviewer setting is unreadable would run a crew with
  // nobody checking its merges while its config says somebody is.
  const dualControl = createDualControl({
    store: runtime.store,
    postQuestion: ({ threadId, author, body, options, to }) =>
      runtime.postMessage({
        scope: scopeOfThread(threadId) ?? { kind: "org" },
        author,
        authorKind: "agent",
        kind: "question",
        body,
        options,
        ...(to ? { to } : {}),
      }),
    // Read per call, not cached: a reparent has to move a seat's reviewer with
    // it, and a fired or paused reviewer has to stop being asked. A chart this
    // process cannot reach yields nothing, which resolves to "ask a person" —
    // the safe direction for a control that exists to add a reviewer.
    orgSeats: async () => {
      try {
        const nodes = (await runtime.getClient().getOrgTree()) as OrgNode[];
        return nodes.map((node) => ({
          account: node.account,
          kind: node.kind,
          parent: node.parent,
          active: node.active,
          paused: runtime.isAgentPaused(node.account),
        }));
      } catch {
        return [];
      }
    },
    seed: [dualControlFromEnv() ?? []].flat(),
    onEvent: (event) => runtime.recordAudit(event),
  });
  // The answer that releases a suspended write — or a paused pipeline, or an
  // effect awaiting a second pair of eyes — is an ordinary message; nothing in
  // the conversation knows that, and this is the only place it is read.
  runtime.onMessage((message) => {
    connectorAsks.observe(message);
    humanGates.observe(message);
    dualControl.observe(message);
  });

  const connectors =
    connectorDefs.length > 0
      ? createConnectorRegistry({
          connectors: connectorDefs,
          onEvent: (event) => runtime.recordAudit(event),
          // Write routes are admitted by the same policy stack that admits a
          // spend, asked as the crew worker.
          checkPolicy: async (target) =>
            (await runtime.checkPolicy({ agent: runtime.defaultAgent, target, value: 0n })).verdict,
          resolveMode: (route, id, subject) => connectorModes.resolve(route, id, subject),
          asks: connectorAsks,
        })
      : undefined;
  if (connectorDefs.length > 0) {
    console.log(
      `[@lacrew/orchestrator] ${connectorDefs.length} connector(s): ${connectors!.toolNames().join(", ")}`,
    );
  }
  // Attached third-party MCP servers (F2.30). A bad config stops the boot for
  // the same reason a bad connector does: an orchestrator whose crews silently
  // cannot reach an attached server is worse than one that says why.
  const mcpServerDefs = loadExternalMcpServersFromEnv(process.env, (path) =>
    readFileSync(path, "utf8"),
  );
  const mcpEgress = loadMcpEgressPolicyFromEnv();
  // Sealed credentials for attached servers (F2.30). Built before the registry
  // because a `secret` auth resolves through it at call time.
  const mcpSecrets = createMcpSecrets({
    store: runtime.store,
    onEvent: (event) => runtime.recordAudit(event),
  });
  // Built even with no server in the env: servers attach at runtime, and a
  // registry that only existed when one was configured at boot would make
  // "attach without a restart" answer 503 on the deployments that need it most.
  const externalMcp = createExternalMcpRegistry({
    servers: mcpServerDefs,
    store: runtime.store,
    onEvent: (event) => runtime.recordAudit(event),
    // Ask-mode writes ride the same confirmation path connectors use, so
    // an operator answers one kind of question in one place.
    asks: connectorAsks,
    auditArgKeys: externalMcpAuditArgKeys(),
    egress: mcpEgress,
    secrets: mcpSecrets,
    lookup: async (host) => {
      const { lookup } = await import("node:dns/promises");
      const found = await lookup(host, { all: true });
      return found.map((entry) => entry.address);
    },
  });
  if (mcpServerDefs.length > 0) {
    console.log(
      `[@lacrew/orchestrator] ${mcpServerDefs.length} external MCP server(s): ` +
        mcpServerDefs.map((s) => `${s.id} (${s.transport})`).join(", "),
    );
  }
  if (mcpEgress.hosted) {
    // Said at boot because it is the difference between "attaching a server
    // works" and "attaching a server is refused", and an operator debugging the
    // second should not have to read the source to find out which.
    console.log(
      "[@lacrew/orchestrator] external MCP egress: hosted — " +
        `stdio ${mcpEgress.allowStdio ? "allowed" : "refused"}, hosts ` +
        (mcpEgress.allowHosts.length > 0
          ? mcpEgress.allowHosts.join(", ")
          : "none (set LACREW_MCP_ALLOW_HOSTS)"),
    );
  }
  // Inference cost budgets (F2.28). Built before the flows surface, because
  // every model call this process makes goes through the guard below — a flows
  // surface holding the unguarded client would be an unmetered path to the
  // provider, and the whole point is that there is exactly one.
  const budgets = createInferenceBudgets({
    postNote: ({ crewId, body }) =>
      void runtime.postMessage({
        scope: { kind: "crew", id: crewId },
        author: runtime.defaultAgent,
        authorKind: "agent",
        kind: "note",
        body,
      }),
    onEvent: (event) => runtime.recordAudit(event),
  });
  const model = withInferenceBudget(rawModel, budgets);

  /**
   * Crew / seat P&L (F2.33) — a read over the trail, the meter and the two
   * ceilings. Wired after the budgets surface because the inference lines are
   * that surface's counters; with no connector price table configured, connector
   * usage reports in calls and says the price is unknown.
   */
  const pnl = createPnl({
    runtime,
    budgets,
    connectorPrices: connectorPricesFromEnv(),
  });

  /**
   * The crew a seat belongs to, for budget attribution: its nearest manager in
   * the org tree, or itself when it has none. Read per call rather than cached,
   * on the same reasoning the flows surface reads it per run — a reparent that
   * moved a seat to another desk has to move its bill with it.
   */
  const budgetSubjectFor = async (principal: string): Promise<string> => {
    let nodes: OrgNode[] = [];
    try {
      nodes = (await runtime.getClient().getOrgTree()) as OrgNode[];
    } catch {
      // No reachable registry: the seat is its own crew, which is what an
      // unresolvable tree already means everywhere else in this process.
    }
    return crewIdForSeat(principal, [...ancestorsOf(nodes, principal)]);
  };

  const flows = createFlowsSurface({
    runtime,
    model,
    mcpBackend,
    connectors,
    ...(externalMcp ? { externalMcp, mcpSecrets } : {}),
    asks: connectorAsks,
    gates: humanGates,
    planRequired,
    dualControl,
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
  const heartbeats = createHeartbeatSurface({
    runtime,
    flows,
    budgetBlock: async (principal) => budgets.heartbeatBlock(await budgetSubjectFor(principal)),
    // What the tick cost, from the same counters the guard above reads. The
    // figure a thread reports and the figure a budget enforces are one number,
    // which is the only version of it worth showing an operator.
    usageForRuns: (runIds) => budgets.usageForRuns(runIds),
  });

  // Root authorization for revoke/rotate (F0.7) and root-depth approvals
  // (F2.6). A bad LACREW_ROOT_AUTH value stops boot: starting anyway would
  // leave those routes ungated on a deployment whose operator plainly meant to
  // gate them.
  const rootChallengeTtl = Number(process.env.LACREW_ROOT_CHALLENGE_TTL_SEC ?? "");
  const rootAuth = createRootAuthSurface({
    config: readRootAuthConfig(),
    humanRoot: () => runtime.humanRootAddress(),
    chainId: () => runtime.chainId,
    ...(Number.isFinite(rootChallengeTtl) && rootChallengeTtl > 0
      ? { challengeTtlSec: rootChallengeTtl }
      : {}),
  });
  if (rootAuth.required) {
    const status = rootAuth.status();
    console.log(
      status.configError
        ? `[@lacrew/orchestrator] root auth (${status.kind}) CANNOT verify: ${status.configError} — revoke/rotate and root-depth approvals will refuse`
        : `[@lacrew/orchestrator] root auth: ${status.kind} — session revoke/rotate and root-depth approvals require a root proof`,
    );
  }

  // A Safe root has to *send* `resolve`, not merely sign for it (F2.6 / F1.3).
  // Built only where every piece is present: an incomplete config leaves the
  // path absent, and the routes refuse by name rather than quietly settling
  // root-depth intents with a key this process happens to hold.
  const rootSafeAddress = rootAuth.safeAddress;
  const escalationRouter = runtime.escalationRouterAddress();
  const rootRpc = process.env.ANVIL_RPC ?? process.env.RPC_URL;
  const safeApproval =
    rootSafeAddress && escalationRouter && rootRpc && process.env.LACREW_ROOT_PASSKEY_PUBKEY
      ? createSafeApprovalSurface({
          provider: rootRpc,
          safeAddress: rootSafeAddress,
          escalationRouter,
          publicKey: process.env.LACREW_ROOT_PASSKEY_PUBKEY.trim(),
          ...(safeApprovalRelayer() ? { relayerKey: safeApprovalRelayer()! } : {}),
          allowChainIds: safeApprovalRelayChains(),
        })
      : undefined;
  if (rootAuth.kind === "safe-passkey") {
    console.log(
      safeApproval
        ? `[@lacrew/orchestrator] root Safe ${rootSafeAddress} settles root-depth intents through execTransaction${
            safeApprovalRelayChains().length
              ? ` (relaying on chain ${safeApprovalRelayChains().join(", ")})`
              : " (unrelayed — the transaction is returned for your own wallet to send)"
          }`
        : "[@lacrew/orchestrator] root auth is safe-passkey but the Safe approval path is incomplete — root-depth approvals will refuse",
    );
  }

  const app = createOrchestratorApp({
    runtime,
    queue,
    model,
    flows,
    mcpBackend,
    connectors,
    connectorModes,
    crewBindings,
    planRequired,
    dualControl,
    ...(externalMcp ? { externalMcp, mcpSecrets } : {}),
    // The suite ships with @lacrew/flows, so it is always available; the
    // runner spawns a child per run rather than holding anything open.
    evals: createEvalRunner(),
    connectorAsks,
    humanGates,
    webhooks,
    heartbeats,
    budgets,
    pnl,
    rootAuth,
    ...(safeApproval ? { safeApproval } : {}),
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
      // Loud on failure for the same reason: a gate this process cannot see is
      // a decision somebody already made that the parked run will ask for again.
      const gates = await humanGates.hydrate();
      if (gates > 0) {
        console.log(`[@lacrew/orchestrator] ${gates} human gate(s) restored`);
      }
    } catch (err) {
      console.error(
        "[@lacrew/orchestrator] connector write policy could not be read: every write route is " +
          "running at its declared default and past confirmations are unknown. Fix the store and restart.",
        err,
      );
    }

    // Plan-required rules (F2.31). Loud but not fatal: unlike the controls
    // above, this one fails *open* by design — a crew whose requirement could
    // not be read keeps working, bounded by every onchain and connector control
    // as before, and the line is here so nobody reads a quiet trail as a crew
    // that has been planning all along.
    try {
      const requirements = await planRequired.hydrate();
      if (requirements > 0) {
        console.log(`[@lacrew/orchestrator] plan-required: ${requirements} rule(s) restored`);
      }
    } catch (err) {
      console.error(
        "[@lacrew/orchestrator] plan-required rules could not be read: every crew is acting " +
          "without having to plan first. Onchain and connector controls are unaffected. " +
          "Fix the store and restart.",
        err,
      );
    }

    // Blueprint seat bindings (F2.25). Fails open like plan-required, for a
    // milder reason: these rows *find* seats and bound nothing, so a process
    // that cannot read them resolves seats by label with the misses named — the
    // behaviour every self-host had before the map existed. The line is here
    // because a silent zero reads as "nobody ever bound a seat", which would
    // send an operator to bind seats that are already bound.
    try {
      const seats = await crewBindings.hydrate();
      if (seats > 0) {
        console.log(`[@lacrew/orchestrator] crew bindings: ${seats} seat(s) restored`);
      }
    } catch (err) {
      console.error(
        "[@lacrew/orchestrator] crew seat bindings could not be read: a seat renamed since it " +
          "was hired will be reported missing rather than bound. Nothing is unbounded by this. " +
          "Fix the store and restart.",
        err,
      );
    }

    // Dual control (F2.32). Fatal-adjacent, unlike plan-required above: this
    // control fails closed, so a process that cannot read its rules refuses the
    // effects they cover rather than running crews as if nobody had asked for a
    // second pair of eyes. The line says so plainly, because the operator's
    // next question is why merges stopped.
    try {
      const loaded = await dualControl.hydrate();
      if (loaded.rules > 0 || loaded.reviews > 0) {
        console.log(
          `[@lacrew/orchestrator] dual control: ${loaded.rules} rule(s), ${loaded.reviews} review(s) restored`,
        );
      }
    } catch (err) {
      console.error(
        "[@lacrew/orchestrator] dual-control rules could not be read: every effect they cover " +
          "will be refused on this replica until the store is readable. Fix the store and restart.",
        err,
      );
    }

    // External MCP allowlist (F2.30). The rows *are* the allowlist, so an
    // unreadable store fails closed — every external tool refuses — which is
    // safe for calls and confusing for an operator whose tools page shows
    // nothing they enabled. Hence the loud line rather than a silent zero.
    if (externalMcp) {
      try {
        // Credentials first: a server restored before its token would fail its
        // boot refresh with `mcp_missing_credential` and read as unreachable.
        const secrets = await mcpSecrets.hydrate();
        if (secrets > 0) {
          console.log(
            `[@lacrew/orchestrator] external MCP: ${secrets} sealed credential(s) restored`,
          );
        }
      } catch (err) {
        console.error(
          "[@lacrew/orchestrator] external MCP credentials could not be read: any server that " +
            "reads one will fail its calls until the store is fixed.",
          err,
        );
      }
      try {
        const allowed = await externalMcp.hydrate();
        if (allowed > 0) {
          console.log(
            `[@lacrew/orchestrator] external MCP allowlist: ${allowed} tool record(s) restored`,
          );
        }
      } catch (err) {
        console.error(
          "[@lacrew/orchestrator] external MCP allowlist could not be read: every external tool " +
            "is refused on this replica. Fix the store and restart.",
          err,
        );
      }
    }
  }

  // Discovery at boot, after hydration so a known tool is not re-recorded as
  // new. Best effort: an unreachable server must not stop an orchestrator whose
  // crews have plenty of other work, and nothing it would have returned could
  // widen the allowlist anyway.
  if (externalMcp) {
    try {
      const results = await externalMcp.refresh();
      for (const result of results) {
        if (!result.ok) {
          console.error(
            `[@lacrew/orchestrator] external MCP ${result.server} unreachable: ${result.error}`,
          );
          continue;
        }
        console.log(
          `[@lacrew/orchestrator] external MCP ${result.server}: ` +
            `${result.unchanged.length + result.added.length} tool(s)` +
            (result.added.length > 0 ? `, ${result.added.length} new and blocked` : "") +
            (result.removed.length > 0 ? `, ${result.removed.length} gone` : ""),
        );
      }
    } catch (err) {
      console.error("[@lacrew/orchestrator] external MCP discovery failed:", err);
    }
  }
  const hydrated = await flows.hydrate();
  if (hydrated.flows > 0 || hydrated.runs > 0) {
    console.log(
      `[@lacrew/orchestrator] flows hydrated: ${hydrated.flows} definitions, ${hydrated.runs} runs (${flows.storeName})`,
    );
  }
  // Runs in flight when this process (or the one before it) stopped: resumed
  // from their last checkpoint, or failed closed if they were mid-write (F2.26).
  // After definitions, because a resume runs against the flow it started under.
  try {
    const recovered = await flows.hydrateRuns();
    if (recovered.resumed + recovered.failed + recovered.paused > 0) {
      console.log(
        `[@lacrew/orchestrator] flow runs recovered: ${recovered.resumed} resumed, ` +
          `${recovered.failed} failed closed, ${recovered.paused} still paused`,
      );
    }
  } catch (err) {
    console.error("[@lacrew/orchestrator] flow run recovery failed:", err);
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
  // Cost budgets (F2.28). Loud on failure: with none loaded, every crew's model
  // spend is unbounded on this replica while an operator's settings page still
  // shows the limits they set — the one failure mode this feature exists to
  // prevent. Budgets are read through on every call, so this is a boot log and
  // a prune, not the thing enforcement depends on.
  try {
    const configured = await budgets.hydrate();
    await budgets.prune();
    if (configured > 0) {
      console.log(
        `[@lacrew/orchestrator] ${configured} inference budget(s) configured (${budgets.storeName})`,
      );
    }
  } catch (err) {
    console.error("[@lacrew/orchestrator] inference budgets could not be read:", err);
  }

  const mcpRefreshMs = externalMcpRefreshMinutes() * 60_000;
  /** Boot discovery counts as the first pass, so the sweep waits a full cadence. */
  let lastMcpRefresh = Date.now();

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
      // Blocking human gates nobody answered (F2.27). Same minute sweep, so
      // exactly one replica times each gate out; the parked run then resumes
      // into a step that takes the timeout port, or stops.
      try {
        const timedOut = await humanGates.sweep();
        if (timedOut.length > 0) {
          console.log(`[@lacrew/orchestrator] ${timedOut.length} human gate(s) timed out`);
        }
      } catch (err) {
        console.error("[@lacrew/orchestrator] human gate sweep failed:", err);
      }
      // Reviews nobody concurred with (F2.32). Same minute sweep; the parked
      // run then resumes into a step that fails closed, which is the direction
      // a second pair of eyes has to fail in.
      try {
        const expiredReviews = await dualControl.sweep();
        if (expiredReviews.length > 0) {
          console.log(
            `[@lacrew/orchestrator] ${expiredReviews.length} dual-control review(s) timed out`,
          );
        }
      } catch (err) {
        console.error("[@lacrew/orchestrator] dual-control sweep failed:", err);
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
      // External MCP discovery (F2.30) rides the same minute sweep, at its own
      // cadence. It admits nothing — a tool that appeared since the last pass is
      // recorded blocked — so this is about how quickly an operator learns a
      // server grew a tool, not about what a crew may call.
      if (externalMcp && mcpRefreshMs > 0 && Date.now() - lastMcpRefresh >= mcpRefreshMs) {
        lastMcpRefresh = Date.now();
        try {
          const swept = await externalMcp.refresh();
          const blocked = swept.flatMap((r) => r.added);
          if (blocked.length > 0) {
            console.log(
              `[@lacrew/orchestrator] external MCP: ${blocked.length} new tool(s) blocked until allowed: ${blocked.join(", ")}`,
            );
          }
        } catch (err) {
          console.error("[@lacrew/orchestrator] external MCP refresh sweep failed:", err);
        }
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
    // Stdio servers are child processes this orchestrator started; leaving them
    // running after a redeploy is a slow leak of third-party binaries.
    await externalMcp?.close();
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
