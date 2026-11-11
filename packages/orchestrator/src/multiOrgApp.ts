/**
 * Multi-org mode: one orchestrator process serving many orgs, each on its own.
 *
 * Every org is addressed under `/o/<orgId>/...` and served by a world of its
 * own (`orgWorld.ts`): its own runtime, its own stores, its own surfaces. An
 * org exists because it was registered (`PUT /orgs/<orgId>`), never because it
 * was addressed. Worlds are built on first use and let go when idle; nothing
 * is lost by that, because everything a world holds is read back from the
 * store when it is next built.
 *
 * What a single-org orchestrator reads from its environment for its one org
 * is not handed to any org here: `multiOrgSettings` lists each such setting
 * and what happens to it, and every org's `/health` carries the list.
 */

import { Hono, type Context } from "hono";
import type { AuditStore } from "./auditStore.js";
import { createAuditStoreFromEnv } from "./auditStore.js";
import { isAuthorized } from "./auth.js";
import {
  corsHeadersFor,
  CORS_PREFLIGHT_HEADERS,
  parseCorsOrigins,
  rejectsNonJsonBody,
} from "./httpGuards.js";
import type { ModelProvider } from "./model/index.js";
import { DEFAULT_EPOCH_CRON, type EpochScheduleStore } from "./epochCadence.js";
import {
  isOrgId,
  isOrgMode,
  isProvisioned,
  ORG_MODES,
  sandboxRootOf,
  type OrgDirectory,
  type OrgMode,
  type OrgRecord,
} from "./orgDirectory.js";
import {
  createOrgWorld,
  createUnavailableOrgWorld,
  type OrgWorld,
  type OrgWorldShared,
} from "./orgWorld.js";
import type { QueueProvider } from "./queue/index.js";
import { createSandboxRuntime } from "./runtime.js";
import { createRuntimeStoreFromEnv, type RuntimeStore } from "./runtimeStore.js";
import { createSandboxStateStoreFromEnv, type SandboxStateStore } from "./sandboxLedger.js";

/** The modes this build can run an org in. A chain org is registered but not served yet. */
export const SERVED_ORG_MODES: readonly OrgMode[] = ["sandbox"];

/** How long an org's world is kept after its last request, by default. */
export const DEFAULT_ORG_IDLE_MS = 15 * 60_000;

/** One process-wide setting, and what multi-org mode does with it. */
export interface MultiOrgSetting {
  /** The surface the setting belongs to. */
  surface: string;
  /** The environment variables that carry it. */
  env: string[];
  /** Whether this process has any of them set. */
  configured: boolean;
  /**
   * `disabled`: no org is given it. `shared`: one value serves every org, and
   * it is neither a credential of one org nor a setting one org chose.
   */
  handling: "disabled" | "shared";
  /** Why, in a sentence an operator can act on. */
  reason: string;
}

