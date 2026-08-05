import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  applyCrewRoleIds,
  crewBindingConflicts,
  crewBindingKey,
  crewBindingRoles,
  crewBindingScope,
  normalizeCrewBinding,
  type CrewRoleBinding,
} from "./crewBindings.js";
import { getCrewBlueprint } from "./crewBlueprints.js";
import { resolveCrewSeats } from "./crewSeats.js";

const AT = "2026-08-05T10:00:00.000Z";
const A = "0x00000000000000000000000000000000000000aa";
const B = "0x00000000000000000000000000000000000000bb";

const binding = (over: Partial<CrewRoleBinding> = {}): CrewRoleBinding => ({
  roleId: "reviewer",
  account: A,
  at: AT,
  ...over,
});

describe("crew binding identity", () => {
  it("prefers a crew id over a blueprint id, and falls back to the workspace", () => {
    assert.equal(
      crewBindingScope({ crewId: "Crew-1", blueprintId: "github-experts" }),
      "crew:crew-1",
    );
    assert.equal(crewBindingScope({ blueprintId: "GitHub-Experts" }), "blueprint:github-experts");
    assert.equal(crewBindingScope({}), "workspace");
  });

  /*
    Two crews installed from one blueprint each have a `reviewer`. Flattening
    them onto one key would let the second install silently re-point the first
    crew's seat — and a flow would then run as the wrong principal under the
    wrong policy stack.
  */
  it("keeps two crews' same-named seats apart", () => {
    const one = crewBindingKey({ roleId: "reviewer", crewId: "crew-a" });
    const two = crewBindingKey({ roleId: "reviewer", crewId: "crew-b" });
    assert.notEqual(one, two);
  });
});

describe("normalizeCrewBinding", () => {
  it("lowercases the account and keeps the optional provenance", () => {
    const record = normalizeCrewBinding(
      {
        roleId: " reviewer ",
        account: A.toUpperCase().replace("0X", "0x"),
        label: " PR gatekeeper ",
        blueprintId: "github-experts",
      },
      AT,
    );
    assert.equal(record.roleId, "reviewer");
    assert.equal(record.account, A);
    assert.equal(record.label, "PR gatekeeper");
    assert.equal(record.blueprintId, "github-experts");
  });

  /*
    Refused rather than stored: this map is read back into the address a flow
    runs as, so a stored typo binds a run to nothing — or to a plausible wrong
    principal, which is worse.
  */
  it("refuses a role with no id and an account that is not an address", () => {
    assert.throws(() => normalizeCrewBinding({ roleId: " ", account: A }, AT), /role_required/);
    assert.throws(
      () => normalizeCrewBinding({ roleId: "reviewer", account: "not-an-address" }, AT),
      /account_invalid/,
    );
    assert.throws(
      () => normalizeCrewBinding({ roleId: "reviewer", account: "" }, AT),
      /account_invalid/,
    );
  });
});

describe("crewBindingRoles", () => {
  it("returns only the asked-for scope, in the shape bindCrewFlow takes", () => {
    const bindings = [
      binding({ crewId: "crew-a" }),
      binding({ roleId: "merger", account: B, crewId: "crew-b" }),
    ];
    assert.deepEqual(crewBindingRoles(bindings, { crewId: "crew-a" }), { reviewer: A });
    assert.deepEqual(crewBindingRoles(bindings, { crewId: "crew-b" }), { merger: B });
    assert.deepEqual(crewBindingRoles(bindings), { reviewer: A, merger: B });
  });
});

describe("applyCrewRoleIds", () => {
  it("adds a role id to the node that holds the account and touches nothing else", () => {
    const nodes = [
      { account: A.toUpperCase().replace("0X", "0x"), label: "PR gatekeeper", kind: "WorkerAgent" },
      { account: B, label: "Merger", kind: "WorkerAgent" },
    ];
    const out = applyCrewRoleIds(nodes, [binding()]);
    assert.equal((out[0] as { roleId?: string }).roleId, "reviewer");
    assert.equal(out[0]?.label, "PR gatekeeper");
    assert.equal((out[1] as { roleId?: string }).roleId, undefined);
  });

  /*
    A node that already carries an id keeps it: whatever put it there — an
    operator's `--bind` on this very command — knew something the stored list
    does not.
  */
  it("never overwrites a role id the node arrived with", () => {
    const nodes = [{ account: A, roleId: "merger" }];
    assert.equal(applyCrewRoleIds(nodes, [binding()])[0]?.roleId, "merger");
  });

  it("returns the nodes unchanged when nothing is bound", () => {
    const nodes = [{ account: A }];
    assert.deepEqual(applyCrewRoleIds(nodes, []), nodes);
  });
});

describe("a persisted binding survives the rename that breaks a label", () => {
  /*
    The whole point, end to end: the blueprint's own seats, one of them renamed
    after the hire landed, resolved through the stored id rather than the string
    a human typed.
  */
  it("binds a renamed seat and reports it as renamed", () => {
    const bp = getCrewBlueprint("github-experts")!;
    const nodes = bp.roles.map((role, i) => ({
      account: `0x${String(i + 1).padStart(40, "0")}`,
      kind: role.kind === "manager_agent" ? "ManagerAgent" : "WorkerAgent",
      label: role.id === "reviewer" ? "PR gatekeeper" : role.label,
    }));
    const reviewer = nodes[bp.roles.findIndex((r) => r.id === "reviewer")]!;

    const blind = resolveCrewSeats(bp, nodes);
    assert.ok(blind.missing.includes("reviewer"), "without an id the rename loses the seat");

    const bound = resolveCrewSeats(
      bp,
      applyCrewRoleIds(nodes, [
        binding({ roleId: "reviewer", account: reviewer.account, blueprintId: bp.id }),
      ]),
    );
    assert.equal(bound.roles.reviewer, reviewer.account);
    assert.ok(bound.renamed.some((b) => b.role === "reviewer"));
    assert.deepEqual(bound.missing, []);
  });
});

describe("crewBindingConflicts", () => {
  /*
    Two stores holding one mapping is a drift risk, not redundancy: the one that
    is wrong binds a flow to the wrong principal, and silence says nothing about
    which one that is.
  */
  it("names only the roles both sides claim and disagree about", () => {
    const conflicts = crewBindingConflicts(
      { reviewer: A, merger: B, watcher: A },
      { reviewer: B, merger: B.toUpperCase().replace("0X", "0x") },
    );
    assert.deepEqual(conflicts, [{ roleId: "reviewer", ours: A, theirs: B }]);
  });

  it("finds nothing when one side has never recorded a seat", () => {
    assert.deepEqual(crewBindingConflicts({ reviewer: A }, {}), []);
  });
});
