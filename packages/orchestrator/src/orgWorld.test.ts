/**
 * `createOrgWorld`: one org's surfaces, app and scheduled work, built from its
 * runtime and its own environment.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MemoryModelProvider } from "./model/index.js";
import { createOrgWorld, type OrgWorldShared } from "./orgWorld.js";
import { InMemoryQueue } from "./queue/index.js";
import { createSandboxRuntime } from "./runtime.js";

type Json = Record<string, any>;

function shared(overrides: Partial<OrgWorldShared> = {}): OrgWorldShared {
  return {
    queue: new InMemoryQueue(),
    model: new MemoryModelProvider(),
    mcpUseMock: false,
    isDbReady: () => false,
    isDbConfigured: () => false,
    ...overrides,
  };
}

async function get(
  app: { request: (path: string, init?: RequestInit) => Response | Promise<Response> },
  path: string,
  token?: string,
) {
  const res = await app.request(
    path,
    token ? { headers: { authorization: `Bearer ${token}` } } : {},
  );
  return { status: res.status, body: (await res.json()) as Json };
}

describe("createOrgWorld", () => {
  it("serves the org's runtime and answers for its scheduled work", async () => {
    const runtime = createSandboxRuntime();
    await runtime.hydrateSandbox();
    const world = await createOrgWorld("default", { runtime, env: {} }, shared());
    try {
      assert.equal(world.orgId, "default");
      assert.equal(world.runtime, runtime);
      const health = await get(world.app, "/health");
      assert.equal(health.status, 200);
      assert.equal(health.body.mode, "sandbox");
      assert.equal(health.body.ledger, "sandbox");
      assert.equal((await get(world.app, "/org")).body.nodes.length, 1, "the genesis root");

      // The minute sweep runs with nothing due and nothing configured.
      await world.onFlowCron();
      // A scheduled epoch never throws into the queue, whatever the ledger says.
      await world.onEpoch();
    } finally {
      await world.close();
    }
  });

  it("requires the shared bearer token when one is set", async () => {
    const runtime = createSandboxRuntime();
    const world = await createOrgWorld(
      "default",
      { runtime, env: {} },
      shared({ authToken: "t0ken" }),
    );
    try {
      assert.equal((await get(world.app, "/org")).status, 401);
      assert.equal((await get(world.app, "/org", "t0ken")).status, 200);
      assert.equal((await get(world.app, "/health")).status, 200, "health stays open");
    } finally {
      await world.close();
    }
  });

  it("reads the org's own settings from the environment it is given", async () => {
    const runtime = createSandboxRuntime();
    const env = {
      LACREW_CONNECTORS: JSON.stringify([
        {
          id: "notes",
          baseUrl: "https://notes.example",
          routes: [{ name: "list", method: "GET", path: "/notes", effect: "read" }],
        },
      ]),
    };
    const configured = await createOrgWorld("default", { runtime, env }, shared());
    const bare = await createOrgWorld("default", { runtime, env: {} }, shared());
    try {
      const names = (body: Json) => (body.connectors as Json[]).map((c) => c.id);
      assert.deepEqual(names((await get(configured.app, "/connectors")).body), ["notes"]);
      assert.deepEqual(names((await get(bare.app, "/connectors")).body), []);
    } finally {
      await configured.close();
      await bare.close();
    }
  });

  it("refuses a runtime bound to another org", async () => {
    const runtime = createSandboxRuntime({ orgId: "acme" });
    await assert.rejects(
      createOrgWorld("globex", { runtime, env: {} }, shared()),
      /handed a runtime bound to "acme"/,
    );
  });
});