const SETTINGS: Array<Omit<MultiOrgSetting, "configured">> = [
  {
    surface: "connectors",
    env: ["LACREW_CONNECTORS"],
    handling: "disabled",
    reason:
      "Connectors set in the environment carry one deployment's credentials, so no org is given them. An org has no connectors on this orchestrator.",
  },
  {
    surface: "externalMcp.servers",
    env: ["LACREW_MCP_SERVERS"],
    handling: "disabled",
    reason:
      "MCP servers set in the environment belong to one deployment. Each org attaches its own through the API, stored under that org.",
  },
  {
    surface: "externalMcp.environmentCredentials",
    env: ["LACREW_MCP_ALLOW_ENV"],
    handling: "disabled",
    reason:
      "An attached server may not read this process's environment. An org's credentials are its own sealed secrets.",
  },
  {
    surface: "externalMcp.stdio",
    env: ["LACREW_MCP_ALLOW_STDIO"],
    handling: "disabled",
    reason: "No org may start a subprocess on a host it shares with other orgs.",
  },
  {
    surface: "externalMcp.loopback",
    env: ["LACREW_MCP_ALLOW_LOOPBACK"],
    handling: "disabled",
    reason: "No org may reach this host's loopback or private network.",
  },
  {
    surface: "externalMcp.egress",
    env: ["LACREW_MCP_HOSTED", "LACREW_MCP_ALLOW_HOSTS"],
    handling: "shared",
    reason:
      "Every org is held to the hosted egress policy, whatever LACREW_MCP_HOSTED says: only the hosts the operator allows are reachable.",
  },
  {
    surface: "rootAuth",
    env: [
      "LACREW_ROOT_AUTH",
      "LACREW_ROOT_ADDRESS",
      "LACREW_ROOT_SAFE_ADDRESS",
      "LACREW_ROOT_PASSKEY_ID",
      "LACREW_ROOT_PASSKEY_PUBKEY",
      "LACREW_ROOT_PASSKEY_ORIGIN",
      "LACREW_ROOT_PASSKEY_RPID",
      "LACREW_ROOT_APPROVAL_RELAYER",
      "LACREW_ROOT_APPROVAL_RELAY_CHAINS",
    ],
    handling: "disabled",
    reason:
      "A root proof configured in the environment names one org's root. A sandbox org verifies no signature: whoever holds the orchestrator token stands in for its root.",
  },
  {
    surface: "planRequired.seed",
    env: [
      "LACREW_PLAN_REQUIRED",
      "LACREW_PLAN_REQUIRED_WINDOW_MIN",
      "LACREW_PLAN_REQUIRED_UPSTREAM",
    ],
    handling: "disabled",
    reason:
      "A rule seeded from the environment would apply to every org. Each org sets its own through the API.",
  },
  {
    surface: "dualControl.seed",
    env: [
      "LACREW_DUAL_CONTROL",
      "LACREW_DUAL_CONTROL_REVIEWER",
      "LACREW_DUAL_CONTROL_MIN_SPEND",
      "LACREW_DUAL_CONTROL_TIMEOUT_MIN",
      "LACREW_DUAL_CONTROL_REVIEW_SCOPE",
    ],
    handling: "disabled",
    reason:
      "A rule seeded from the environment would apply to every org. Each org sets its own through the API.",
  },
  {
    surface: "walletWatchlist",
    env: ["WALLET_WATCHLIST"],
    handling: "disabled",
    reason: "A watchlist set in the environment is one org's list of chains and tokens.",
  },
  {
    surface: "governance.autoExecute",
    env: ["LACREW_AUTO_EXECUTE"],
    handling: "disabled",
    reason:
      "Executing proposals without a call is each org's decision, and there is no per-org setting for it yet. Proposals are executed by POST /governance/execute.",
  },
  {
    surface: "epoch.schedule",
    env: ["EPOCH_CRON", "EPOCH_INTERVAL_MS"],
    handling: "shared",
    reason:
      "EPOCH_CRON is the cadence of an org that has set none. Each org sets its own with POST /epoch/schedule, kept with the org and read on the org's own clock; the shared minute sweep only checks which orgs are due. EPOCH_INTERVAL_MS is not used.",
  },
  {
    surface: "queue.tick",
    env: [],
    handling: "disabled",
    reason: "A queued tick names no org and is dropped. POST /tick on an org runs that org's tick.",
  },
  {
    surface: "chain",
    env: [
      "RPC_URL",
      "ANVIL_RPC",
      "CHAIN_ID",
      "PRIVATE_KEY",
      "MANAGER_PRIVATE_KEY",
      "LACREW_ISSUER_PRIVATE_KEY",
      "LACREW_DELEGATIONS",
      "LACREW_WALLET_ADAPTER",
    ],
    handling: "disabled",
    reason:
      "This process's RPC endpoint and keys serve no org. A testnet or mainnet org is registered but not provisioned by this version, and answers 503 org_not_provisioned.",
  },
  {
    surface: "sandbox",
    env: ["LACREW_MODE", "LACREW_SANDBOX_ROOT"],
    handling: "disabled",
    reason:
      "An org's mode comes from the directory, and a sandbox org's root is derived from its id unless the directory names one.",
  },
  {
    surface: "model",
    env: [
      "LACREW_MODEL_PROVIDER",
      "ANTHROPIC_API_KEY",
      "OPENAI_API_KEY",
      "OPENROUTER_API_KEY",
      "LACREW_MODEL_PRICES",
      "LACREW_CONNECTOR_PRICES",
    ],
    handling: "shared",
    reason:
      "Every org's model calls go through the operator's provider key. Each org's usage is metered and budgeted under that org alone.",
  },
  {
    surface: "auth",
    env: ["LACREW_ORCH_TOKEN", "LACREW_ORCH_CORS_ORIGINS"],
    handling: "shared",
    reason:
      "One bearer token opens every org. It belongs to the control plane in front of this orchestrator, which decides which org a caller may address.",
  },
  {
    surface: "sealing",
    env: ["LACREW_SESSION_KEY", "LACREW_SESSION_KEY_PREVIOUS"],
    handling: "shared",
    reason:
      "One key seals every org's stored secrets. Each sealed value is stored under its org and is never served.",
  },
  {
    surface: "limits",
    env: [
      "LACREW_CONNECTOR_ASK_TTL_MS",
      "LACREW_HUMAN_GATE_TTL_MS",
      "LACREW_MCP_REFRESH_MINUTES",
      "LACREW_MCP_AUDIT_ARGS",
      "LACREW_WEBHOOK_MAX_BYTES",
      "LACREW_WEBHOOK_TOLERANCE_SEC",
      "LACREW_EVAL_TIMEOUT_MS",
      "LACREW_MODEL_TIMEOUT_MS",
      "SESSION_MAX_VALUE",
      "SESSION_ALLOWED_TARGET",
    ],
    handling: "shared",
    reason:
      "Timeouts, size limits and session defaults are the operator's, and the same for every org.",
  },
];

