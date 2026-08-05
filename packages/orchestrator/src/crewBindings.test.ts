/**
 * The orchestrator's own record of which account each blueprint seat landed on
 * (F2.25) — the thing a self-host had nowhere to keep.
 *
 * The claim worth testing is the one the issue makes: an operator can throw
 * away the plan file they installed from, restart the process, and the
 * checklist still binds every seat — including one somebody renamed.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createCrewBindings } from "./crewBindings.js";
import { createMemoryRuntimeStore, createPgRuntimeStore } from "./runtimeStore.js";
import { getCrewBlueprint, resolveCrewSeats } from "@lacrew/flows";

const A = "0x00000000000000000000000000000000000000aa";
const B = "0x00000000000000000000000000000000000000bb";

describe("crew bindings surface", () => {
  it("records a seat and answers with it in the shape a flow install takes", async () => {
    const bindings = createCrewBindings();
    await bindings.set({
      roleId: "reviewer",
      account: A.toUpperCase().replace("0X", "0x"),
      blueprintId: "github-experts",
    });

    assert.deepEqual(bindings.roles({ blueprintId: "github-experts" }), { reviewer: A });
    assert.equal(bindings.list()[0]?.account, A, "the account is stored lowercased");
  });

  it("refuses an address that is not one, and stores nothing", async () => {
    const bindings = createCrewBindings();
    await assert.rejects(
      () => bindings.set({ roleId: "reviewer", account: "0xnope" }),
      /account_invalid/,
    );
    assert.deepEqual(bindings.list(), []);
  });

  /*
    An account holds one seat. Without this the displaced pair stays in the map
    and `apply` — which reads account → role id — goes on answering with a seat
    nobody holds.
  */
  it("drops the seat an account is moved off within the same crew", async () => {
    const bindings = createCrewBindings();
    await bindings.set({ roleId: "reviewer", account: A, crewId: "crew-1" });
    await bindings.set({ roleId: "merger", account: A, crewId: "crew-1" });

    assert.deepEqual(bindings.roles({ crewId: "crew-1" }), { merger: A });
  });

  it("leaves another crew's binding of the same account alone", async () => {
    const bindings = createCrewBindings();
    await bindings.set({ roleId: "reviewer", account: A, crewId: "crew-1" });
    await bindings.set({ roleId: "reviewer", account: A, crewId: "crew-2" });

    assert.equal(bindings.list().length, 2);
  });

  it("forgets a seat on request, and says whether there was one", async () => {
    const bindings = createCrewBindings();
    await bindings.set({ roleId: "reviewer", account: A, blueprintId: "github-experts" });

    assert.equal(await bindings.clear({ roleId: "reviewer", blueprintId: "github-experts" }), true);
    assert.equal(
      await bindings.clear({ roleId: "reviewer", blueprintId: "github-experts" }),
      false,
    );
    assert.deepEqual(bindings.list(), []);
  });

  it("writes an audit row for a rebind, because re-pointing a role moves a principal", async () => {
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const bindings = createCrewBindings({
      onEvent: (e) => events.push({ type: e.type, payload: e.payload as Record<string, unknown> }),
    });
    await bindings.set({ roleId: "reviewer", account: A, crewId: "crew-1" });
    await bindings.clear({ roleId: "reviewer", crewId: "crew-1" });

    assert.deepEqual(
      events.map((e) => [e.type, e.payload.action]),
      [
        ["CrewBindingChanged", "set"],
        ["CrewBindingChanged", "cleared"],
      ],
    );
  });
});

describe("crew bindings across a restart", () => {
  /*
    The acceptance criterion, minus the chain: bind the seats, drop the process
    (a fresh surface over the same store), and the seats still resolve — even
    the one whose label no longer matches the blueprint.
  */
  it("rehydrates from the store and still binds a renamed seat", async () => {
    const bp = getCrewBlueprint("github-experts")!;
    const store = createMemoryRuntimeStore();
    const before = createCrewBindings({ store });
    const accounts = new Map(
      bp.roles.map((role, i) => [role.id, `0x${String(i + 1).padStart(40, "0")}`]),
    );
    for (const [roleId, account] of accounts) {
      await before.set({ roleId, account, blueprintId: bp.id, label: `seat ${roleId}` });
    }

    const after = createCrewBindings({ store });
    assert.equal(await after.hydrate(), bp.roles.length);

    // The chart the orchestrator serves, with one seat renamed since it was
    // hired and nothing else to go on.
    const chart = bp.roles.map((role) => ({
      account: accounts.get(role.id)!,
      kind: role.kind === "manager_agent" ? "ManagerAgent" : "WorkerAgent",
      label: role.id === "reviewer" ? "PR gatekeeper" : role.label,
    }));
    const seats = resolveCrewSeats(bp, after.apply(chart));

    assert.deepEqual(seats.missing, []);
    assert.equal(seats.roles.reviewer, accounts.get("reviewer"));
    assert.ok(seats.renamed.some((b) => b.role === "reviewer"));
  });

  it("hydrates nothing rather than inventing rows when no store is wired", async () => {
    const bindings = createCrewBindings();
    assert.equal(await bindings.hydrate(), 0);
  });

  it("carries a rebind through the store rather than leaving the old row behind", async () => {
    const store = createMemoryRuntimeStore();
    const before = createCrewBindings({ store });
    await before.set({ roleId: "reviewer", account: A, crewId: "crew-1" });
    await before.set({ roleId: "reviewer", account: B, crewId: "crew-1" });

    const after = createCrewBindings({ store });
    await after.hydrate();
    assert.deepEqual(after.roles({ crewId: "crew-1" }), { reviewer: B });
  });
});

