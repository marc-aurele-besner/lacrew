/**
 * Multi-org mode: one host, many orgs, each on its own.
 *
 * Runs against memory stores by default and against Postgres when DATABASE_URL
 * is set (the Stores job), where two orgs share every table and only the
 * `org_id` scope keeps them apart.
 */

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, describe, it } from "node:test";
import type { ProtocolEvent } from "@lacrew/core";
import { flow } from "@lacrew/flows";
import { createMemoryAuditStore, type AuditStore } from "./auditStore.js";
import { closeSharedDb } from "./dbPool.js";
import { MemoryModelProvider } from "./model/index.js";
import {
  buildOrgWorld,
  createMultiOrgHost,
  multiOrgSettings,
  orgEnvironment,
  type MultiOrgHost,
  type OrgStores,
} from "./multiOrgApp.js";
import {
  createMemoryOrgDirectory,
  createOrgDirectoryFromEnv,
  sandboxRootFor,
  type OrgDirectory,
} from "./orgDirectory.js";
import { InMemoryQueue } from "./queue/index.js";
import { createMemoryRuntimeStore } from "./runtimeStore.js";
import { createMemorySandboxStateStore } from "./sandboxLedger.js";
import { SIGNATURE_HEADER, TIMESTAMP_HEADER, signLacrewDelivery } from "./webhookSignature.js";

const PG = Boolean(process.env.DATABASE_URL);
// A durable store keeps a webhook secret only sealed, and sealing needs a key.
if (PG) process.env.LACREW_SESSION_KEY ??= randomBytes(32).toString("base64");
const TOKEN = "multi-org-test-token";
type Json = Record<string, any>;

after(async () => closeSharedDb());

const tag = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const USDC = (n: number) => (BigInt(n) * 10n ** 6n).toString();
const TARGET = `0x${"7".repeat(40)}`;

/** Keeps what it is given, so a rebuilt world can read its trail back without a database. */
function recordingAuditStore(): AuditStore {
  let events: ProtocolEvent[] = [];
  return {
    ...createMemoryAuditStore(),
    name: "recording",
    append: async (event) => {
      events.push(event);
    },
    recent: async (limit) => events.slice(-limit),
    clearSandbox: async () => {
      events = events.filter((event) => event.ledger !== "sandbox");
    },
  };
}

interface Harness {
  host: MultiOrgHost;
  directory: OrgDirectory;
  queue: InMemoryQueue;
  /** Every job handed to the queue, as it was enqueued. */
  enqueued: Array<{ name: string; data: Record<string, unknown> | undefined }>;
  clock: { now: number };
  call(
    method: string,
    path: string,
    options?: {
      body?: unknown;
      token?: string | null;
      headers?: Record<string, string>;
      raw?: string;
    },
  ): Promise<{ status: number; body: Json; text: string }>;
  close(): Promise<void>;
}

async function harness(
  options: { idleMs?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<Harness> {
  const directory = PG ? createOrgDirectoryFromEnv() : createMemoryOrgDirectory();
  const queue = new InMemoryQueue();
  const enqueued: Harness["enqueued"] = [];
  const enqueue = queue.enqueue.bind(queue);
  queue.enqueue = async (name, data) => {
    enqueued.push({ name, data });
    return enqueue(name, data);
  };
  const clock = { now: Date.now() };
  // Without a database a world's stores are its own, so the ones a rebuilt
  // world must find again are kept here, per org, as a database would.
  const kept = new Map<string, OrgStores>();
  const stores = (orgId: string): OrgStores => {
    let found = kept.get(orgId);
    if (!found) {
      found = {
        sandboxState: createMemorySandboxStateStore(),
        audit: recordingAuditStore(),
        runtime: createMemoryRuntimeStore(),
      };
      kept.set(orgId, found);
    }
    return found;
  };
  const host = createMultiOrgHost({
    directory,
    authToken: TOKEN,
    queue,
    model: new MemoryModelProvider(),
    mcpUseMock: false,
    isDbReady: () => PG,
    isDbConfigured: () => PG,
    env: options.env ?? {},
    idleMs: options.idleMs ?? 0,
    directoryTtlMs: 0,
    now: () => clock.now,
    ...(PG ? {} : { stores }),
  });
  await queue.start({
    onEpoch: host.onEpoch,
    onTick: host.onTick,
    onFlowCron: host.onFlowCron,
    onWebhook: host.onWebhook,
  });
  const registered = new Set<string>();
  const call: Harness["call"] = async (method, path, opts = {}) => {
    const token = opts.token === undefined ? TOKEN : opts.token;
    const payload = opts.raw ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body));
    const res = await host.app.request(path, {
      method,
      ...(payload === undefined ? {} : { body: payload }),
      headers: {
        ...(payload === undefined ? {} : { "content-type": "application/json" }),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...opts.headers,
      },
    });
    const text = await res.text();
    let body: Json = {};
    try {
      body = JSON.parse(text) as Json;
    } catch {
      /* not JSON: the text is what there is */
    }
    const put = /^\/orgs\/([^/]+)$/.exec(path);
    if (method === "PUT" && put && res.status === 200) registered.add(put[1]!);
    return { status: res.status, body, text };
  };
  return {
    host,
    directory,
    queue,
    enqueued,
    clock,
    call,
    close: async () => {
      await queue.drain();
      // Leave a shared database as it was found.
      for (const orgId of registered) await call("DELETE", `/orgs/${orgId}`);
      await host.close();
      await queue.stop();
    },
  };
}

/** Register a sandbox org with an id of this run's own. */
async function register(h: Harness, prefix: string): Promise<string> {
  const orgId = `${prefix}-${tag()}`;
  const res = await h.call("PUT", `/orgs/${orgId}`, { body: { mode: "sandbox" } });
  assert.equal(res.status, 200, res.text);
  return orgId;
}

/** Propose, vote and execute one governance action in one org. */
async function govern(h: Harness, org: string, path: string, body: Json): Promise<Json> {
  const proposed = await h.call("POST", `/o/${org}${path}`, { body });
  assert.equal(proposed.status, 200, `${path}: ${proposed.text}`);
  const voted = await h.call("POST", `/o/${org}/governance/vote`, {
    body: { proposalId: proposed.body.proposalId, support: true },
  });
  assert.equal(voted.status, 200, voted.text);
  const executed = await h.call("POST", `/o/${org}/governance/execute`, {
    body: { proposalId: proposed.body.proposalId },
  });
  assert.equal(executed.status, 200, executed.text);
  return proposed.body;
}

const ok = (res: { status: number; text: string }, what: string, ...statuses: number[]) =>
  assert.ok(
    (statuses.length ? statuses : [200]).includes(res.status),
    `${what}: ${res.status} ${res.text}`,
  );

