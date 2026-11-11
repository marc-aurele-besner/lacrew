import { describe, it } from "node:test";
import assert from "node:assert/strict";

import * as epochStreamer from "./epochStreamer.js";
import { MANAGER, ROOT, STRANGER, Sim, USDC, WORKER, bootstrapOrg, fund } from "./testkit.test.js";
import * as treasury from "./treasury.js";
import { ZERO_ADDRESS, type Address } from "./types.js";

const A = `0x${"01".repeat(20)}` as Address;
const B = `0x${"02".repeat(20)}` as Address;
const C = `0x${"03".repeat(20)}` as Address;
const GOVERNOR = `0x${"33".repeat(20)}` as Address;

/** An empty org with a funded treasury; the root is the streamer's operator. */
function funded(amount = 1_000n * USDC): Sim {
  const sim = bootstrapOrg();
  fund(sim, amount);
  return sim;
}

const allowanceOf = (sim: Sim, node: Address) => sim.world.treasury.allowanceBalance[node] ?? 0n;

describe("kernel EpochStreamer", () => {
  it("runs the next epoch and streams every grant", () => {
    const sim = funded();
    sim.send(ROOT, (ctx) => epochStreamer.setGrant(ctx, WORKER, 200n * USDC));
    sim.send(ROOT, (ctx) => epochStreamer.setGrant(ctx, MANAGER, 50n * USDC));
    const mark = sim.events.length;
    const epoch = sim.send(ROOT, (ctx) => epochStreamer.runNextEpoch(ctx));

    assert.equal(epoch, 1n);
    assert.equal(sim.world.epochStreamer.currentEpoch, 1n);
    assert.equal(allowanceOf(sim, WORKER), 200n * USDC);
    assert.equal(allowanceOf(sim, MANAGER), 50n * USDC);
    assert.equal(sim.world.treasury.totalReserved, 250n * USDC);
    assert.deepEqual(sim.eventNames(mark), ["AllowanceStreamed", "AllowanceStreamed", "EpochRun"]);
    assert.deepEqual(sim.lastEvent("EpochRun").args, { epoch: 1n, recipientCount: 2n });
    assert.deepEqual(sim.lastEvent("AllowanceStreamed").args, {
      node: MANAGER,
      amount: 50n * USDC,
      epoch: 1n,
    });
  });

  it("carries an unspent allowance over into the next epoch", () => {
    const sim = funded();
    sim.send(ROOT, (ctx) => epochStreamer.setGrant(ctx, WORKER, 200n * USDC));
    sim.send(ROOT, (ctx) => epochStreamer.runNextEpoch(ctx));
    sim.send(ROOT, (ctx) => epochStreamer.runNextEpoch(ctx));
    assert.equal(allowanceOf(sim, WORKER), 400n * USDC);
    assert.equal(sim.world.epochStreamer.currentEpoch, 2n);
    assert.equal(
      sim.read((ctx) => treasury.liquidBalance(ctx)),
      600n * USDC,
    );
  });

  it("refuses an epoch id that already ran, and an empty schedule", () => {
    const sim = funded();
    sim.reverts("EmptySchedule", ROOT, (ctx) => epochStreamer.runNextEpoch(ctx));
    sim.send(ROOT, (ctx) => epochStreamer.setGrant(ctx, WORKER, 1n));
    sim.send(ROOT, (ctx) => epochStreamer.runNextEpoch(ctx));
    const err = sim.reverts("EpochAlreadyRun", ROOT, (ctx) => epochStreamer.runEpoch(ctx, 1n));
    assert.deepEqual(err.args, { epoch: 1n });
  });

  it("an explicit epoch id moves the counter forward, never back", () => {
    const sim = funded();
    sim.send(ROOT, (ctx) => epochStreamer.setGrant(ctx, WORKER, 1n));
    sim.send(ROOT, (ctx) => epochStreamer.runEpoch(ctx, 5n));
    assert.equal(sim.world.epochStreamer.currentEpoch, 5n);
    sim.send(ROOT, (ctx) => epochStreamer.runEpoch(ctx, 3n));
    assert.equal(sim.world.epochStreamer.currentEpoch, 5n);
    assert.equal(
      sim.send(ROOT, (ctx) => epochStreamer.runNextEpoch(ctx)),
      6n,
    );
    assert.equal(allowanceOf(sim, WORKER), 3n);
  });

  it("only the operator runs epochs", () => {
    const sim = funded();
    sim.send(ROOT, (ctx) => epochStreamer.setGrant(ctx, WORKER, 1n));
    sim.reverts("NotOperator", STRANGER, (ctx) => epochStreamer.runNextEpoch(ctx));
    sim.reverts("NotOperator", STRANGER, (ctx) => epochStreamer.runEpoch(ctx, 9n));
  });

  it("reverts the whole epoch when the treasury cannot cover one grant", () => {
    const sim = funded(100n * USDC);
    sim.send(ROOT, (ctx) => epochStreamer.setGrant(ctx, WORKER, 60n * USDC));
    sim.send(ROOT, (ctx) => epochStreamer.setGrant(ctx, MANAGER, 60n * USDC));
    sim.reverts("InsufficientTreasury", ROOT, (ctx) => epochStreamer.runNextEpoch(ctx));
    assert.equal(allowanceOf(sim, WORKER), 0n);
    assert.equal(sim.world.epochStreamer.currentEpoch, 0n);
  });

  it("the operator and the governor set grants; nobody else does", () => {
    const sim = funded();
    sim.reverts("NotAuthorized", STRANGER, (ctx) => epochStreamer.setGrant(ctx, WORKER, 1n));
    sim.reverts("NotAuthorized", STRANGER, (ctx) => epochStreamer.setGrants(ctx, [WORKER], [1n]));
    sim.reverts("NotOperator", STRANGER, (ctx) => epochStreamer.setGovernor(ctx, GOVERNOR));
    sim.reverts("ZeroAddress", ROOT, (ctx) => epochStreamer.setGovernor(ctx, ZERO_ADDRESS));
    sim.send(ROOT, (ctx) => epochStreamer.setGovernor(ctx, GOVERNOR));
    sim.reverts("GovernorAlreadySet", ROOT, (ctx) => epochStreamer.setGovernor(ctx, STRANGER));

    sim.send(GOVERNOR, (ctx) => epochStreamer.setGrant(ctx, WORKER, 7n));
    assert.equal(
      sim.read((ctx) => epochStreamer.grantAmount(ctx, WORKER)),
      7n,
    );
    assert.deepEqual(sim.lastEvent("GrantUpdated").args, { node: WORKER, amount: 7n });
    // The governor sets grants; running epochs stays with the operator.
    sim.reverts("NotOperator", GOVERNOR, (ctx) => epochStreamer.runNextEpoch(ctx));
  });

  it("clearing a grant drops the recipient the swap-and-pop way", () => {
    const sim = funded();
    for (const node of [A, B, C]) {
      sim.send(ROOT, (ctx) => epochStreamer.setGrant(ctx, node, 5n));
    }
    sim.send(ROOT, (ctx) => epochStreamer.setGrant(ctx, A, 0n));
    assert.deepEqual(
      sim.read((ctx) => epochStreamer.recipients(ctx)),
      [C, B],
    );
    assert.equal(
      sim.read((ctx) => epochStreamer.grantAmount(ctx, A)),
      0n,
    );
    // Clearing a node that holds no grant still reports the update.
    const mark = sim.events.length;
    sim.send(ROOT, (ctx) => epochStreamer.setGrant(ctx, A, 0n));
    assert.deepEqual(sim.eventNames(mark), ["GrantUpdated"]);
    sim.reverts("ZeroAddress", ROOT, (ctx) => epochStreamer.setGrant(ctx, ZERO_ADDRESS, 1n));
  });

  it("sets and clears many grants in one call", () => {
    const sim = funded();
    sim.send(ROOT, (ctx) => epochStreamer.setGrant(ctx, A, 5n));
    sim.reverts("LengthMismatch", ROOT, (ctx) => epochStreamer.setGrants(ctx, [A, B], [1n]));
    sim.send(ROOT, (ctx) => epochStreamer.setGrants(ctx, [A, B, C], [0n, 10n, 20n]));
    assert.deepEqual(
      sim.read((ctx) => epochStreamer.recipients(ctx)),
      [B, C],
    );
    sim.send(ROOT, (ctx) => epochStreamer.runNextEpoch(ctx));
    assert.equal(allowanceOf(sim, A), 0n);
    assert.equal(allowanceOf(sim, B), 10n);
    assert.equal(allowanceOf(sim, C), 20n);
    // One bad entry refuses the whole batch.
    sim.reverts("ZeroAddress", ROOT, (ctx) =>
      epochStreamer.setGrants(ctx, [A, ZERO_ADDRESS], [1n, 1n]),
    );
  });

  it("hands the operator role on, to a non-zero address", () => {
    const sim = funded();
    sim.reverts("NotOperator", STRANGER, (ctx) => epochStreamer.setOperator(ctx, STRANGER));
    sim.reverts("ZeroAddress", ROOT, (ctx) => epochStreamer.setOperator(ctx, ZERO_ADDRESS));
    sim.send(ROOT, (ctx) => epochStreamer.setOperator(ctx, MANAGER));
    sim.reverts("NotAuthorized", ROOT, (ctx) => epochStreamer.setGrant(ctx, WORKER, 1n));
    sim.reverts("NotOperator", ROOT, (ctx) => epochStreamer.runNextEpoch(ctx));
    sim.send(MANAGER, (ctx) => epochStreamer.setGrant(ctx, WORKER, 1n));
    assert.deepEqual(sim.lastEvent("OperatorUpdated").args, { operator: MANAGER });
  });
});