/*
  The same claims against Postgres, which is the store a self-host that cares
  about surviving a restart actually runs.

  Worth its own pass rather than trusting the memory store: that one holds the
  record object whole, so a column this file forgot to write — or a `label` that
  never reached the row — round-trips there no matter what the mapping does.
  That is exactly how `blocks` shipped broken on `orchestrator_messages`.

  Skipped without DATABASE_URL, like every other store test here; CI runs it
  against a Postgres service.
*/
describe("crew bindings on Postgres", { skip: !process.env.DATABASE_URL }, () => {
  /** A crew id of its own per run, so a shared database is never a shared fixture. */
  const crewId = (): string => `test-crew-${process.pid}-${Date.now()}`;

  it("round-trips every field a binding carries, and rehydrates a renamed seat", async () => {
    const bp = getCrewBlueprint("github-experts")!;
    const crew = crewId();
    const store = createPgRuntimeStore();
    const accounts = new Map(
      bp.roles.map((role, i) => [role.id, `0x${String(i + 1).padStart(40, "0")}`]),
    );
    try {
      const writer = createCrewBindings({ store });
      for (const [roleId, account] of accounts) {
        await writer.set({
          roleId,
          account,
          crewId: crew,
          blueprintId: bp.id,
          label: bp.roles.find((r) => r.id === roleId)!.label,
        });
      }

      // A second process over the same rows — which is what a restart is.
      const reader = createCrewBindings({ store });
      await reader.hydrate();
      const mine = reader.list({ crewId: crew });
      assert.equal(mine.length, bp.roles.length);

      const reviewer = mine.find((b) => b.roleId === "reviewer");
      assert.equal(reviewer?.account, accounts.get("reviewer"));
      assert.equal(reviewer?.label, "Reviewer", "the label reached the row and came back");
      assert.equal(reviewer?.blueprintId, bp.id);
      assert.equal(reviewer?.crewId, crew);

      const chart = bp.roles.map((role) => ({
        account: accounts.get(role.id)!,
        kind: role.kind === "manager_agent" ? "ManagerAgent" : "WorkerAgent",
        label: role.id === "reviewer" ? "PR gatekeeper" : role.label,
      }));
      const seats = resolveCrewSeats(bp, reader.apply(chart));
      assert.deepEqual(seats.missing, []);
      assert.equal(seats.roles.reviewer, accounts.get("reviewer"));
      assert.ok(seats.renamed.some((b) => b.role === "reviewer"));
    } finally {
      const cleanup = createCrewBindings({ store });
      await cleanup.hydrate();
      for (const roleId of accounts.keys()) await cleanup.clear({ roleId, crewId: crew });
      await store.close();
    }
  });

  /*
    A rebind has to DELETE the displaced row, not just stop reading it: the next
    boot hydrates from the table, and a leftover row would put an account back
    on a seat nobody holds.
  */
  it("deletes the displaced row when a seat moves, and when one is cleared", async () => {
    const crew = crewId();
    const store = createPgRuntimeStore();
    try {
      const writer = createCrewBindings({ store });
      await writer.set({ roleId: "reviewer", account: A, crewId: crew });
      await writer.set({ roleId: "merger", account: A, crewId: crew });

      const afterMove = createCrewBindings({ store });
      await afterMove.hydrate();
      assert.deepEqual(afterMove.roles({ crewId: crew }), { merger: A });

      assert.equal(await afterMove.clear({ roleId: "merger", crewId: crew }), true);
      const afterClear = createCrewBindings({ store });
      await afterClear.hydrate();
      assert.deepEqual(afterClear.list({ crewId: crew }), []);
    } finally {
      await store.close();
    }
  });
});