/** Every process-wide setting and what multi-org mode does with it, for this environment. */
export function multiOrgSettings(env: NodeJS.ProcessEnv = process.env): MultiOrgSetting[] {
  return SETTINGS.map((setting) => ({
    ...setting,
    configured: setting.env.some((name) => Boolean(env[name]?.trim())),
  }));
}

/** Operator settings an org inherits as they are: none is a credential or one org's choice. */
const INHERITED_ENV = [
  "LACREW_CONNECTOR_ASK_TTL_MS",
  "LACREW_HUMAN_GATE_TTL_MS",
  "LACREW_MCP_ALLOW_HOSTS",
  "LACREW_MCP_AUDIT_ARGS",
  "LACREW_MCP_REFRESH_MINUTES",
  "LACREW_CONNECTOR_PRICES",
];

/**
 * The environment an org's own settings are read from in multi-org mode.
 *
 * Built from a short list rather than by removing names from the process
 * environment: a variable nobody thought about is one no org sees. The hosted
 * egress policy is forced on, with nothing that widens it.
 */
export function orgEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const name of INHERITED_ENV) {
    if (env[name] !== undefined) out[name] = env[name];
  }
  out.LACREW_MCP_HOSTED = "1";
  return out;
}

/** The stores one sandbox org's runtime writes through. */
export interface OrgStores {
  sandboxState: SandboxStateStore;
  audit: AuditStore;
  runtime: RuntimeStore;
}

export interface OrgWorldContext {
  queue: QueueProvider;
  model: ModelProvider;
  authToken: string;
  mcpUseMock: boolean;
  isDbReady: () => boolean;
  isDbConfigured: () => boolean;
  /** The process environment operator settings are read from. */
  env: NodeJS.ProcessEnv;
  /** Where one org's state is kept. Defaults to Postgres when DATABASE_URL is set, else memory. */
  stores?: (orgId: string) => OrgStores;
  /**
   * Where one org's epoch cadence is kept. Absent, a world is built with no
   * cadence of its own and its scheduled epoch never runs unprompted.
   */
  epoch?: (orgId: string) => EpochScheduleStore;
}

/** The cadence of an org that has set none: the operator's `EPOCH_CRON`, else hourly. */
export function defaultEpochCron(env: NodeJS.ProcessEnv = process.env): string {
  return env.EPOCH_CRON?.trim() || DEFAULT_EPOCH_CRON;
}

/** What an org's `/health` adds in multi-org mode. */
function orgHealth(org: OrgRecord, env: NodeJS.ProcessEnv): () => Record<string, unknown> {
  const settings = multiOrgSettings(env);
  return () => ({
    org: { id: org.orgId, mode: org.mode, provisioned: isProvisioned(org) },
    multiOrg: {
      // What this org is not given, and what it shares with every other org.
      disabled: settings.filter((s) => s.handling === "disabled"),
      shared: settings.filter((s) => s.handling === "shared"),
    },
  });
}