describe("multi-org host: the contract", () => {
  it("refuses to be built without a token", () => {
    assert.throws(
      () =>
        createMultiOrgHost({
          directory: createMemoryOrgDirectory(),
          authToken: "",
          queue: new InMemoryQueue(),
          model: new MemoryModelProvider(),
          mcpUseMock: false,
          isDbReady: () => false,
          isDbConfigured: () => false,
        }),
      /LACREW_ORCH_TOKEN/,
    );
  });

  it("serves an open process health that says it is multi-org and names no org", async () => {
    const h = await harness();
    try {
      const orgId = await register(h, "health");
      const res = await h.call("GET", "/health", { token: null });
      assert.equal(res.status, 200);
      assert.equal(res.body.multiOrg, true);
      assert.deepEqual(res.body.orgModes, ["sandbox"]);
      assert.equal(res.body.auth.required, true);
      assert.equal(res.body.chainId, null);
      assert.ok(!res.text.includes(orgId), "an open route does not list orgs");
    } finally {
      await h.close();
    }
  });

  it("registers, reads and removes orgs by name, with the token", async () => {
    const h = await harness();
    try {
      const orgId = `dir-${tag()}`;
      for (const [method, path] of [
        ["PUT", `/orgs/${orgId}`],
        ["GET", `/orgs/${orgId}`],
        ["DELETE", `/orgs/${orgId}`],
        ["GET", "/orgs"],
      ] as const) {
        const res = await h.call(method, path, {
          token: null,
          ...(method === "PUT" ? { body: { mode: "sandbox" } } : {}),
        });
        assert.equal(res.status, 401, `${method} ${path} without the token`);
        const wrong = await h.call(method, path, { token: "not-the-token" });
        assert.equal(wrong.status, 401, `${method} ${path} with a wrong token`);
      }
      assert.equal((await h.call("GET", `/orgs/${orgId}`)).status, 404, "nothing was created");

      const created = await h.call("PUT", `/orgs/${orgId}`, { body: { mode: "sandbox" } });
      assert.equal(created.status, 200, created.text);
      assert.equal(created.body.orgId, orgId);
      assert.equal(created.body.mode, "sandbox");
      assert.equal(created.body.ledger, "sandbox");
      assert.equal(created.body.chainId, null);
      assert.equal(created.body.created, true);
      assert.equal(created.body.root, sandboxRootFor(orgId), "a root derived from the org id");

      // Idempotent: the same call again changes nothing and says so.
      const again = await h.call("PUT", `/orgs/${orgId}`, { body: { mode: "sandbox" } });
      assert.equal(again.status, 200);
      assert.equal(again.body.created, false);
      assert.equal(again.body.createdAt, created.body.createdAt);
      assert.equal(again.body.root, created.body.root);

      const read = await h.call("GET", `/orgs/${orgId}`);
      assert.equal(read.status, 200);
      assert.equal(read.body.mode, "sandbox");
      const listed = await h.call("GET", "/orgs");
      assert.ok((listed.body.orgs as Json[]).some((org) => org.orgId === orgId));

      // What a registration may not be.
      for (const bad of ["Upper", "has.dot", "x".repeat(65), "sp ace"]) {
        const res = await h.call("PUT", `/orgs/${encodeURIComponent(bad)}`, {
          body: { mode: "sandbox" },
        });
        assert.equal(res.status, 400, bad);
        assert.equal(res.body.error, "invalid_org_id");
      }
      for (const body of [{}, { mode: "moon" }, { mode: 7 }]) {
        const res = await h.call("PUT", `/orgs/${orgId}`, { body });
        assert.equal(res.status, 400);
        assert.equal(res.body.error, "invalid_mode");
      }
      const notJson = await h.call("PUT", `/orgs/${orgId}`, {
        raw: "mode=sandbox",
        headers: { "content-type": "text/plain" },
      });
      assert.equal(notJson.status, 415);

      // A bodiless DELETE is all it takes, and it is not repeatable.
      const removed = await h.call("DELETE", `/orgs/${orgId}`);
      assert.equal(removed.status, 200, removed.text);
      assert.equal(removed.body.deleted, true);
      assert.equal((await h.call("DELETE", `/orgs/${orgId}`)).status, 404);
      assert.equal((await h.call("GET", `/orgs/${orgId}`)).body.error, "org_not_found");
      assert.equal((await h.call("GET", `/o/${orgId}/org`)).body.error, "org_not_found");
    } finally {
      await h.close();
    }
  });

  it("answers 401, 400 org_required and 404 org_not_found where each belongs", async () => {
    const h = await harness();
    try {
      const orgId = await register(h, "errors");
      // No org in the path: a data route cannot be answered for nobody.
      for (const path of ["/org", "/audit", "/intents", "/sandbox", "/flows", "/"]) {
        assert.equal(
          (await h.call("GET", path, { token: null })).status,
          401,
          `${path} unauthenticated`,
        );
        const res = await h.call("GET", path);
        assert.equal(res.status, 400, path);
        assert.equal(res.body.error, "org_required");
      }
      const write = await h.call("POST", "/sandbox/fund", { body: { amount: "1" } });
      assert.equal(write.status, 400);
      assert.equal(write.body.error, "org_required");

      // An org nobody registered is not created by being addressed.
      const ghost = `ghost-${tag()}`;
      for (const [method, path] of [
        ["GET", `/o/${ghost}/org`],
        ["GET", `/o/${ghost}/health`],
        ["GET", `/o/${ghost}`],
        ["POST", `/o/${ghost}/sandbox/fund`],
        ["GET", "/o/Not_An_Id!/org"],
      ] as const) {
        const res = await h.call(method, path, method === "POST" ? { body: { amount: "1" } } : {});
        assert.equal(res.status, 404, `${method} ${path}`);
        assert.equal(res.body.error, "org_not_found");
      }
      assert.equal((await h.call("GET", `/orgs/${ghost}`)).status, 404, "and still is not there");
      assert.ok(!h.host.loaded().includes(ghost));

      // Everything under an org needs the token, its health included.
      for (const path of ["/health", "/org", "/audit", "/sandbox"]) {
        const res = await h.call("GET", `/o/${orgId}${path}`, { token: null });
        assert.equal(res.status, 401, `/o/<org>${path} unauthenticated`);
        assert.equal(res.body.error, "unauthorized");
      }
      // Without the token, a registered org and an unknown one look the same.
      assert.equal((await h.call("GET", `/o/${ghost}/org`, { token: null })).status, 401);
    } finally {
      await h.close();
    }
  });

  it("answers an unauthenticated hook delivery the same for no org and for no trigger", async () => {
    const h = await harness();
    try {
      const orgId = await register(h, "hooks");
      const chain = `hooks-chain-${tag()}`;
      await h.call("PUT", `/orgs/${chain}`, { body: { mode: "testnet" } });
      const ghost = `ghost-${tag()}`;
      const hook = `hook_${tag()}`;
      // A registered org with no such trigger is the answer every other must match.
      const deliveries: Array<[string, Parameters<Harness["call"]>[2]]> = [
        ["a JSON body", { raw: "{}", token: null }],
        ["no body", { token: null }],
        [
          "a body that is not JSON",
          { raw: "x", token: null, headers: { "content-type": "text/plain" } },
        ],
        ["a wrong token", { raw: "{}", token: "not-the-token" }],
      ];
      for (const [what, options] of deliveries) {
        const known = await h.call("POST", `/o/${orgId}/hooks/${hook}`, options);
        assert.equal(known.status, 404, `${what}: ${known.text}`);
        assert.deepEqual(known.body, { error: "webhook_trigger_not_found" }, what);
        for (const [who, path] of [
          ["an org nobody registered", `/o/${ghost}/hooks/${hook}`],
          ["a chain org that is not served", `/o/${chain}/hooks/${hook}`],
          ["an id no org can have", `/o/Not_An_Id!/hooks/${hook}`],
          ["a path that does not decode", `/o/${orgId}/hooks/%E0%A4%A`],
          ["a path below a trigger", `/o/${orgId}/hooks/${hook}/more`],
        ] as const) {
          const res = await h.call("POST", path, options);
          assert.equal(res.status, known.status, `${what}, ${who}: ${res.text}`);
          assert.equal(res.text, known.text, `${what}, ${who}`);
        }
      }
      assert.ok(!h.host.loaded().includes(ghost), "and addressing an org does not create it");

      // With the token the caller is the control plane, and is told which it was.
      const named = await h.call("POST", `/o/${ghost}/hooks/${hook}`, { body: {} });
      assert.equal(named.status, 404);
      assert.equal(named.body.error, "org_not_found");
      const missing = await h.call("POST", `/o/${orgId}/hooks/${hook}`, { body: {} });
      assert.equal(missing.status, 404);
      assert.equal(missing.body.error, "webhook_trigger_not_found");
    } finally {
      await h.close();
    }
  });

  it("reports an org's mode, ledger and chain on its own health", async () => {
    const h = await harness({ env: { LACREW_CONNECTORS: "[]", LACREW_ROOT_AUTH: "wallet" } });
    try {
      const orgId = await register(h, "orghealth");
      const res = await h.call("GET", `/o/${orgId}/health`);
      assert.equal(res.status, 200, res.text);
      assert.equal(res.body.mode, "sandbox");
      assert.equal(res.body.ledger, "sandbox");
      assert.equal(res.body.chainId, null);
      assert.deepEqual(res.body.org, { id: orgId, mode: "sandbox", provisioned: true });
      assert.equal(
        res.body.rootAuth.required,
        false,
        "the environment's root proof is not this org's",
      );
      assert.equal(res.body.mcp.external.hosted, true);
      assert.equal(res.body.mcp.external.allowStdio, false);
      assert.equal(res.body.governance.autoExecute, false);

      const disabled = res.body.multiOrg.disabled as Json[];
      const surfaces = disabled.map((entry) => entry.surface);
      for (const surface of [
        "connectors",
        "externalMcp.servers",
        "externalMcp.environmentCredentials",
        "externalMcp.stdio",
        "rootAuth",
        "planRequired.seed",
        "dualControl.seed",
        "walletWatchlist",
        "governance.autoExecute",
        "chain",
      ]) {
        assert.ok(surfaces.includes(surface), `${surface} is listed as disabled`);
      }
      assert.ok(
        disabled.every((entry) => typeof entry.reason === "string" && entry.reason.length > 20),
      );
      // Set in this process and ignored for the org: said, not silently dropped.
      assert.equal(disabled.find((entry) => entry.surface === "connectors")?.configured, true);
      assert.equal(disabled.find((entry) => entry.surface === "rootAuth")?.configured, true);
      assert.equal(
        disabled.find((entry) => entry.surface === "walletWatchlist")?.configured,
        false,
      );
      const shared = (res.body.multiOrg.shared as Json[]).map((entry) => entry.surface);
      assert.ok(
        shared.includes("epoch.schedule") && shared.includes("model") && shared.includes("auth"),
      );

      // An org's cadence is its own: setting it leaves the queue's schedule alone.
      const queueBefore = h.queue.status().epochSchedule;
      const reschedule = await h.call("POST", `/o/${orgId}/epoch/schedule`, {
        body: { cron: "*/5 * * * *" },
      });
      assert.equal(reschedule.status, 200, reschedule.text);
      assert.equal(reschedule.body.schedule, "*/5 * * * *");
      assert.equal(h.queue.status().epochSchedule, queueBefore);
    } finally {
      await h.close();
    }
  });

  it("keeps a chain org in the directory and says plainly that it is not served", async () => {
    const h = await harness();
    try {
      const orgId = `chain-${tag()}`;
      const put = await h.call("PUT", `/orgs/${orgId}`, { body: { mode: "testnet" } });
      assert.equal(put.status, 200, put.text);
      assert.equal(put.body.mode, "testnet");
      assert.equal(put.body.ledger, "chain");
      assert.equal(put.body.provisioned, false);
      assert.equal(put.body.served, false);

      const health = await h.call("GET", `/o/${orgId}/health`);
      assert.equal(health.status, 200);
      assert.equal(health.body.mode, "unavailable");
      assert.equal(health.body.ledger, null);
      assert.equal(health.body.chainId, null);
      assert.equal(health.body.chain.reason, "org_not_provisioned");
      assert.deepEqual(health.body.org, { id: orgId, mode: "testnet", provisioned: false });

      // Never an empty org: every data route says the org has no ledger here.
      for (const path of ["/org", "/audit", "/intents", "/treasury/balances"]) {
        const res = await h.call("GET", `/o/${orgId}${path}`);
        assert.equal(res.status, 503, path);
        assert.equal(res.body.error, "chain_unavailable");
        assert.equal(res.body.reason, "org_not_provisioned");
      }
      assert.equal(
        (await h.call("GET", `/o/${orgId}/sandbox`)).status,
        503,
        "and it is no sandbox",
      );

      // The same org, moved to the sandbox: served at once, by a world of its own.
      const moved = await h.call("PUT", `/orgs/${orgId}`, { body: { mode: "sandbox" } });
      assert.equal(moved.body.mode, "sandbox");
      assert.equal(moved.body.created, false);
      const sandbox = await h.call("GET", `/o/${orgId}/sandbox`);
      assert.equal(sandbox.status, 200, sandbox.text);
      assert.equal(sandbox.body.orgId, orgId);
      assert.equal((await h.call("GET", `/o/${orgId}/health`)).body.mode, "sandbox");
    } finally {
      await h.close();
    }
  });
});

