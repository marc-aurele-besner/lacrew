import { describe, it } from "node:test";
import assert from "node:assert/strict";

import * as orgRegistry from "./orgRegistry.js";
import { ROOT, STRANGER, Sim, T0, TARGET, USDC, WORKER } from "./testkit.test.js";
import * as token from "./token.js";
import * as treasury from "./treasury.js";
import { ZERO_ADDRESS, type Address } from "./types.js";
import { allocateAddress, blankWorld, transact } from "./world.js";

const DEPLOYER = `0x${"11".repeat(20)}` as Address;
const SPENDER = `0x${"22".repeat(20)}` as Address;
const GOVERNOR = `0x${"33".repeat(20)}` as Address;
const STREAMER = `0x${"44".repeat(20)}` as Address;

/** Token, registry and a treasury whose spender is a plain account. */
function deployed(): Sim {
  let world = blankWorld();
  const run = (fn: Parameters<typeof transact>[2]) => {
    world = transact(world, { sender: DEPLOYER, at: T0 }, fn).world;
  };
  run((ctx) => token.deploy(ctx, allocateAddress(ctx)));
  run((ctx) => orgRegistry.deploy(ctx, allocateAddress(ctx), ROOT));
  run((ctx) =>
    treasury.deploy(
      ctx,
      allocateAddress(ctx),
      ctx.world.addresses.orgRegistry,
      ctx.world.addresses.token,
      SPENDER,
    ),
  );
  return new Sim(world);
}

function deposit(sim: Sim, amount: bigint): void {
  sim.send(DEPLOYER, (ctx) => token.mint(ctx, DEPLOYER, amount));
  sim.send(DEPLOYER, (ctx) => token.approve(ctx, sim.world.addresses.treasury, amount));
  sim.send(DEPLOYER, (ctx) => treasury.deposit(ctx, amount));
}