/**
 * A queue as one org sees it: what it enqueues carries its id, so the worker
 * that picks the job up knows whose it is. The queue's own schedules are the
 * process's and not an org's to change: an org's epoch cadence is kept with
 * the org, not in the queue.
 */
function orgQueue(queue: QueueProvider, orgId: string): QueueProvider {
  return {
    name: queue.name,
    start: () => Promise.reject(new Error("queue_is_shared")),
    stop: () => Promise.reject(new Error("queue_is_shared")),
    enqueue: (name, data) => queue.enqueue(name, { ...data, orgId }),
    scheduleEpoch: () => Promise.reject(new Error("epoch_schedule_shared")),
    getScheduledEpochCron: () => queue.getScheduledEpochCron(),
    scheduleFlowCron: () => Promise.reject(new Error("queue_is_shared")),
    status: () => queue.status(),
  };
}

/**
 * Build the world of one registered org.
 *
 * A sandbox org gets the simulator: its own state, its own clock, its own
 * trail, and no chain. A chain org this process cannot run gets a world that
 * says so on every route.
 */
export async function buildOrgWorld(org: OrgRecord, context: OrgWorldContext): Promise<OrgWorld> {
  const health = orgHealth(org, context.env);
  const shared: OrgWorldShared = {
    queue: orgQueue(context.queue, org.orgId),
    model: context.model,
    authToken: context.authToken,
    mcpUseMock: context.mcpUseMock,
    isDbReady: context.isDbReady,
    isDbConfigured: context.isDbConfigured,
  };
  if (org.mode !== "sandbox") {
    return createUnavailableOrgWorld(
      org.orgId,
      {
        reason: "org_not_provisioned",
        detail:
          `Org "${org.orgId}" is registered as ${org.mode}. This orchestrator runs sandbox orgs only: ` +
          "it holds no contracts or keys for a chain org, so nothing is served for this one.",
        health: () => ({ ledger: null, chainId: org.chainId, ...health() }),
      },
      shared,
    );
  }
  const stores = context.stores?.(org.orgId) ?? {
    sandboxState: createSandboxStateStoreFromEnv(org.orgId),
    audit: createAuditStoreFromEnv(org.orgId, undefined, "sandbox"),
    runtime: createRuntimeStoreFromEnv(org.orgId),
  };
  const runtime = createSandboxRuntime({
    orgId: org.orgId,
    root: sandboxRootOf(org),
    store: stores.sandboxState,
    auditStore: stores.audit,
    runtimeStore: stores.runtime,
  });
  const epoch = context.epoch
    ? { store: context.epoch(org.orgId), defaultCron: defaultEpochCron(context.env) }
    : undefined;
  return createOrgWorld(
    org.orgId,
    { runtime, env: orgEnvironment(context.env), health, ...(epoch ? { epoch } : {}) },
    shared,
  );
}

export interface MultiOrgOptions {
  directory: OrgDirectory;
  /** Required. Multi-org mode has no open routes but the process's own `/health`. */
  authToken: string;
  queue: QueueProvider;
  model: ModelProvider;
  mcpUseMock: boolean;
  isDbReady: () => boolean;
  isDbConfigured: () => boolean;
  /** The process environment operator settings are read from. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  corsOrigins?: ReadonlySet<string>;
  /**
   * How long a world is kept after its org was last addressed. 0 never lets
   * one go, which is the only safe setting without a database: a world's state
   * would go with it.
   */
  idleMs?: number;
  /** How long a directory answer is reused before it is read again. */
  directoryTtlMs?: number;
  /**
   * How long the minute sweep skips an org it let go with nothing scheduled.
   * Another replica may have scheduled something for it since, and this is how
   * long that can go unnoticed here.
   */
  dormantRecheckMs?: number;
  now?: () => number;
  stores?: (orgId: string) => OrgStores;
  /** Build one org's world. Defaults to `buildOrgWorld`. */
  buildWorld?: (org: OrgRecord, context: OrgWorldContext) => Promise<OrgWorld>;
}

