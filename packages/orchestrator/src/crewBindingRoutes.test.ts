/**
 * The operator surface over blueprint seat bindings (F2.25): what a `PUT`
 * records, what `GET` serves back, and — the part that actually matters — that
 * `/org` carries the role id afterwards, since that is the read every seat
 * resolution goes through.
 *
 * Driven through the real app and the real surface: the claim is behavioural,
 * and stubbing the surface would assert the wiring rather than the record.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createLacrewClient } from "@lacrew/sdk/testing";
import type { McpToolBackend } from "@lacrew/adapter-agents-mcp";
import { createFlowsSurface } from "./flows.js";
import { createMemoryFlowStore } from "./flowStore.js";
import { createOrchestratorApp } from "./httpApp.js";
import { MemoryModelProvider } from "./model/index.js";
import { InMemoryQueue } from "./queue/index.js";
import { createCrewBindings } from "./crewBindings.js";
import { CrewRuntime } from "./runtime.js";

function harness(opts: { bindings?: boolean } = {}) {
  const runtime = new CrewRuntime({ client: createLacrewClient({ useMock: true }) });
  const crewBindings = createCrewBindings({ onEvent: (event) => runtime.recordAudit(event) });
  const model = new MemoryModelProvider();
  const app = createOrchestratorApp({
    runtime,
    queue: new InMemoryQueue(),
    model,
    flows: createFlowsSurface({
      runtime,
      model,
      mcpBackend: {} as McpToolBackend,
      store: createMemoryFlowStore(),
    }),
    ...(opts.bindings === false ? {} : { crewBindings }),
    mcpUseMock: true,
    isDbReady: () => false,
    isDbConfigured: () => false,
  });
  return { app, runtime, crewBindings };
}

const put = (body: Record<string, unknown>) =>
  new Request("http://x/crew/bindings", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

type BindingsBody = {
  bindings: Array<{ roleId: string; account: string; label?: string }>;
  roles: Record<string, string>;
  cleared?: string[];
  error?: string;
};

/** The mock client's own chart — whatever accounts it hands out. */
async function accounts(h: ReturnType<typeof harness>): Promise<string[]> {
  const nodes = (await h.runtime.getClient().getOrgTree()) as Array<{ account: string }>;
  return nodes.map((n) => n.account);
}

describe("crew binding routes", () => {
  it("records a seat and serves it back for the scope that asked", async () => {
    const h = harness();
    const written = (await (
      await h.app.request(
        put({
          blueprintId: "github-experts",
          roles: { reviewer: "0x00000000000000000000000000000000000000aa" },
          labels: { reviewer: "PR gatekeeper" },
        }),
      )
    ).json()) as BindingsBody;
    assert.deepEqual(written.roles, { reviewer: "0x00000000000000000000000000000000000000aa" });
    assert.equal(written.bindings[0]?.label, "PR gatekeeper");

    const read = (await (
      await h.app.request("/crew/bindings?blueprint=github-experts")
    ).json()) as BindingsBody;
    assert.deepEqual(read.roles, { reviewer: "0x00000000000000000000000000000000000000aa" });

    // Another crew's scope is a different set, not a filter over one list.
    const other = (await (
      await h.app.request("/crew/bindings?crew=crew-9")
    ).json()) as BindingsBody;
    assert.deepEqual(other.bindings, []);
  });

  /*
    The read every seat resolution goes through. A binding that is stored and
    not served here would be a record nothing consults.
  */
  it("carries the role id onto the org chart it serves", async () => {
    const h = harness();
    const [first] = await accounts(h);
    await h.app.request(put({ blueprintId: "github-experts", roles: { reviewer: first! } }));

    const org = (await (await h.app.request("/org")).json()) as {
      nodes: Array<{ account: string; roleId?: string }>;
    };
    const bound = org.nodes.find((n) => n.account.toLowerCase() === first!.toLowerCase());
    assert.equal(bound?.roleId, "reviewer");
    assert.ok(
      org.nodes.some((n) => n.account.toLowerCase() !== first!.toLowerCase() && !n.roleId),
      "a node nothing bound is served exactly as it arrived",
    );
  });

  it("merges a second pass rather than erasing the first one's seats", async () => {
    const h = harness();
    await h.app.request(
      put({
        blueprintId: "github-experts",
        roles: { reviewer: "0x00000000000000000000000000000000000000aa" },
      }),
    );
    const merged = (await (
      await h.app.request(
        put({
          blueprintId: "github-experts",
          roles: { merger: "0x00000000000000000000000000000000000000bb" },
        }),
      )
    ).json()) as BindingsBody;

    assert.deepEqual(merged.roles, {
      reviewer: "0x00000000000000000000000000000000000000aa",
      merger: "0x00000000000000000000000000000000000000bb",
    });
  });

  /*
    A blank forgets the seat rather than storing an empty address, so taking a
    wrong binding back out does not need a second verb.
  */
  it("clears one seat on a blank address", async () => {
    const h = harness();
    await h.app.request(
      put({
        blueprintId: "github-experts",
        roles: { reviewer: "0x00000000000000000000000000000000000000aa" },
      }),
    );
    const cleared = (await (
      await h.app.request(put({ blueprintId: "github-experts", roles: { reviewer: "" } }))
    ).json()) as BindingsBody;

    assert.deepEqual(cleared.cleared, ["reviewer"]);
    assert.deepEqual(cleared.roles, {});
  });

  it("refuses a body with no roles map, and an address that is not one", async () => {
    const h = harness();
    const noRoles = await h.app.request(put({ blueprintId: "github-experts" }));
    assert.equal(noRoles.status, 400);
    assert.equal(((await noRoles.json()) as BindingsBody).error, "roles_required");

    const bad = await h.app.request(
      put({ blueprintId: "github-experts", roles: { reviewer: "definitely-not-an-address" } }),
    );
    assert.equal(bad.status, 400);
    assert.match(((await bad.json()) as BindingsBody).error!, /account_invalid/);
  });

  /*
    The bindings written before a bad line stand: discarding seats that were
    named correctly because a later one had a typo would make the operator
    retype the whole map.
  */
  it("keeps the seats it had already accepted when a later one is invalid", async () => {
    const h = harness();
    const res = await h.app.request(
      put({
        blueprintId: "github-experts",
        roles: {
          reviewer: "0x00000000000000000000000000000000000000aa",
          merger: "nope",
        },
      }),
    );
    assert.equal(res.status, 400);
    const body = (await res.json()) as BindingsBody;
    assert.equal(body.bindings.length, 1);
    assert.equal(body.bindings[0]?.roleId, "reviewer");
  });

  it("says the surface is unavailable rather than pretending to store one", async () => {
    const h = harness({ bindings: false });
    const res = await h.app.request("/crew/bindings");
    assert.equal(res.status, 503);
    assert.equal(((await res.json()) as BindingsBody).error, "crew_bindings_unavailable");

    // And the chart is still served — the record is bookkeeping, not a gate.
    assert.equal((await h.app.request("/org")).status, 200);
  });

  it("leaves a row in the trail, because re-pointing a role moves a principal", async () => {
    const h = harness();
    await h.app.request(
      put({
        blueprintId: "github-experts",
        roles: { reviewer: "0x00000000000000000000000000000000000000aa" },
      }),
    );
    const events = await h.runtime.audit();
    assert.ok(events.some((e) => e.type === "CrewBindingChanged"));
  });
});
