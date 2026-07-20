import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { OrgNode } from "@lacrew/core";
import type { FlowDefinition } from "@lacrew/flows";
import {
  ancestorsOf,
  ceilingAgent,
  scopeOf,
  subtreeOf,
  visibleTo,
  worstVerdict,
} from "./flowScope.js";

const ROOT = "0x0000000000000000000000000000000000000001";
const MANAGER = "0x0000000000000000000000000000000000000002";
const WORKER_A = "0x0000000000000000000000000000000000000003";
const WORKER_B = "0x0000000000000000000000000000000000000004";
/** Reports to root directly, so it sits outside the manager's team. */
const OUTSIDER = "0x0000000000000000000000000000000000000005";

const node = (account: string, parent: string | null): OrgNode =>
  ({
    account,
    parent,
    kind: parent === null ? "human_root" : "worker_agent",
    active: true,
  }) as OrgNode;

const TREE: OrgNode[] = [
  node(ROOT, null),
  node(MANAGER, ROOT),
  node(WORKER_A, MANAGER),
  node(WORKER_B, MANAGER),
  node(OUTSIDER, ROOT),
];

const withScope = (scope?: FlowDefinition["scope"]): FlowDefinition => ({
  id: "f",
  name: "F",
  ...(scope ? { scope } : {}),
  steps: [{ id: "s", kind: "model", prompt: "hi", next: null }],
});

describe("flow scope", () => {
  it("treats a flow without a scope as org-wide", () => {
    const def = withScope();
    assert.deepEqual(scopeOf(def), { level: "org" });
    assert.equal(ceilingAgent(def), undefined);
    for (const n of TREE) assert.ok(visibleTo(def, n.account, TREE));
  });

  it("scopes a team flow to the subtree, not to siblings", () => {
    const def = withScope({ level: "team", ref: MANAGER });
    assert.ok(visibleTo(def, MANAGER, TREE));
    assert.ok(visibleTo(def, WORKER_A, TREE));
    assert.ok(visibleTo(def, WORKER_B, TREE));
    // The outsider reports to root, so the manager's team flow is not theirs.
    assert.equal(visibleTo(def, OUTSIDER, TREE), false);
    // Root is above the team, not inside it.
    assert.equal(visibleTo(def, ROOT, TREE), false);
    assert.equal(ceilingAgent(def), MANAGER);
  });

  it("scopes an agent flow to that agent and its managers", () => {
    const def = withScope({ level: "agent", ref: WORKER_A });
    assert.ok(visibleTo(def, WORKER_A, TREE));
    // Managers up the reporting line may inspect and run it.
    assert.ok(visibleTo(def, MANAGER, TREE));
    assert.ok(visibleTo(def, ROOT, TREE));
    // A peer under the same manager may not.
    assert.equal(visibleTo(def, WORKER_B, TREE), false);
    assert.equal(visibleTo(def, OUTSIDER, TREE), false);
  });

  it("falls open when the org chart is unavailable", () => {
    // Mock/detached mode cannot resolve the chart, so scoping is not evaluated.
    const def = withScope({ level: "team", ref: MANAGER });
    assert.ok(visibleTo(def, OUTSIDER, []));
  });

  it("matches addresses case-insensitively", () => {
    const def = withScope({ level: "agent", ref: WORKER_A.toUpperCase() });
    assert.ok(visibleTo(def, WORKER_A, TREE));
  });

  it("subtreeOf and ancestorsOf walk the chart in both directions", () => {
    assert.deepEqual([...subtreeOf(TREE, MANAGER)].sort(), [MANAGER, WORKER_A, WORKER_B].sort());
    assert.deepEqual([...ancestorsOf(TREE, WORKER_A)].sort(), [MANAGER, ROOT].sort());
    assert.deepEqual([...ancestorsOf(TREE, ROOT)], []);
  });

  it("takes the stricter of two verdicts", () => {
    assert.equal(worstVerdict("ALLOW", "ESCALATE"), "ESCALATE");
    assert.equal(worstVerdict("ESCALATE", "ALLOW"), "ESCALATE");
    assert.equal(worstVerdict("ESCALATE", "DENY"), "DENY");
    assert.equal(worstVerdict("DENY", "ALLOW"), "DENY");
    assert.equal(worstVerdict("ALLOW", "ALLOW"), "ALLOW");
  });
});