describe("multi-org host: process-wide settings", () => {
  it("hands an org a short list of operator settings and nothing else", () => {
    const env = orgEnvironment({
      LACREW_CONNECTORS: "[]",
      LACREW_MCP_SERVERS: "[]",
      LACREW_MCP_ALLOW_ENV: "GH_*",
      LACREW_MCP_ALLOW_STDIO: "1",
      LACREW_MCP_ALLOW_LOOPBACK: "1",
      LACREW_MCP_ALLOW_HOSTS: "api.example.com",
      LACREW_MCP_HOSTED: "0",
      LACREW_ROOT_AUTH: "wallet",
      LACREW_PLAN_REQUIRED: "required",
      LACREW_DUAL_CONTROL: "risky_writes",
      LACREW_AUTO_EXECUTE: "1",
      WALLET_WATCHLIST: "[]",
      PRIVATE_KEY: "0xabc",
      RPC_URL: "http://127.0.0.1:8545",
      GH_TOKEN: "ghp_secret",
      LACREW_ORCH_TOKEN: "t",
      LACREW_SESSION_KEY: "k",
      LACREW_HUMAN_GATE_TTL_MS: "120000",
      SOMETHING_NOBODY_THOUGHT_ABOUT: "x",
    });
    assert.deepEqual(env, {
      LACREW_MCP_ALLOW_HOSTS: "api.example.com",
      LACREW_HUMAN_GATE_TTL_MS: "120000",
      LACREW_MCP_HOSTED: "1",
    });
  });

  it("accounts for every setting the orchestrator reads for one org", () => {
    const settings = multiOrgSettings({ LACREW_CONNECTORS: "[]" });
    const named = new Set(settings.flatMap((setting) => setting.env));
    // Each of these is read from the environment for the one org of a
    // single-org orchestrator. A new one must be given a line: disabled, or
    // shared with a reason.
    for (const name of [
      "LACREW_CONNECTORS",
      "LACREW_MCP_SERVERS",
      "LACREW_MCP_ALLOW_ENV",
      "LACREW_MCP_ALLOW_STDIO",
      "LACREW_MCP_ALLOW_LOOPBACK",
      "LACREW_MCP_HOSTED",
      "LACREW_ROOT_AUTH",
      "LACREW_ROOT_ADDRESS",
      "LACREW_ROOT_SAFE_ADDRESS",
      "LACREW_ROOT_PASSKEY_PUBKEY",
      "LACREW_ROOT_APPROVAL_RELAYER",
      "LACREW_PLAN_REQUIRED",
      "LACREW_DUAL_CONTROL",
      "WALLET_WATCHLIST",
      "LACREW_AUTO_EXECUTE",
      "EPOCH_CRON",
      "RPC_URL",
      "PRIVATE_KEY",
      "MANAGER_PRIVATE_KEY",
      "LACREW_ISSUER_PRIVATE_KEY",
      "LACREW_MODE",
      "LACREW_SANDBOX_ROOT",
      "LACREW_SESSION_KEY",
      "LACREW_ORCH_TOKEN",
      "ANTHROPIC_API_KEY",
    ]) {
      assert.ok(named.has(name), `${name} has no line in multiOrgSettings`);
    }
    assert.equal(settings.find((s) => s.surface === "connectors")?.configured, true);
    assert.equal(settings.find((s) => s.surface === "rootAuth")?.configured, false);
  });

  it("does not let an environment connector or credential reach an org", async () => {
    const h = await harness({
      env: {
        LACREW_CONNECTORS: JSON.stringify([
          {
            id: "notes",
            baseUrl: "https://notes.example",
            auth: { kind: "bearer", tokenEnv: "NOTES_TOKEN" },
            routes: [{ name: "list", method: "GET", path: "/notes", effect: "read" }],
          },
        ]),
        NOTES_TOKEN: "notes-secret-token",
        LACREW_MCP_ALLOW_ENV: "NOTES_*",
        LACREW_MCP_ALLOW_STDIO: "1",
      },
    });
    try {
      const orgId = await register(h, "leak");
      const connectors = await h.call("GET", `/o/${orgId}/connectors`);
      assert.equal(connectors.status, 200, connectors.text);
      assert.deepEqual(connectors.body.connectors, []);
      const tools = await h.call("GET", `/o/${orgId}/mcp/tools`);
      assert.ok(!tools.text.includes("notes."), "no connector tool is offered");

      // A subprocess server is refused whatever the environment allowed.
      const stdio = await h.call("POST", `/o/${orgId}/mcp/servers/attach`, {
        body: { server: { id: "local", transport: "stdio", command: "cat" } },
      });
      assert.ok(stdio.status >= 400, stdio.text);
      assert.deepEqual((await h.call("GET", `/o/${orgId}/mcp/servers`)).body.servers ?? [], []);
      const health = await h.call("GET", `/o/${orgId}/health`);
      assert.deepEqual(health.body.mcp.external.allowEnv, []);
      assert.ok(!health.text.includes("notes-secret-token"));
    } finally {
      await h.close();
    }
  });
});