export interface MultiOrgHost {
  readonly app: Hono;
  /**
   * The shared tick: run the scheduled epoch of each org whose own cadence
   * says it is due. Returns how many orgs were looked at closely.
   */
  onEpoch(): Promise<unknown>;
  /** A queued tick names no org; it is dropped. */
  onTick(): Promise<unknown>;
  /** The minute sweep: due epochs first, then every org that has something scheduled. */
  onFlowCron(): Promise<unknown>;
  /** One accepted webhook delivery, for the org its job names. */
  onWebhook(data: Record<string, unknown>): Promise<unknown>;
  /** Let go of every world idle past `idleMs` with nothing scheduled. Returns the orgs let go. */
  evictIdle(): Promise<string[]>;
  /** The orgs whose world is built right now. */
  loaded(): string[];
  close(): Promise<void>;
}

interface Entry {
  /** What the world was built from; a directory row that no longer matches rebuilds it. */
  key: string;
  world: Promise<OrgWorld>;
  lastUsed: number;
  inFlight: number;
  /** Set while the world is being let go; whoever needs the org next waits for it. */
  closing?: Promise<void>;
}

const worldKey = (org: OrgRecord): string =>
  JSON.stringify([org.mode, org.chainId, org.addresses, org.seats]);

const ledgerOf = (mode: OrgMode): "sandbox" | "chain" => (mode === "sandbox" ? "sandbox" : "chain");

function sendJson(c: Context, body: unknown, status = 200): Response {
  return c.newResponse(JSON.stringify(body), status as 200, {
    "content-type": "application/json",
  });
}

/** What the directory routes answer with for one org. */
function describeOrg(org: OrgRecord): Record<string, unknown> {
  return {
    orgId: org.orgId,
    mode: org.mode,
    ledger: ledgerOf(org.mode),
    chainId: org.chainId,
    provisioned: isProvisioned(org),
    served: SERVED_ORG_MODES.includes(org.mode),
    ...(org.mode === "sandbox" ? { root: sandboxRootOf(org) } : {}),
    // The org's own cron (null: the operator's default) and its next epoch on its own clock.
    epoch: { schedule: org.epochCron, nextAtIso: org.epochNextAt },
    createdAt: org.createdAt,
  };
}

