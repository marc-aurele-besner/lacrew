/**
 * Shared harness for the kernel unit tests. Holds no tests of its own.
 */

import assert from "node:assert/strict";

import * as epochStreamer from "./epochStreamer.js";
import * as escalationRouter from "./escalationRouter.js";
import * as orgRegistry from "./orgRegistry.js";
import * as policies from "./policies.js";
import * as token from "./token.js";
import * as treasury from "./treasury.js";
import { SimRevert, type Address, type KernelEnv, type SimEvent } from "./types.js";
import { genesis, inertEnv, transact, type Ctx, type GenesisParams, type World } from "./world.js";

const named = (byte: string): Address => `0x${byte.repeat(20)}` as Address;

export const ROOT = named("a1");
export const MANAGER = named("b2");
export const WORKER = named("c3");
export const STRANGER = named("d4");
export const TARGET = named("e5");
export const OTHER_TARGET = named("e6");
export const KEY = named("f7");
export const OTHER_KEY = named("f8");
export const SECOND_HUMAN = named("a9");

/** 2023-11-14T22:13:20Z: 80 000 seconds into its UTC day. */
export const T0 = 1_700_000_000n;
export const USDC = 1_000_000n;

/** A world plus a clock, with every call committed or refused as one step. */
export class Sim {
  now: bigint;
  events: SimEvent[] = [];
  env: KernelEnv = inertEnv;

  constructor(
    public world: World,
    now: bigint = T0,
  ) {
    this.now = now;
  }

  /** Send a call as `sender` and commit it. */
  send<T>(sender: Address, fn: (ctx: Ctx) => T): T {
    const out = transact(this.world, { sender, at: this.now, env: this.env }, fn);
    this.world = out.world;
    this.events.push(...out.events);
    return out.result;
  }

  /** Run a read; nothing it does is kept. */
  read<T>(fn: (ctx: Ctx) => T): T {
    return transact(this.world, { sender: STRANGER, at: this.now, env: this.env }, fn).result;
  }

  /** Assert the call reverts with `errorName` and changes nothing. */
  reverts(errorName: string, sender: Address, fn: (ctx: Ctx) => unknown): SimRevert {
    const before = structuredClone(this.world);
    let caught: unknown;
    try {
      transact(this.world, { sender, at: this.now, env: this.env }, fn);
    } catch (err) {
      caught = err;
    }
    assert.ok(caught instanceof SimRevert, `expected a ${errorName} revert, got ${String(caught)}`);
    assert.equal(caught.errorName, errorName);
    assert.deepEqual(this.world, before, "a reverted call must leave the world untouched");
    return caught;
  }

  warp(seconds: bigint): void {
    this.now += seconds;
  }

  /** Names of the events emitted since `mark` (default: all). */
  eventNames(mark = 0): string[] {
    return this.events.slice(mark).map((e) => e.name);
  }

  lastEvent(name: string): SimEvent {
    const found = [...this.events].reverse().find((e) => e.name === name);
    assert.ok(found, `no ${name} event was emitted`);
    return found;
  }
}

/** An empty org whose deployer (the root) still holds direct authority. */
export function bootstrapOrg(overrides: Partial<GenesisParams> = {}): Sim {
  return new Sim(genesis({ root: ROOT, at: T0, bindGovernor: false, ...overrides }));
}

/**
 * The reference crew on top of an empty org: a manager under the root, a
 * worker under the manager, each on its stack, one whitelisted target, a
 * funded treasury and a streamed worker allowance.
 */
export function crewOrg(overrides: Partial<GenesisParams> = {}): Sim {
  const sim = bootstrapOrg(overrides);
  const a = sim.world.addresses;
  sim.send(ROOT, (ctx) =>
    orgRegistry.addNode(ctx, MANAGER, orgRegistry.NodeKind.ManagerAgent, ROOT),
  );
  sim.send(ROOT, (ctx) =>
    orgRegistry.addNode(ctx, WORKER, orgRegistry.NodeKind.WorkerAgent, MANAGER),
  );
  sim.send(ROOT, (ctx) => escalationRouter.setNodePolicy(ctx, MANAGER, a.managerPolicyStack));
  sim.send(ROOT, (ctx) => policies.setAllowed(ctx, a.whitelistPolicy, TARGET, true));
  sim.send(ROOT, (ctx) => policies.setAgentCap(ctx, a.spendCapPolicy, MANAGER, 200n * USDC));
  fund(sim, 100_000n * USDC);
  sim.send(ROOT, (ctx) => epochStreamer.setGrant(ctx, WORKER, 200n * USDC));
  sim.send(ROOT, (ctx) => epochStreamer.runNextEpoch(ctx));
  return sim;
}

/** Mint to the root and deposit it into the treasury. */
export function fund(sim: Sim, amount: bigint): void {
  const a = sim.world.addresses;
  sim.send(ROOT, (ctx) => token.mint(ctx, ROOT, amount));
  sim.send(ROOT, (ctx) => token.approve(ctx, a.treasury, amount));
  sim.send(ROOT, (ctx) => treasury.deposit(ctx, amount));
}