describe("multi-org host: two orgs side by side", () => {
  it("serves each org its own state on every GET route, hooks and reset included", async () => {
    const h = await harness();
    try {
      const a = await register(h, "side-a");
      const b = await register(h, "side-b");
      const mark = { a: `mk-a-${tag()}`, b: `mk-b-${tag()}` };
      const o = (org: string, path: string) => `/o/${org}${path}`;

      /* ——— org A: something on every surface it can reach ——— */
      ok(await h.call("POST", o(a, "/sandbox/fund"), { body: { amount: USDC(1000) } }), "fund a");
      const hire = await govern(h, a, "/governance/propose-hire", { label: mark.a });
      const worker = hire.account as string;
      await govern(h, a, "/governance/propose-set-grant", { account: worker, amount: USDC(100) });
      await govern(h, a, "/governance/propose-set-whitelist", { target: TARGET, allowed: true });
      ok(await h.call("POST", o(a, "/epoch")), "epoch a");
      const spent = await h.call("POST", o(a, "/mcp/call"), {
        body: {
          name: "lacrew_propose_intent",
          arguments: { agent: worker, target: TARGET, value: USDC(10) },
        },
      });
      assert.equal(spent.body.result?.verdict, "ALLOW", spent.text);
      const escalated = await h.call("POST", o(a, "/mcp/call"), {
        body: {
          name: "lacrew_propose_intent",
          arguments: { agent: worker, target: TARGET, value: USDC(60) },
        },
      });
      assert.equal(escalated.body.result?.verdict, "ESCALATE", escalated.text);

      const hooked = flow(`hooked-${tag()}`, `Hooked ${mark.a}`)
        .model("sum", { prompt: "{{input}}" })
        .build();
      ok(
        await h.call("POST", o(a, "/flows"), { body: { flow: { ...hooked, trigger: "webhook" } } }),
        "save flow a",
      );
      const trigger = await h.call("POST", o(a, "/flows/triggers"), {
        body: { flowId: hooked.id },
      });
      assert.equal(trigger.status, 201, trigger.text);
      const hookId = trigger.body.trigger.id as string;
      const hookSecret = trigger.body.secret as string;
      ok(
        await h.call("POST", o(a, "/flows/run"), { body: { id: hooked.id, input: mark.a } }),
        "run flow a",
      );
      ok(
        await h.call("POST", o(a, "/messages"), {
          body: {
            thread: "org",
            author: mark.a,
            authorKind: "human",
            kind: "note",
            body: `note ${mark.a}`,
          },
        }),
        "message a",
        200,
        201,
      );
      ok(
        await h.call("PUT", o(a, "/agents/brief"), {
          body: { agent: worker, layers: [{ label: mark.a, text: `brief ${mark.a}` }] },
        }),
        "brief a",
      );
      ok(
        await h.call("PUT", o(a, "/connectors/modes"), {
          body: { scope: { level: "agent", ref: worker }, route: "github.*", mode: "deny" },
        }),
        "connector mode a",
      );
      ok(
        await h.call("PUT", o(a, "/crew/bindings"), {
          body: { blueprintId: mark.a, roles: { lead: worker }, labels: { lead: mark.a } },
        }),
        "crew binding a",
      );
      ok(
        await h.call("POST", o(a, "/budgets"), {
          body: {
            budget: {
              crewId: worker,
              period: "calendar_month",
              limits: { maxUsd: 5 },
              policy: "soft",
              enabled: true,
            },
          },
        }),
        "budget a",
      );
      ok(
        await h.call("POST", o(a, "/heartbeats"), {
          body: {
            heartbeat: {
              crewId: worker,
              schedule: "0 9 * * *",
              checklist: [{ kind: "flow", id: hooked.id }],
              enabled: false,
            },
          },
        }),
        "heartbeat a",
      );
      ok(
        await h.call("POST", o(a, "/agents/pause"), { body: { agent: worker, reason: mark.a } }),
        "pause a",
      );

      /* ——— org B: a little of its own, so the check runs both ways ——— */
      ok(await h.call("POST", o(b, "/sandbox/fund"), { body: { amount: USDC(3) } }), "fund b");
      ok(
        await h.call("POST", o(b, "/messages"), {
          body: {
            thread: "org",
            author: mark.b,
            authorKind: "human",
            kind: "note",
            body: `note ${mark.b}`,
          },
        }),
        "message b",
        200,
        201,
      );

      /* ——— a signed delivery under the prefix, with no bearer token ——— */
      const delivery = JSON.stringify({ note: mark.a });
      const ts = Math.floor(Date.now() / 1000);
      const signed = {
        [SIGNATURE_HEADER.lacrew]: signLacrewDelivery(hookSecret, ts, delivery),
        [TIMESTAMP_HEADER]: String(ts),
      };
      const unsigned = await h.call("POST", o(a, `/hooks/${hookId}`), {
        raw: delivery,
        token: null,
      });
      assert.ok(
        unsigned.status === 401 || unsigned.status === 400,
        `unsigned: ${unsigned.status} ${unsigned.text}`,
      );
      // The same signed request against another org finds no such trigger.
      const crossed = await h.call("POST", o(b, `/hooks/${hookId}`), {
        raw: delivery,
        token: null,
        headers: signed,
      });
      assert.equal(crossed.status, 404, crossed.text);
      const accepted = await h.call("POST", o(a, `/hooks/${hookId}`), {
        raw: delivery,
        token: null,
        headers: signed,
      });
      assert.equal(accepted.status, 202, accepted.text);
      const job = h.enqueued.find((entry) => entry.name === "webhook");
      assert.equal(job?.data?.orgId, a, "the queued job carries its org");
      await h.queue.drain();
      const runsA = await h.call("GET", o(a, "/flows/runs"));
      assert.ok(
        (runsA.body.runs as Json[]).some((run) => run.runId === accepted.body.runId),
        "the delivery ran in the org it was sent to",
      );
      assert.ok(!(await h.call("GET", o(b, "/flows/runs"))).text.includes(accepted.body.runId));

      /* ——— every GET route, both ways ——— */
      if (PG) {
        // Let both worlds go first, so what follows is answered by worlds rebuilt
        // from the tables the two orgs share, not by what each still held in memory.
        await h.queue.drain();
        await h.host.close();
        assert.deepEqual(h.host.loaded(), []);
      }
      const reference = await buildOrgWorld(
        {
          orgId: "routes",
          mode: "sandbox",
          chainId: null,
          addresses: null,
          seats: null,
          epochCron: null,
          epochNextAt: null,
          epochDueAt: null,
          createdAt: "",
        },
        {
          queue: new InMemoryQueue(),
          model: new MemoryModelProvider(),
          authToken: TOKEN,
          mcpUseMock: false,
          isDbReady: () => false,
          isDbConfigured: () => false,
          env: {},
          stores: () => ({
            sandboxState: createMemorySandboxStateStore(),
            audit: createMemoryAuditStore(),
            runtime: createMemoryRuntimeStore(),
          }),
        },
      );
      const routes = [
        ...new Set(reference.app.routes.filter((r) => r.method === "GET").map((r) => r.path)),
      ];
      await reference.close();
      assert.ok(routes.length >= 45, `only ${routes.length} GET routes found`);
      assert.ok(
        routes.every((path) => !path.includes(":")),
        "a GET route with a path parameter needs its own case here",
      );

      const rootA = sandboxRootFor(a);
      const rootB = sandboxRootFor(b);
      const runId = accepted.body.runId as string;
      // What only org A holds, and no request to org B names.
      const secretsOfA = [mark.a, a, rootA];
      const secretsOfB = [mark.b, b, rootB];
      // Org A's identifiers, offered to org B under every name a route reads
      // one by, and a set of the same shape that belongs to nobody. A route may
      // echo what it was asked for, so the test is that org B answers the real
      // identifiers of org A exactly as it answers ones that do not exist.
      const idsOfA = { agent: worker, flow: hooked.id, run: runId, hook: hookId };
      const idsOfNobody = {
        agent: `0x${"c0de".repeat(10)}`,
        flow: `hooked-${tag()}`,
        run: `run-wh-${tag()}`,
        hook: `wht_${tag()}`,
      };
      const probe = (ids: typeof idsOfA) =>
        new URLSearchParams({
          agent: ids.agent,
          account: ids.agent,
          as: ids.agent,
          crewId: ids.agent,
          crew: ids.agent,
          principal: ids.agent,
          scope: `agent:${ids.agent}`,
          thread: `agent:${ids.agent}`,
          id: ids.flow,
          flowId: ids.flow,
          runId: ids.run,
          triggerId: ids.hook,
          trigger: ids.hook,
          limit: "200",
        }).toString();
      /** A response with the identifiers it was asked about, and the clock, taken out. */
      const shape = (text: string, ids: typeof idsOfA) =>
        Object.values(ids)
          .reduce((out, id) => out.split(id.toLowerCase()).join("<id>"), text.toLowerCase())
          .replace(/\d{4}-\d{2}-\d{2}t\d{2}:\d{2}:\d{2}(\.\d+)?z/g, "<time>")
          .replace(/"now":\d+/g, '"now":<n>');
      const shows = (text: string, secret: string) =>
        text.toLowerCase().includes(secret.toLowerCase());

      const seenInA = new Set<string>();
      for (const path of routes) {
        const plainB = await h.call("GET", o(b, path));
        const askedB = await h.call("GET", o(b, `${path}?${probe(idsOfA)}`));
        const controlB = await h.call("GET", o(b, `${path}?${probe(idsOfNobody)}`));
        for (const [what, res] of [
          ["", plainB],
          [" asked for org a's ids", askedB],
        ] as const) {
          assert.ok(
            res.status < 500,
            `GET ${path}${what} on org b: ${res.status} ${res.text.slice(0, 200)}`,
          );
          for (const secret of secretsOfA) {
            assert.ok(
              !shows(res.text, secret),
              `GET ${path}${what} on org b shows org a's ${secret}`,
            );
          }
        }
        for (const id of Object.values(idsOfA)) {
          assert.ok(!shows(plainB.text, id), `GET ${path} on org b shows org a's ${id}`);
        }
        assert.equal(askedB.status, controlB.status, `GET ${path}: org a's ids and unknown ids`);
        assert.equal(
          shape(askedB.text, idsOfA),
          shape(controlB.text, idsOfNobody),
          `GET ${path} on org b answers org a's ids differently from ids nobody has`,
        );

        for (const query of ["", `?${probe(idsOfA)}`]) {
          const fromA = await h.call("GET", o(a, path + query));
          assert.ok(
            fromA.status < 500,
            `GET ${path} on org a: ${fromA.status} ${fromA.text.slice(0, 200)}`,
          );
          for (const secret of secretsOfB) {
            assert.ok(!shows(fromA.text, secret), `GET ${path} on org a shows org b's ${secret}`);
          }
          for (const known of [...secretsOfA, ...Object.values(idsOfA)]) {
            if (shows(fromA.text, known)) seenInA.add(known);
          }
        }
      }
      // The check above is only worth something if org A's own routes do show these.
      assert.deepEqual([...seenInA].sort(), [...secretsOfA, ...Object.values(idsOfA)].sort());

      /* ——— a reset in one org is that org's alone ——— */
      const beforeB = await h.call("GET", o(b, "/sandbox"));
      const trailB = await h.call("GET", o(b, "/audit"));
      const reset = await h.call("POST", o(a, "/sandbox/reset"), { body: {} });
      assert.equal(reset.status, 200, reset.text);
      const afterA = await h.call("GET", o(a, "/sandbox"));
      assert.equal(afterA.body.treasury.total, "0");
      assert.equal(afterA.body.root, rootA);
      const trailA = (await h.call("GET", o(a, "/audit"))).body.events as Json[];
      assert.deepEqual(
        trailA.map((event) => event.type),
        ["SandboxReset"],
      );
      assert.deepEqual((await h.call("GET", o(a, "/intents/history"))).body.intents ?? [], []);
      assert.equal((await h.call("GET", o(a, "/org"))).body.nodes.length, 1, "genesis again");
      // Flows are configuration, not ledger state: the reset keeps them.
      assert.ok((await h.call("GET", o(a, "/flows"))).text.includes(hooked.id));

      const afterB = await h.call("GET", o(b, "/sandbox"));
      assert.equal(afterB.body.version, beforeB.body.version);
      assert.deepEqual(afterB.body.treasury, beforeB.body.treasury);
      assert.equal(afterB.body.treasury.total, USDC(3));
      assert.deepEqual((await h.call("GET", o(b, "/audit"))).body.events, trailB.body.events);
      assert.ok((await h.call("GET", o(b, "/messages?thread=org"))).text.includes(mark.b));
    } finally {
      await h.close();
    }
  });

  it("runs scheduled work for each org and lets one org's failure stop no other", async () => {
    const h = await harness();
    try {
      const a = await register(h, "cron-a");
      const b = await register(h, "cron-b");
      const chain = `cron-c-${tag()}`;
      await h.call("PUT", `/orgs/${chain}`, { body: { mode: "testnet" } });
      for (const org of [a, b]) {
        ok(await h.call("POST", `/o/${org}/sandbox/fund`, { body: { amount: USDC(500) } }), "fund");
        const hire = await govern(h, org, "/governance/propose-hire", { label: "worker" });
        await govern(h, org, "/governance/propose-set-grant", {
          account: hire.account,
          amount: USDC(50),
        });
      }
      const epochOf = async (org: string) =>
        (await h.call("GET", `/o/${org}/epoch`)).body.currentEpoch as number;
      const before = { a: await epochOf(a), b: await epochOf(b) };
      // Both orgs' epochs fell due a minute ago, as a tick on another replica
      // would find them. The shared tick runs each, the unserved chain org
      // passed over without stopping the rest.
      const past = new Date(Date.now() - 60_000).toISOString();
      for (const org of [a, b, chain]) {
        assert.ok(await h.directory.setEpoch(org, { nextAt: past, dueAt: past }));
      }
      await h.host.onEpoch();
      assert.equal(await epochOf(a), before.a + 1);
      assert.equal(await epochOf(b), before.b + 1);
      // Each moved on to its next period, so the next tick runs nothing twice.
      for (const org of [a, b]) {
        const row = await h.directory.get(org);
        assert.ok(Date.parse(row!.epochNextAt!) > Date.now(), "the due time moved on");
      }
      await h.host.onEpoch();
      await h.host.onFlowCron();
      assert.equal(await epochOf(a), before.a + 1);
      assert.equal(await epochOf(b), before.b + 1);
      assert.equal((await h.directory.get(chain))!.epochNextAt, past);
      // A queued tick names no org, and a webhook job for no org is dropped.
      assert.equal(await h.host.onTick(), undefined);
      assert.equal(await h.host.onWebhook({ triggerId: "x" }), undefined);
      assert.equal(await h.host.onWebhook({ orgId: `gone-${tag()}`, triggerId: "x" }), undefined);
    } finally {
      await h.close();
    }
  });
});

