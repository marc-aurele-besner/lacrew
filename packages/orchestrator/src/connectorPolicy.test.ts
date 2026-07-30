import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  createConnectorModes,
  resolveWriteMode,
  validateModeRoute,
  type ConnectorModeRule,
} from "./connectorPolicy.js";
import type { ConnectorRoute } from "./connectors.js";

const merge: ConnectorRoute = {
  name: "merge_pull_request",
  method: "PUT",
  path: "/repos/{owner}/{repo}/pulls/{number}/merge",
  effect: "write",
  mode: "ask",
};

const read: ConnectorRoute = {
  name: "get_pull_request",
  method: "GET",
  path: "/repos/{owner}/{repo}/pulls/{number}",
  effect: "read",
};

const WORKER = "0x00000000000000000000000000000000000000a1";
const DESK = "0x00000000000000000000000000000000000000b1";
const DIVISION = "0x00000000000000000000000000000000000000c1";

test("a route with no rule runs at its declared default", () => {
  assert.equal(resolveWriteMode(merge, "github", []).mode, "ask");
  assert.equal(
    resolveWriteMode({ ...merge, mode: undefined }, "github", []).mode,
    "auto",
    "a write that declares nothing is auto — the behaviour connectors had before modes",
  );
});

test("reads carry no mode, whatever a rule says", () => {
  const rules: ConnectorModeRule[] = [
    { scope: { level: "workspace" }, route: "github.get_pull_request", mode: "deny" },
  ];
  const resolved = resolveWriteMode(read, "github", rules);
  assert.equal(resolved.mode, "auto");
  assert.equal(resolved.source.kind, "route-default");
});

test("agent beats crew beats workspace", () => {
  const rules: ConnectorModeRule[] = [
    { scope: { level: "workspace" }, route: "github.*", mode: "deny" },
    { scope: { level: "crew", ref: DESK }, route: "github.*", mode: "ask" },
    { scope: { level: "agent", ref: WORKER }, route: "github.merge_pull_request", mode: "auto" },
  ];
  const subject = { principal: WORKER, managers: [DESK, DIVISION] };
  assert.equal(resolveWriteMode(merge, "github", rules, subject).mode, "auto");

  // Drop the seat's own rule and the desk's applies through the reporting line.
  assert.equal(resolveWriteMode(merge, "github", rules.slice(0, 2), subject).mode, "ask");
  // Drop the desk's and only the workspace rule is left.
  assert.equal(resolveWriteMode(merge, "github", rules.slice(0, 1), subject).mode, "deny");
});

test("the nearest crew in the reporting line wins", () => {
  const rules: ConnectorModeRule[] = [
    { scope: { level: "crew", ref: DIVISION }, route: "github.*", mode: "deny" },
    { scope: { level: "crew", ref: DESK }, route: "github.*", mode: "auto" },
  ];
  // `managers` arrives nearest-first, as `ancestorsOf` walks upward.
  const resolved = resolveWriteMode(merge, "github", rules, {
    principal: WORKER,
    managers: [DESK, DIVISION],
  });
  assert.equal(resolved.mode, "auto");
});

test("an exact route beats a wildcard at the same scope", () => {
  const rules: ConnectorModeRule[] = [
    { scope: { level: "workspace" }, route: "github.*", mode: "auto" },
    { scope: { level: "workspace" }, route: "github.merge_pull_request", mode: "deny" },
  ];
  assert.equal(resolveWriteMode(merge, "github", rules).mode, "deny");
});

test("a rule for another connector does not reach this one", () => {
  const rules: ConnectorModeRule[] = [
    { scope: { level: "workspace" }, route: "gitlab.*", mode: "deny" },
  ];
  assert.equal(resolveWriteMode(merge, "github", rules).mode, "ask");
});

test("route patterns are one route or one connector, never a loose glob", () => {
  assert.equal(validateModeRoute("github.merge_pull_request"), null);
  assert.equal(validateModeRoute("github.*"), null);
  assert.ok(validateModeRoute("*"));
  assert.ok(validateModeRoute("github.merge_*"));
  assert.ok(validateModeRoute("github"));
});

test("setting a rule replaces the previous one for that scope and route", async () => {
  const modes = createConnectorModes({});
  await modes.set({ scope: { level: "workspace" }, route: "github.*", mode: "deny" });
  await modes.set({ scope: { level: "workspace" }, route: "github.*", mode: "ask" });
  assert.equal(modes.list().length, 1);
  assert.equal(modes.resolve(merge, "github").mode, "ask");
});

test("clearing a rule falls back to what the route inherits, not to auto", async () => {
  const modes = createConnectorModes({});
  await modes.set({ scope: { level: "workspace" }, route: "github.*", mode: "auto" });
  assert.equal(modes.resolve(merge, "github").mode, "auto");
  assert.equal(await modes.clear({ level: "workspace" }, "github.*"), true);
  assert.equal(modes.resolve(merge, "github").mode, "ask", "back to the route's own default");
  assert.equal(await modes.clear({ level: "workspace" }, "github.*"), false);
});

test("an unknown mode is refused rather than stored", async () => {
  const modes = createConnectorModes({});
  await assert.rejects(
    () =>
      modes.set({
        scope: { level: "workspace" },
        route: "github.*",
        mode: "maybe" as never,
      }),
    /invalid_connector_mode/,
  );
});

test("rules survive a restart through the store", async () => {
  const rows: Parameters<
    NonNullable<Parameters<typeof createConnectorModes>[0]["store"]>["saveConnectorMode"]
  >[0][] = [];
  const store = {
    loadConnectorModes: async () => rows,
    saveConnectorMode: async (record: (typeof rows)[number]) => {
      rows.push(record);
    },
    removeConnectorMode: async () => {},
  };
  const first = createConnectorModes({ store });
  await first.set({ scope: { level: "workspace" }, route: "github.*", mode: "deny" });

  const second = createConnectorModes({ store });
  assert.equal(await second.hydrate(), 1);
  assert.equal(second.resolve(merge, "github").mode, "deny");
});
