import { strict as assert } from "node:assert";
import { test } from "node:test";
import { getCrewBlueprint } from "./crewBlueprints.js";
import { resolveCrewSeats, seatRoleMap, type CrewSeatNode } from "./crewSeats.js";

const bp = getCrewBlueprint("github-experts")!;

/** One node per blueprint seat, named exactly as the blueprint names it. */
function asInstalled(over: Partial<Record<string, Partial<CrewSeatNode>>> = {}): CrewSeatNode[] {
  return [
    { account: "0xr00t", label: "Maintainer (you)", kind: "HumanRoot" },
    ...bp.roles.map((role, i) => ({
      account: `0xseat${i}`,
      label: role.label,
      kind: role.kind === "manager_agent" ? "ManagerAgent" : "WorkerAgent",
      roleId: role.id,
      ...(over[role.id] ?? {}),
    })),
  ];
}

test("binds every seat by its persisted role id", () => {
  const out = resolveCrewSeats(bp, asInstalled());
  assert.deepEqual(out.missing, []);
  assert.deepEqual(out.ambiguous, []);
  assert.equal(out.bindings.length, bp.roles.length);
  assert.ok(out.bindings.every((b) => b.boundBy === "role-id"));
  assert.equal(out.roles.root, "0xr00t");
  assert.deepEqual(out.renamed, []);
});

/*
  The case the label match cannot survive, and the reason role ids are stored:
  a seat renamed after install is the same principal under the same policy
  stack, and a checklist that reported it missing would send an operator to
  re-hire an agent that is sitting right there.
*/
test("a renamed seat still binds, and says the label no longer matches", () => {
  const nodes = asInstalled({ "review-lead": { label: "PR gatekeeper" } });
  const out = resolveCrewSeats(bp, nodes);
  assert.deepEqual(out.missing, []);
  assert.equal(out.roles["review-lead"], seatAccount("review-lead"));
  assert.deepEqual(
    out.renamed.map((b) => b.role),
    ["review-lead"],
  );
});

test("falls back to the label when nothing persisted a role id", () => {
  const nodes = asInstalled().map(({ roleId: _drop, ...rest }) => rest);
  const out = resolveCrewSeats(bp, nodes);
  assert.deepEqual(out.missing, []);
  assert.ok(out.bindings.every((b) => b.boundBy === "label"));
});

test("a renamed seat with no persisted role id is reported missing, never guessed", () => {
  const nodes = asInstalled()
    .map(({ roleId: _drop, ...rest }) => rest)
    .map((n) => (n.label === "Review lead" ? { ...n, label: "PR gatekeeper" } : n));
  const out = resolveCrewSeats(bp, nodes);
  assert.deepEqual(out.missing, ["review-lead"]);
  assert.equal(out.roles["review-lead"], undefined);
});

/*
  Two seats sharing a label is the case where a first-match wins rule binds a
  flow to whichever node happened to be listed first. Unbound stops the install
  and names the seat; wrong runs the flow as the wrong principal.
*/
test("an ambiguous label binds nothing", () => {
  const nodes = asInstalled()
    .map(({ roleId: _drop, ...rest }) => rest)
    .concat([{ account: "0xdupe", label: "Review lead", kind: "WorkerAgent" }]);
  const out = resolveCrewSeats(bp, nodes);
  assert.deepEqual(out.ambiguous, ["review-lead"]);
  assert.ok(out.missing.includes("review-lead"));
  assert.equal(out.roles["review-lead"], undefined);
});

test("one account cannot answer for two seats", () => {
  const shared = bp.roles.map((role) => ({
    account: "0xsame",
    label: role.label,
    kind: "WorkerAgent",
  }));
  const out = resolveCrewSeats(bp, shared);
  assert.equal(Object.values(out.roles).filter((a) => a === "0xsame").length, 1);
  assert.equal(out.missing.length, bp.roles.length - 1);
});

test("seats with no account at all are missing, not bound to nothing", () => {
  const pending = bp.roles.map((role) => ({ label: role.label, roleId: role.id }));
  const out = resolveCrewSeats(bp, pending);
  assert.deepEqual(out.roles, {});
  assert.deepEqual(out.missing, bp.roles.map((r) => r.id).sort());
});

test("seatRoleMap is what a surface should persist", () => {
  const out = resolveCrewSeats(bp, asInstalled());
  const map = seatRoleMap(out);
  assert.equal(Object.keys(map).length, bp.roles.length);
  assert.equal(map["review-lead"], seatAccount("review-lead"));
  // The root is not a blueprint seat, so it is not part of what gets stored.
  assert.equal(map.root, undefined);
});

function seatAccount(roleId: string): string {
  return `0xseat${bp.roles.findIndex((r) => r.id === roleId)}`;
}