describe("multi-org host: each org's epoch cadence", () => {
  /** A funded org with one worker on a grant, so an epoch has something to stream. */
  async function staffed(h: Harness, prefix: string): Promise<string> {
    const org = await register(h, prefix);
    ok(await h.call("POST", `/o/${org}/sandbox/fund`, { body: { amount: USDC(5000) } }), "fund");
    const hire = await govern(h, org, "/governance/propose-hire", { label: "worker" });
    await govern(h, org, "/governance/propose-set-grant", {
      account: hire.account,
      amount: USDC(50),
    });
    return org;
  }
  const epochOf = async (h: Harness, org: string) =>
    (await h.call("GET", `/o/${org}/epoch`)).body.currentEpoch as number;
  const cadenceOf = async (h: Harness, org: string) =>
    (await h.call("GET", `/o/${org}/sandbox`)).body.epoch as Json;
  const advance = async (h: Harness, org: string, seconds: number) => {
    const res = await h.call("POST", `/o/${org}/sandbox/time/advance`, { body: { seconds } });
    ok(res, "advance");
    return res.body;
  };

  it("gives an org the operator's default until it sets its own, and says which it is", async () => {
    const h = await harness({ env: { EPOCH_CRON: "0 0 * * *" } });
    try {
      const org = await register(h, "cad-default");
      const first = await cadenceOf(h, org);
      assert.equal(first.schedule, "0 0 * * *");
      assert.equal(first.source, "default");
      assert.equal(first.clock, "org");
      assert.ok(first.nextAt > Date.now() / 1000);
      assert.equal(first.nextAtIso, new Date(first.nextAt * 1000).toISOString());
      assert.ok(first.secondsUntilNext > 0 && first.secondsUntilNext <= 86_400);

      const set = await h.call("POST", `/o/${org}/epoch/schedule`, { body: { cron: "0 * * * *" } });
      ok(set, "schedule");
      assert.equal(set.body.schedule, "0 * * * *");
      assert.equal(set.body.cadence.source, "org");
      assert.ok(set.body.cadence.secondsUntilNext <= 3600);

      // The same answer wherever it is read.
      const health = (await h.call("GET", `/o/${org}/health`)).body;
      assert.equal(health.epoch.schedule, "0 * * * *");
      assert.equal(health.epoch.nextAt, set.body.cadence.nextAt);
      const read = (await h.call("GET", `/o/${org}/epoch`)).body;
      assert.equal(read.schedule, "0 * * * *");
      assert.equal(read.cadence.nextAt, set.body.cadence.nextAt);
      const listed = (await h.call("GET", `/orgs/${org}`)).body;
      assert.deepEqual(listed.epoch, {
        schedule: "0 * * * *",
        nextAtIso: set.body.cadence.nextAtIso,
      });

      const back = await h.call("POST", `/o/${org}/epoch/schedule`, { body: { cron: null } });
      ok(back, "back to default");
      assert.equal(back.body.cadence.source, "default");
      assert.equal(back.body.schedule, "0 0 * * *");
    } finally {
      await h.close();
    }
  });

  it("refuses a cron that does not parse or never fires", async () => {
    const h = await harness();
    try {
      const org = await register(h, "cad-bad");
      for (const cron of ["every day", "0 0 31 2 *", "", 5]) {
        const res = await h.call("POST", `/o/${org}/epoch/schedule`, { body: { cron } });
        assert.equal(res.status, 400, `${JSON.stringify(cron)}: ${res.text}`);
        assert.equal(res.body.error, "invalid_cron");
      }
      assert.equal((await cadenceOf(h, org)).source, "default");
    } finally {
      await h.close();
    }
  });

  it("runs two orgs on different cadences, each when its own clock reaches its own epoch", async () => {
    const h = await harness();
    try {
      const hourly = await staffed(h, "cad-hourly");
      const monthly = await staffed(h, "cad-monthly");
      ok(
        await h.call("POST", `/o/${hourly}/epoch/schedule`, { body: { cron: "0 * * * *" } }),
        "hourly",
      );
      ok(
        await h.call("POST", `/o/${monthly}/epoch/schedule`, { body: { cron: "0 0 1 * *" } }),
        "monthly",
      );
      const before = { hourly: await epochOf(h, hourly), monthly: await epochOf(h, monthly) };

      // Skip the hourly org to its next pay period: its epoch runs before the answer.
      const skip = (await cadenceOf(h, hourly)).secondsUntilNext as number;
      const skipped = await advance(h, hourly, skip + 1);
      assert.equal(skipped.epochRan, true);
      assert.equal(await epochOf(h, hourly), before.hourly + 1);
      assert.ok(skipped.epoch.secondsUntilNext <= 3600, "the next one is within the hour");
      assert.ok(skipped.epoch.nextAt > skipped.clock.now);
      // Its neighbour's clock and epoch did not move.
      assert.equal(await epochOf(h, monthly), before.monthly);

      // The monthly org moved the same distance is not due, unless the month turned.
      const untilMonthly = (await cadenceOf(h, monthly)).secondsUntilNext as number;
      if (untilMonthly > skip + 120) {
        const short = await advance(h, monthly, skip + 1);
        assert.equal(short.epochRan, false);
        assert.equal(await epochOf(h, monthly), before.monthly);
        assert.equal(short.epoch.nextAt, (await cadenceOf(h, monthly)).nextAt);
      }
      // The shared tick finds neither due, however often it fires.
      await h.host.onEpoch();
      await h.host.onFlowCron();
      assert.equal(await epochOf(h, hourly), before.hourly + 1);
      assert.equal(await epochOf(h, monthly), before.monthly);

      // Skipped to its own pay period, the monthly org runs, and only it.
      const rest = (await cadenceOf(h, monthly)).secondsUntilNext as number;
      const ran = await advance(h, monthly, rest + 1);
      assert.equal(ran.epochRan, true);
      assert.equal(await epochOf(h, monthly), before.monthly + 1);
      assert.equal(await epochOf(h, hourly), before.hourly + 1);
    } finally {
      await h.close();
    }
  });

  it("runs a due epoch on the tick, for an org it had let go, and passes over the others", async () => {
    const h = await harness({ idleMs: 60_000 });
    try {
      const due = await staffed(h, "cad-due");
      const ahead = await staffed(h, "cad-ahead");
      const before = { due: await epochOf(h, due), ahead: await epochOf(h, ahead) };
      await cadenceOf(h, ahead);

      // Both idle past the limit and let go; then one falls due.
      h.clock.now += 61_000;
      assert.deepEqual((await h.host.evictIdle()).sort(), [due, ahead].sort());
      const past = new Date(Date.now() - 60_000).toISOString();
      assert.ok(await h.directory.setEpoch(due, { nextAt: past, dueAt: past }));

      await h.host.onFlowCron();
      // The tick loaded the org whose epoch was due, and no other.
      assert.deepEqual(h.host.loaded(), [due]);
      assert.equal(await epochOf(h, due), before.due + 1);
      assert.equal(await epochOf(h, ahead), before.ahead);
    } finally {
      await h.close();
    }
  });

  it("works the next epoch out again from wall time when the sandbox is reset", async () => {
    const h = await harness();
    try {
      const org = await register(h, "cad-reset");
      ok(
        await h.call("POST", `/o/${org}/epoch/schedule`, { body: { cron: "0 * * * *" } }),
        "hourly",
      );
      await advance(h, org, 40 * 86_400);
      assert.ok((await cadenceOf(h, org)).nextAt > Date.now() / 1000 + 39 * 86_400);
      const reset = await h.call("POST", `/o/${org}/sandbox/reset`, { body: {} });
      ok(reset, "reset");
      assert.ok(reset.body.epoch.nextAt <= Date.now() / 1000 + 3600);
      assert.equal(reset.body.epoch.schedule, "0 * * * *");
    } finally {
      await h.close();
    }
  });
});