export function createMultiOrgHost(options: MultiOrgOptions): MultiOrgHost {
  const { directory, authToken, queue } = options;
  if (!authToken) {
    throw new Error("Multi-org mode needs LACREW_ORCH_TOKEN: without it every org would be open.");
  }
  const env = options.env ?? process.env;
  const now = options.now ?? Date.now;
  const idleMs = options.idleMs ?? DEFAULT_ORG_IDLE_MS;
  const directoryTtlMs = options.directoryTtlMs ?? 5_000;
  const dormantRecheckMs = options.dormantRecheckMs ?? 10 * 60_000;
  const corsOrigins = options.corsOrigins ?? parseCorsOrigins(env.LACREW_ORCH_CORS_ORIGINS);
  const build = options.buildWorld ?? buildOrgWorld;
  const context: OrgWorldContext = {
    queue,
    model: options.model,
    authToken,
    mcpUseMock: options.mcpUseMock,
    isDbReady: options.isDbReady,
    isDbConfigured: options.isDbConfigured,
    env,
    ...(options.stores ? { stores: options.stores } : {}),
    // An org's cadence is kept on its directory row.
    epoch: (orgId) => ({
      read: async () => {
        const org = await directory.get(orgId);
        return org ? { cron: org.epochCron, nextAt: org.epochNextAt, dueAt: org.epochDueAt } : null;
      },
      write: async (change, ifNextAt) => {
        const org = await directory.setEpoch(orgId, change, ifNextAt);
        if (org) remember(orgId, org);
        return org !== null;
      },
    }),
  };

  const worlds = new Map<string, Entry>();
  /** Orgs let go with nothing scheduled, and when. The minute sweep skips them for a while. */
  const dormant = new Map<string, number>();
  const known = new Map<string, { org: OrgRecord | null; at: number }>();

  const remember = (orgId: string, org: OrgRecord | null) => known.set(orgId, { org, at: now() });

  async function lookup(orgId: string): Promise<OrgRecord | null> {
    const cached = known.get(orgId);
    if (cached && now() - cached.at < directoryTtlMs) return cached.org;
    const org = await directory.get(orgId);
    remember(orgId, org);
    return org;
  }

  /** Let one world go. Everything it raised is stored before this resolves. */
  function retire(orgId: string, entry: Entry): Promise<void> {
    entry.closing ??= (async () => {
      try {
        await (await entry.world).close();
      } catch (err) {
        console.error(`[@lacrew/orchestrator] org ${orgId}: closing its world failed:`, err);
      } finally {
        if (worlds.get(orgId) === entry) worlds.delete(orgId);
      }
    })();
    return entry.closing;
  }

  /** The org's world, built if it is not, rebuilt if the org is no longer what it was built as. */
  async function worldFor(org: OrgRecord): Promise<Entry> {
    const key = worldKey(org);
    let entry = worlds.get(org.orgId);
    if (entry && (entry.closing || entry.key !== key)) {
      await retire(org.orgId, entry);
      entry = worlds.get(org.orgId);
    }
    if (!entry) {
      const fresh: Entry = { key, world: build(org, context), lastUsed: now(), inFlight: 0 };
      worlds.set(org.orgId, fresh);
      // A world that could not be built is not kept: the next call tries again.
      fresh.world.catch(() => {
        if (worlds.get(org.orgId) === fresh) worlds.delete(org.orgId);
      });
      entry = fresh;
    }
    return entry;
  }

  /** Run `work` against one org's world, counted as in flight so the world is not let go under it. */
  async function withWorld<T>(
    org: OrgRecord,
    work: (world: OrgWorld) => Promise<T>,
    touch: boolean,
  ): Promise<T> {
    const entry = await worldFor(org);
    entry.inFlight += 1;
    if (touch) {
      entry.lastUsed = now();
      dormant.delete(org.orgId);
    }
    try {
      return await work(await entry.world);
    } finally {
      entry.inFlight -= 1;
      if (touch) entry.lastUsed = now();
    }
  }

  /** Run scheduled work for each registered org, one after another; one org's failure stops no other. */
  async function forEachOrg(
    what: string,
    work: (world: OrgWorld) => Promise<unknown>,
    wake: "every" | "scheduled",
    only: (org: OrgRecord) => boolean = () => true,
  ): Promise<number> {
    const orgs = await directory.list();
    const registered = new Set(orgs.map((org) => org.orgId));
    // An org removed through another replica: its world here serves nobody.
    for (const [orgId, entry] of worlds) {
      if (!registered.has(orgId)) {
        remember(orgId, null);
        await retire(orgId, entry);
      }
    }
    let ran = 0;
    for (const org of orgs) {
      remember(org.orgId, org);
      if (!only(org)) continue;
      if (wake === "scheduled" && !worlds.has(org.orgId)) {
        const since = dormant.get(org.orgId);
        if (since !== undefined && now() - since < dormantRecheckMs) continue;
      }
      try {
        await withWorld(org, work, false);
        ran += 1;
      } catch (err) {
        console.error(`[@lacrew/orchestrator] org ${org.orgId}: ${what} failed:`, err);
      }
    }
    return ran;
  }

  /**
   * The shared tick. It decides nothing about cadence: it passes over every
   * org whose next epoch is still ahead on the wall clock, and asks each of
   * the others, on its own clock, whether its epoch is due. An org whose due
   * time was never worked out is asked once, which works it out.
   */
  const runDueEpochs = (): Promise<number> =>
    forEachOrg(
      "scheduled epoch",
      (world) => world.onEpochDue(),
      "every",
      (org) =>
        SERVED_ORG_MODES.includes(org.mode) &&
        (org.epochDueAt === null || Date.parse(org.epochDueAt) <= now()),
    );

  async function evictIdle(): Promise<string[]> {
    if (idleMs <= 0) return [];
    const evicted: string[] = [];
    for (const [orgId, entry] of [...worlds]) {
      const idle = () => entry.inFlight === 0 && now() - entry.lastUsed >= idleMs;
      if (entry.closing || !idle()) continue;
      const world = await entry.world.catch(() => null);
      if (!world) continue;
      // A world with a heartbeat, a cron flow or an open run would be rebuilt
      // by the next minute sweep; keeping it is cheaper and loses no tick.
      if (await world.hasScheduledWork()) continue;
      if (worlds.get(orgId) !== entry || !idle()) continue;
      dormant.set(orgId, now());
      await retire(orgId, entry);
      evicted.push(orgId);
    }
    return evicted;
  }

  const sweeper =
    idleMs > 0
      ? setInterval(
          () => {
            void evictIdle().catch((err) =>
              console.error("[@lacrew/orchestrator] idle org sweep failed:", err),
            );
          },
          Math.min(idleMs, 60_000),
        )
      : undefined;
  sweeper?.unref?.();

  const app = new Hono();
  const authorized = (c: Context) => isAuthorized(c.req.header("authorization"), authToken);

  app.use("*", async (c, next) => {
    const cors = corsHeadersFor(c.req.header("origin"), corsOrigins);
    if (c.req.method === "OPTIONS") {
      return c.newResponse(null, 204, { ...cors, ...(cors.vary ? CORS_PREFLIGHT_HEADERS : {}) });
    }
    await next();
    for (const [name, value] of Object.entries(cors)) c.res.headers.set(name, value);
  });

  app.onError((err, c) => sendJson(c, { error: err.message || "unknown" }, 500));

  // The process's own health: open, so a pool or a load balancer can probe it,
  // and silent about which orgs exist.
  app.get("/health", (c) =>
    sendJson(c, {
      ok: true,
      service: "lacrew-orchestrator",
      multiOrg: true,
      mode: "multi-org",
      // The modes an org can be run in here. An org registered in another mode
      // is kept in the directory and answers 503 until this process can run it.
      orgModes: SERVED_ORG_MODES,
      chainId: null,
      db: { configured: options.isDbConfigured(), ready: options.isDbReady() },
      queue: queue.status(),
      model: { provider: options.model.name },
      auth: { required: true },
      directory: { store: directory.name },
      worlds: { idleMs },
    }),
  );

  /* ——— The org directory ——— */

  app.use("/orgs/*", async (c, next) => {
    if (!authorized(c)) return sendJson(c, { error: "unauthorized" }, 401);
    // Only a registration carries a body; a bodiless DELETE is all a removal takes.
    if (c.req.method === "PUT" && rejectsNonJsonBody(c)) {
      return sendJson(c, { error: "content_type_must_be_json" }, 415);
    }
    await next();
  });
  app.use("/orgs", async (c, next) => {
    if (!authorized(c)) return sendJson(c, { error: "unauthorized" }, 401);
    await next();
  });

  app.get("/orgs", async (c) =>
    sendJson(c, { orgs: (await directory.list()).map(describeOrg), served: SERVED_ORG_MODES }),
  );

  app.put("/orgs/:orgId", async (c) => {
    const orgId = c.req.param("orgId");
    if (!isOrgId(orgId)) {
      return sendJson(
        c,
        { error: "invalid_org_id", detail: "An org id is 1 to 64 of a-z, 0-9, _ and -." },
        400,
      );
    }
    const body = (await c.req.json().catch(() => null)) as { mode?: unknown } | null;
    if (!isOrgMode(body?.mode)) {
      return sendJson(c, { error: "invalid_mode", modes: ORG_MODES }, 400);
    }
    const { org, created } = await directory.put(orgId, { mode: body.mode });
    remember(orgId, org);
    dormant.delete(orgId);
    // An org that changed mode is no longer what its world was built as.
    const entry = worlds.get(orgId);
    if (entry && entry.key !== worldKey(org)) await retire(orgId, entry);
    return sendJson(c, { ...describeOrg(org), created });
  });

  app.get("/orgs/:orgId", async (c) => {
    const orgId = c.req.param("orgId");
    const org = isOrgId(orgId) ? await directory.get(orgId) : null;
    if (org) remember(orgId, org);
    return org
      ? sendJson(c, { ...describeOrg(org), loaded: worlds.has(orgId) })
      : sendJson(c, { error: "org_not_found" }, 404);
  });

  app.delete("/orgs/:orgId", async (c) => {
    const orgId = c.req.param("orgId");
    if (!isOrgId(orgId)) return sendJson(c, { error: "org_not_found" }, 404);
    // The world first: what it still holds is written before the rows go, so
    // nothing it flushes can land after the delete and survive it.
    const entry = worlds.get(orgId);
    remember(orgId, null);
    if (entry) await retire(orgId, entry);
    const removed = await directory.remove(orgId);
    dormant.delete(orgId);
    return removed
      ? sendJson(c, { orgId, deleted: true })
      : sendJson(c, { error: "org_not_found" }, 404);
  });

  /* ——— One org ——— */

  const dispatch = async (c: Context): Promise<Response> => {
    const orgId = c.req.param("orgId") ?? "";
    const url = new URL(c.req.url);
    const rest = url.pathname.slice(`/o/${orgId}`.length) || "/";
    // A webhook producer holds its trigger's HMAC secret, not the operator's
    // token. The org's own app verifies that signature and refuses an unsigned
    // delivery; everything else under an org, its health included, needs the token.
    const isHookDelivery = c.req.method === "POST" && rest.startsWith("/hooks/");
    const hasToken = authorized(c);
    if (!isHookDelivery && !hasToken) return sendJson(c, { error: "unauthorized" }, 401);
    const org = isOrgId(orgId) ? await lookup(orgId) : null;
    if (isHookDelivery && !hasToken) {
      // Whoever sends a delivery without the token has proved nothing yet, and
      // is told nothing about which orgs exist: an org that is not registered,
      // one this process cannot serve, and a registered org with no such
      // trigger all answer the same, before anything else about the request
      // is looked at. Only a delivery to a trigger that exists goes further.
      let known = false;
      if (org && SERVED_ORG_MODES.includes(org.mode)) {
        try {
          // A path that does not decode names no trigger.
          const triggerId = decodeURIComponent(rest.slice("/hooks/".length));
          known =
            triggerId !== "" &&
            !triggerId.includes("/") &&
            (await withWorld(org, (world) => world.hasWebhookTrigger(triggerId), false));
        } catch (err) {
          // Answered like every other miss: a different answer here would say
          // the org exists. The producer retries; the operator reads this line.
          console.error(`[@lacrew/orchestrator] org ${orgId}: hook lookup failed:`, err);
        }
      }
      if (!known) return sendJson(c, { error: "webhook_trigger_not_found" }, 404);
    }
    if (!org) return sendJson(c, { error: "org_not_found" }, 404);
    url.pathname = rest;
    try {
      return await withWorld(
        org,
        async (world) => world.app.fetch(new Request(url, c.req.raw)),
        true,
      );
    } catch (err) {
      console.error(`[@lacrew/orchestrator] org ${orgId}: could not be served:`, err);
      return sendJson(
        c,
        {
          error: "org_unavailable",
          detail: err instanceof Error ? err.message.split("\n")[0] : "unknown",
        },
        503,
      );
    }
  };
  app.all("/o/:orgId", dispatch);
  app.all("/o/:orgId/*", dispatch);

  // Everything else is a data route with no org in it. The token is asked for
  // first, so the shape of this API is not described to whoever lacks it.
  app.all("*", (c) =>
    authorized(c)
      ? sendJson(
          c,
          {
            error: "org_required",
            detail:
              "This orchestrator serves many orgs. Address one as /o/<orgId>/..., and register it first with PUT /orgs/<orgId>.",
          },
          400,
        )
      : sendJson(c, { error: "unauthorized" }, 401),
  );

  return {
    app,
    onEpoch: runDueEpochs,
    onTick: async () => undefined,
    onFlowCron: async () => {
      // The minute sweep is the tick every queue provider fires, so due epochs
      // ride it: a cadence finer than the queue's own epoch schedule still runs.
      try {
        await runDueEpochs();
      } catch (err) {
        console.error("[@lacrew/orchestrator] due epoch sweep failed:", err);
      }
      return forEachOrg("minute sweep", (world) => world.onFlowCron(), "scheduled");
    },
    onWebhook: async (data) => {
      const orgId = data.orgId;
      const org = isOrgId(orgId) ? await lookup(orgId) : null;
      if (!org) {
        // The org was removed after the delivery was accepted: there is nobody to run it for.
        console.error(
          `[@lacrew/orchestrator] webhook job for unknown org ${JSON.stringify(orgId)} dropped`,
        );
        return undefined;
      }
      return withWorld(org, (world) => world.onWebhook(data), false);
    },
    evictIdle,
    loaded: () => [...worlds.keys()],
    close: async () => {
      if (sweeper) clearInterval(sweeper);
      await Promise.all([...worlds].map(([orgId, entry]) => retire(orgId, entry)));
    },
  };
}
