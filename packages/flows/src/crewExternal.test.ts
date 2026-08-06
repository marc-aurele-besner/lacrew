import { strict as assert } from "node:assert";
import { test } from "node:test";
import { getCrewBlueprint } from "./crewBlueprints.js";
import {
  externalSeatCandidates,
  externalSeatRefusal,
  resolveExternalSeats,
  type CrewExternalCandidate,
} from "./crewExternal.js";
import type { CrewBlueprint } from "./crews.js";

const DESK_EXECUTOR = "0x00000000000000000000000000000000000000d1";
const OTHER_EXECUTOR = "0x00000000000000000000000000000000000000d2";

const riskWatch = (): CrewBlueprint => getCrewBlueprint("risk-watch")!;

/** A seat as the orchestrator's binding record serves it. */
function seat(over: Partial<CrewExternalCandidate> = {}): CrewExternalCandidate {
  return {
    roleId: "executor",
    account: DESK_EXECUTOR,
    blueprintId: "defi-desk",
    crewId: "crew-desk",
    label: "Executor",
    ...over,
  };
}

test("risk-watch declares the seat it may halt, and it belongs to another crew", () => {
  const bp = riskWatch();
  const ref = bp.externalSeats?.find((s) => s.id === "desk-executor");
  assert.ok(ref, "risk-watch no longer declares the desk executor");
  assert.equal(ref!.crewBlueprintId, "defi-desk");
  assert.equal(ref!.roleId, "executor");
  // The seat is not one of this crew's own — that is the whole reason the
  // reference exists rather than a `{{crew.*}}` placeholder.
  assert.ok(!bp.roles.some((r) => r.id === ref!.roleId));
});

test("a recorded sibling seat binds the reference", () => {
  const resolved = resolveExternalSeats(riskWatch(), [seat()]);
  assert.deepEqual(resolved.external, { "desk-executor": DESK_EXECUTOR });
  assert.deepEqual(resolved.missing, []);
  assert.deepEqual(resolved.bindings, [
    { ref: "desk-executor", account: DESK_EXECUTOR, crewId: "crew-desk", blueprintId: "defi-desk" },
  ]);
});

test("nothing to bind is unbound, not guessed", () => {
  const bp = riskWatch();
  const resolved = resolveExternalSeats(bp, []);
  assert.deepEqual(resolved.external, {});
  assert.deepEqual(resolved.missing, ["desk-executor"]);
  const refusal = externalSeatRefusal(bp.externalSeats![0]!, resolved);
  assert.match(refusal!, /no executor seat of a defi-desk crew has landed/);
});

test("two candidates bind neither, and the refusal asks which crew", () => {
  const bp = riskWatch();
  const resolved = resolveExternalSeats(bp, [
    seat(),
    seat({ account: OTHER_EXECUTOR, crewId: "crew-desk-2" }),
  ]);
  // Halting one of two live desks at random is worse than halting neither.
  assert.deepEqual(resolved.external, {});
  assert.deepEqual(resolved.ambiguous, ["desk-executor"]);
  assert.deepEqual(resolved.missing, ["desk-executor"]);
  assert.match(externalSeatRefusal(bp.externalSeats![0]!, resolved)!, /name the crew/);
});

test("naming the crew is how an operator resolves the ambiguity", () => {
  const resolved = resolveExternalSeats(
    riskWatch(),
    [seat(), seat({ account: OTHER_EXECUTOR, crewId: "crew-desk-2" })],
    { "desk-executor": "crew-desk-2" },
  );
  assert.deepEqual(resolved.external, { "desk-executor": OTHER_EXECUTOR });
});

test("a choice naming a crew with no such seat binds nothing rather than falling back", () => {
  // The failure this refuses: a pick that has gone stale silently retargeting
  // the halt at whichever desk is left.
  const resolved = resolveExternalSeats(riskWatch(), [seat()], {
    "desk-executor": "crew-that-was-deleted",
  });
  assert.deepEqual(resolved.external, {});
  assert.deepEqual(resolved.missing, ["desk-executor"]);
});

test("a role id that merely collides does not answer for a declared blueprint", () => {
  const bp = riskWatch();
  const foreign = seat({ blueprintId: "yield-desk", crewId: "crew-yield" });
  assert.deepEqual(externalSeatCandidates(bp.externalSeats![0]!, [foreign]), []);
  assert.deepEqual(resolveExternalSeats(bp, [foreign]).missing, ["desk-executor"]);

  // Neither does a seat whose crew nobody recorded: "an executor" is not "the
  // desk's executor", and the reference named a blueprint.
  const anonymous = seat({ blueprintId: undefined });
  assert.deepEqual(resolveExternalSeats(bp, [anonymous]).missing, ["desk-executor"]);
});

test("a seat with no account is not a candidate", () => {
  assert.deepEqual(resolveExternalSeats(riskWatch(), [seat({ account: "" })]).missing, [
    "desk-executor",
  ]);
});

test("a blueprint declaring nothing external resolves to nothing and refuses nothing", () => {
  const resolved = resolveExternalSeats(getCrewBlueprint("defi-desk")!, [seat()]);
  assert.deepEqual(resolved, { external: {}, bindings: [], missing: [], ambiguous: [] });
});