describe("multi-org host: idle worlds", () => {
  it("lets an idle org go and rebuilds it from the store, state and trail intact", async () => {
    const h = await harness({ idleMs: 60_000 });
    try {
      const a = await register(h, "idle-a");
      const b = await register(h, "idle-b");
      ok(await h.call("POST", `/o/${a}/sandbox/fund`, { body: { amount: USDC(42) } }), "fund a");
      ok(
        await h.call("POST", `/o/${a}/sandbox/time/advance`, { body: { seconds: 3600 } }),
        "advance a",
      );
      const quiet = flow(`quiet-${tag()}`, "Quiet").model("s", { prompt: "x" }).build();
      ok(await h.call("POST", `/o/${a}/flows`, { body: { flow: quiet } }), "save flow a");
      // Org B has a cron flow: the minute sweep needs its world every minute.
      const nightly = flow(`nightly-${tag()}`, "Nightly").model("s", { prompt: "x" }).build();
      ok(
        await h.call("POST", `/o/${b}/flows`, {
          body: { flow: { ...nightly, trigger: "cron", schedule: "0 0 1 1 *" } },
        }),
        "save cron flow b",
      );
      const stateBefore = (await h.call("GET", `/o/${a}/sandbox`)).body;
      const trailBefore = (await h.call("GET", `/o/${a}/audit`)).body.events as Json[];
      assert.deepEqual(trailBefore.map((event) => event.type).sort(), [
        "FlowSaved",
        "SandboxFunded",
        "SandboxTimeAdvanced",
        "TreasuryDeposit",
      ]);
      // A shared database may hold other orgs; only this test's are looked at.
      const mine = (orgs: string[]) => orgs.filter((org) => org === a || org === b).sort();
      assert.deepEqual(mine(h.host.loaded()), [a, b].sort());

      // Not idle yet: nothing goes.
      h.clock.now += 59_000;
      assert.deepEqual(mine(await h.host.evictIdle()), []);
      // Idle: the org with nothing scheduled goes, the one with a cron flow stays.
      h.clock.now += 2_000;
      assert.deepEqual(mine(await h.host.evictIdle()), [a]);
      assert.deepEqual(mine(h.host.loaded()), [b]);
      assert.equal((await h.call("GET", `/orgs/${a}`)).body.loaded, false);

      // The minute sweep does not wake an org it let go with nothing to do;
      // the epoch is every org's, and does.
      await h.host.onFlowCron();
      assert.deepEqual(mine(h.host.loaded()), [b]);

      // Addressed again: rebuilt from the store, exactly where it was.
      const stateAfter = (await h.call("GET", `/o/${a}/sandbox`)).body;
      assert.ok(h.host.loaded().includes(a));
      assert.equal(stateAfter.version, stateBefore.version);
      assert.equal(stateAfter.clock.offsetSeconds, 3600);
      assert.deepEqual(stateAfter.treasury, stateBefore.treasury);
      assert.equal(stateAfter.root, stateBefore.root);
      // The simulator's own events came back with the rest of the trail.
      const trailAfter = (await h.call("GET", `/o/${a}/audit`)).body.events as Json[];
      assert.deepEqual(
        trailAfter.map((event) => [event.type, event.payload.simTxId ?? null]).sort(),
        trailBefore.map((event) => [event.type, event.payload.simTxId ?? null]).sort(),
      );
      const deposit = trailAfter.find((event) => event.type === "TreasuryDeposit");
      assert.equal(deposit?.payload.amount, USDC(42));
      assert.equal(deposit?.ledger, "sandbox");
      if (PG) {
        // With a database everything else an org configured is read back too.
        assert.ok((await h.call("GET", `/o/${a}/flows`)).text.includes(quiet.id));
      }
      // And it carries on from there.
      ok(
        await h.call("POST", `/o/${a}/sandbox/fund`, { body: { amount: USDC(1) } }),
        "fund after reload",
      );
      assert.equal((await h.call("GET", `/o/${a}/sandbox`)).body.treasury.total, USDC(43));
    } finally {
      await h.close();
    }
  });

  it("never lets a world go when idleMs is 0", async () => {
    const h = await harness({ idleMs: 0 });
    try {
      const a = await register(h, "keep");
      ok(await h.call("GET", `/o/${a}/sandbox`), "load");
      h.clock.now += 365 * 24 * 60 * 60_000;
      assert.deepEqual(await h.host.evictIdle(), []);
      assert.ok(h.host.loaded().includes(a));
    } finally {
      await h.close();
    }
  });

  it("removes an org's rows with the org and leaves its neighbour's", async () => {
    const h = await harness();
    try {
      const a = await register(h, "gone-a");
      const b = await register(h, "gone-b");
      for (const org of [a, b]) {
        ok(await h.call("POST", `/o/${org}/sandbox/fund`, { body: { amount: USDC(9) } }), "fund");
      }
      assert.equal((await h.call("DELETE", `/orgs/${a}`)).status, 200);
      assert.equal((await h.call("GET", `/o/${a}/sandbox`)).status, 404);
      assert.equal((await h.call("GET", `/o/${b}/sandbox`)).body.treasury.total, USDC(9));
      if (PG) {
        // Registered again under the same name: a new org, with nothing of the old one.
        await h.call("PUT", `/orgs/${a}`, { body: { mode: "sandbox" } });
        const fresh = await h.call("GET", `/o/${a}/sandbox`);
        assert.equal(fresh.body.treasury.total, "0");
        assert.equal(fresh.body.version, 1);
        assert.deepEqual((await h.call("GET", `/o/${a}/audit`)).body.events, []);
      }
    } finally {
      await h.close();
    }
  });
});