describe("kernel Treasury", () => {
  it("refuses a zero registry or token at construction", () => {
    assert.throws(
      () =>
        transact(blankWorld(), { sender: DEPLOYER, at: T0 }, (ctx) =>
          treasury.deploy(ctx, allocateAddress(ctx), ZERO_ADDRESS, TARGET, SPENDER),
        ),
      { errorName: "ZeroAddress" },
    );
  });

  it("deposits pull approved tokens and leave them liquid", () => {
    const sim = deployed();
    sim.send(DEPLOYER, (ctx) => token.mint(ctx, DEPLOYER, 1_000n * USDC));
    sim.reverts("ERC20InsufficientAllowance", DEPLOYER, (ctx) =>
      treasury.deposit(ctx, 1_000n * USDC),
    );
    sim.send(DEPLOYER, (ctx) => token.approve(ctx, sim.world.addresses.treasury, 5_000n * USDC));
    sim.reverts("ERC20InsufficientBalance", DEPLOYER, (ctx) =>
      treasury.deposit(ctx, 5_000n * USDC),
    );
    sim.send(DEPLOYER, (ctx) => treasury.deposit(ctx, 1_000n * USDC));

    assert.equal(
      sim.read((ctx) => treasury.liquidBalance(ctx)),
      1_000n * USDC,
    );
    assert.deepEqual(sim.lastEvent("Deposited").args, { from: DEPLOYER, amount: 1_000n * USDC });
  });

  it("streams an allowance out of liquid funds and reserves it", () => {
    const sim = deployed();
    deposit(sim, 1_000n * USDC);
    sim.send(DEPLOYER, (ctx) => treasury.streamAllowance(ctx, WORKER, 200n * USDC, 1n));

    assert.equal(sim.world.treasury.allowanceBalance[WORKER], 200n * USDC);
    assert.equal(sim.world.treasury.totalReserved, 200n * USDC);
    assert.equal(
      sim.read((ctx) => treasury.liquidBalance(ctx)),
      800n * USDC,
    );
    assert.deepEqual(sim.lastEvent("AllowanceStreamed").args, {
      node: WORKER,
      amount: 200n * USDC,
      epoch: 1n,
    });
  });

  it("refuses to stream more than is liquid", () => {
    const sim = deployed();
    deposit(sim, 100n * USDC);
    sim.send(DEPLOYER, (ctx) => treasury.streamAllowance(ctx, WORKER, 60n * USDC, 1n));
    const err = sim.reverts("InsufficientTreasury", DEPLOYER, (ctx) =>
      treasury.streamAllowance(ctx, WORKER, 41n * USDC, 2n),
    );
    assert.deepEqual(err.args, { requested: 41n * USDC, available: 40n * USDC });
  });

  it("refuses to stream to the zero address", () => {
    const sim = deployed();
    deposit(sim, 100n * USDC);
    sim.reverts("ZeroAddress", DEPLOYER, (ctx) =>
      treasury.streamAllowance(ctx, ZERO_ADDRESS, 1n, 1n),
    );
    assert.equal(sim.world.treasury.totalReserved, 0n);
  });

  it("lets only the deployer stream while bootstrapping, then only governor or streamer", () => {
    const sim = deployed();
    deposit(sim, 1_000n * USDC);
    sim.reverts("NotAuthorized", STRANGER, (ctx) => treasury.streamAllowance(ctx, WORKER, 1n, 1n));

    sim.send(DEPLOYER, (ctx) => treasury.setStreamer(ctx, STREAMER));
    // Binding a streamer ends the deployer's own stream authority.
    sim.reverts("NotAuthorized", DEPLOYER, (ctx) => treasury.streamAllowance(ctx, WORKER, 1n, 1n));
    sim.send(STREAMER, (ctx) => treasury.streamAllowance(ctx, WORKER, 1n, 1n));

    sim.send(DEPLOYER, (ctx) => treasury.setGovernor(ctx, GOVERNOR));
    sim.send(GOVERNOR, (ctx) => treasury.streamAllowance(ctx, WORKER, 1n, 2n));
    assert.equal(sim.world.treasury.allowanceBalance[WORKER], 2n);
  });

  it("spends an allowance to a recipient, for the spender only", () => {
    const sim = deployed();
    deposit(sim, 1_000n * USDC);
    sim.send(DEPLOYER, (ctx) => treasury.streamAllowance(ctx, WORKER, 200n * USDC, 1n));

    sim.reverts("NotSpender", STRANGER, (ctx) =>
      treasury.spendAllowance(ctx, WORKER, 10n * USDC, TARGET),
    );
    sim.reverts("ZeroAddress", SPENDER, (ctx) =>
      treasury.spendAllowance(ctx, WORKER, 10n * USDC, ZERO_ADDRESS),
    );
    const err = sim.reverts("InsufficientAllowance", SPENDER, (ctx) =>
      treasury.spendAllowance(ctx, WORKER, 201n * USDC, TARGET),
    );
    assert.deepEqual(err.args, { node: WORKER, requested: 201n * USDC, available: 200n * USDC });

    sim.send(SPENDER, (ctx) => treasury.spendAllowance(ctx, WORKER, 50n * USDC, TARGET));
    assert.equal(sim.world.treasury.allowanceBalance[WORKER], 150n * USDC);
    assert.equal(sim.world.treasury.totalReserved, 150n * USDC);
    assert.equal(
      sim.read((ctx) => token.balanceOf(ctx, TARGET)),
      50n * USDC,
    );
    assert.equal(
      sim.read((ctx) => treasury.liquidBalance(ctx)),
      800n * USDC,
    );
    assert.deepEqual(sim.lastEvent("AllowanceSpent").args, {
      node: WORKER,
      amount: 50n * USDC,
      to: TARGET,
    });
  });

  it("the two-argument overload pays the spender itself", () => {
    const sim = deployed();
    deposit(sim, 1_000n * USDC);
    sim.send(DEPLOYER, (ctx) => treasury.streamAllowance(ctx, WORKER, 200n * USDC, 1n));
    sim.reverts("NotSpender", STRANGER, (ctx) => treasury.spendAllowance(ctx, WORKER, 1n));
    sim.send(SPENDER, (ctx) => treasury.spendAllowance(ctx, WORKER, 30n * USDC));
    assert.equal(
      sim.read((ctx) => token.balanceOf(ctx, SPENDER)),
      30n * USDC,
    );
  });

  it("gates its setters on the deployer, then on the governor alone", () => {
    const sim = deployed();
    sim.reverts("NotAuthorized", STRANGER, (ctx) => treasury.setSpender(ctx, STRANGER));
    sim.reverts("NotAuthorized", STRANGER, (ctx) => treasury.setStreamer(ctx, STRANGER));
    sim.reverts("NotAuthorized", STRANGER, (ctx) => treasury.setGovernor(ctx, STRANGER));
    sim.reverts("ZeroAddress", DEPLOYER, (ctx) => treasury.setSpender(ctx, ZERO_ADDRESS));
    // The zero check on setGovernor comes before the caller check.
    sim.reverts("ZeroAddress", STRANGER, (ctx) => treasury.setGovernor(ctx, ZERO_ADDRESS));

    sim.send(DEPLOYER, (ctx) => treasury.setGovernor(ctx, GOVERNOR));
    sim.reverts("NotAuthorized", DEPLOYER, (ctx) => treasury.setSpender(ctx, STRANGER));
    sim.reverts("NotAuthorized", DEPLOYER, (ctx) => treasury.setGovernor(ctx, DEPLOYER));
    sim.send(GOVERNOR, (ctx) => treasury.setSpender(ctx, STRANGER));
    sim.send(GOVERNOR, (ctx) => treasury.setStreamer(ctx, ZERO_ADDRESS));
    assert.equal(sim.world.treasury.spender, STRANGER);
    assert.deepEqual(sim.lastEvent("SpenderUpdated").args, { spender: STRANGER });
  });

  it("counts tokens sent straight to it as liquid, never as reserved", () => {
    const sim = deployed();
    sim.send(DEPLOYER, (ctx) => token.mint(ctx, sim.world.addresses.treasury, 75n * USDC));
    assert.equal(
      sim.read((ctx) => treasury.liquidBalance(ctx)),
      75n * USDC,
    );
    assert.equal(sim.world.treasury.totalReserved, 0n);
  });
});
