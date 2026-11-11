/**
 * Runs a scenario against one driver: resolves names to that driver's
 * addresses, encodes each call against the real ABI, checks the step's
 * expectation, and records a driver-independent transcript that two runs of
 * the same scenario can be compared by.
 */

import assert from "node:assert/strict";
import { encodeFunctionData, type Abi, type AbiParameter } from "viem";

import type { Driver, DriverEvent } from "./driver.js";
import { ABIS, Names, ZERO, normalise, type Address, type Hex, type Ref } from "./refs.js";
import {
  isRevert,
  type Arg,
  type CallSpec,
  type Scenario,
  type StateExpectation,
  type Step,
} from "./scenario.js";
import { snapshot } from "./snapshot.js";

/** One step's outcome, with every address replaced by the name it goes by. */
export type TranscriptEntry =
  | { step: number; ok: true; events: unknown[] }
  | { step: number; ok: false; revert: string }
  | { step: number; state: unknown };

export interface RunResult {
  transcript: TranscriptEntry[];
  /** The org's whole readable state when the scenario ended. */
  final: unknown;
}

/** Turn a scenario argument into the value the ABI parameter takes. */
function resolveArg(arg: Arg, param: AbiParameter, names: Names, now: number): unknown {
  const type = param.type;
  if (type.endsWith("[]")) {
    assert.ok(Array.isArray(arg), `expected a list for ${param.name ?? type}`);
    const inner = { ...param, type: type.slice(0, -2) } as AbiParameter;
    return arg.map((entry) => resolveArg(entry, inner, names, now));
  }
  if (type === "address") {
    assert.equal(typeof arg, "string", `expected a ref for ${param.name ?? type}`);
    return names.address(arg as Ref);
  }
  if (type === "bool") return Boolean(arg);
  if (type.startsWith("uint") || type.startsWith("int")) {
    if (typeof arg === "object" && arg !== null && "fromNow" in arg) {
      return BigInt(now + arg.fromNow);
    }
    const value = BigInt(arg as bigint | number);
    // Small integer types decode to numbers in viem; it accepts numbers back.
    const bits = Number(type.replace(/^u?int/, "") || "256");
    return bits <= 48 ? Number(value) : value;
  }
  if (type.startsWith("bytes")) {
    if (typeof arg === "object" && arg !== null && "call" in arg) {
      return encodeCall(arg.call, names, now);
    }
    return arg as Hex;
  }
  throw new Error(`no way to pass a ${type}`);
}

/** Calldata for one call, with refs resolved against `names`. */
export function encodeCall(call: CallSpec, names: Names, now: number): Hex {
  const abi = ABIS[names.kind(call.to)];
  const args = call.args ?? [];
  // Overloads (the Treasury's two `spendAllowance`) are told apart by arity.
  const item = (abi as Abi).find(
    (entry) =>
      entry.type === "function" && entry.name === call.fn && entry.inputs.length === args.length,
  );
  assert.ok(
    item && item.type === "function",
    `${names.kind(call.to)} has no ${call.fn}/${args.length}`,
  );
  const resolved = args.map((arg, i) => resolveArg(arg, item.inputs[i]!, names, now));
  return encodeFunctionData({ abi: [item], functionName: call.fn, args: resolved });
}

function eventsForTranscript(events: DriverEvent[], names: Names): unknown[] {
  const labels = names.labels();
  return events.map((event) =>
    normalise({ address: event.address, name: event.name, args: event.args }, labels),
  );
}

/** The router verdict a successful `propose` reached, read off what it emitted. */
function verdictOf(events: DriverEvent[]): string | undefined {
  if (events.some((e) => e.name === "IntentCreated")) return "ESCALATE";
  if (events.some((e) => e.name === "ActionExecuted")) return "ALLOW";
  return undefined;
}

async function checkState(
  driver: Driver,
  names: Names,
  expected: StateExpectation,
  where: string,
): Promise<void> {
  const client = driver.client;
  const at = (ref: Ref): Address => names.address(ref).toLowerCase() as Address;
  const same = (a: string | null | undefined, ref: Ref | null) =>
    ref === null ? a === null || a === ZERO : a?.toLowerCase() === at(ref);

  if (expected.secondOfDay !== undefined) {
    assert.equal(driver.now() % 86_400, expected.secondOfDay, `${where}: second of day`);
  }
  if (expected.treeUnreadable) {
    await assert.rejects(client.getOrgTree(), `${where}: the tree should be unreadable`);
  }
  const needsTree = expected.nodes || expected.tree;
  const tree = needsTree ? await client.getOrgTree() : [];
  if (expected.tree) {
    assert.deepEqual(
      tree.map((n) => n.account.toLowerCase()),
      expected.tree.map(at),
      `${where}: tree`,
    );
  }
  for (const [ref, want] of Object.entries(expected.nodes ?? {})) {
    const node = tree.find((n) => n.account.toLowerCase() === at(ref));
    if (want === null) {
      assert.equal(node, undefined, `${where}: ${ref} should not be in the tree`);
      continue;
    }
    assert.ok(node, `${where}: ${ref} should be in the tree`);
    if (want.parent !== undefined) {
      assert.ok(same(node.parent, want.parent), `${where}: parent of ${ref} is ${node.parent}`);
    }
    if (want.active !== undefined) assert.equal(node.active, want.active, `${where}: ${ref}`);
    if (want.kind !== undefined) assert.equal(node.kind, want.kind, `${where}: ${ref}`);
  }

  if (expected.allowance) {
    const allowances = await client.getAllowances();
    for (const [ref, want] of Object.entries(expected.allowance)) {
      const row = allowances.find((a) => a.node.toLowerCase() === at(ref));
      assert.equal(row?.balance ?? 0n, want, `${where}: allowance of ${ref}`);
    }
  }
  if (expected.caps) {
    for (const [ref, want] of Object.entries(expected.caps)) {
      assert.equal(await client.capOf(at(ref)), want, `${where}: cap of ${ref}`);
    }
  }
  if (expected.treasury) {
    const [balances] = await client.getTreasuryBalances();
    for (const key of ["total", "liquid", "reserved"] as const) {
      const want: bigint | undefined = expected.treasury[key];
      if (want !== undefined) assert.equal(balances?.[key], want, `${where}: treasury ${key}`);
    }
  }
  for (const [ref, want] of Object.entries(expected.balance ?? {})) {
    assert.equal(await driver.balanceOf(at(ref)), want, `${where}: token balance of ${ref}`);
  }

  for (const [id, want] of Object.entries(expected.intents ?? {})) {
    const intent = await driver.readIntent(BigInt(id));
    if (want.awaiting !== undefined) {
      assert.ok(
        same(intent.awaitingApprover, want.awaiting),
        `${where}: intent ${id} awaits ${intent.awaitingApprover}`,
      );
    }
    if (want.resolved !== undefined) {
      assert.equal(intent.resolved, want.resolved, `${where}: intent ${id} resolved`);
    }
    if (want.approved !== undefined) {
      assert.equal(intent.approved, want.approved, `${where}: intent ${id} approved`);
    }
    if (want.value !== undefined) assert.equal(intent.value, want.value, `${where}: intent ${id}`);
  }
  if (expected.pending) {
    const pending = await client.getPendingIntents();
    assert.deepEqual(
      pending.map((i) => Number(i.id)),
      expected.pending,
      `${where}: pending intents`,
    );
  }

  for (const want of expected.keys ?? []) {
    const limits = await client.readKeyLimits(at(want.agent), at(want.key));
    assert.equal(limits.valid, want.valid, `${where}: key ${want.key} of ${want.agent}`);
    if (want.maxValue !== undefined) {
      assert.equal(limits.maxValue, want.maxValue, `${where}: key ${want.key} max value`);
    }
  }

  if (expected.epoch !== undefined) {
    assert.equal(await client.getCurrentEpoch(), expected.epoch, `${where}: epoch`);
  }
  if (expected.grants) {
    const grants = await client.getGrants();
    assert.deepEqual(
      Object.fromEntries(grants.map((g) => [g.account.toLowerCase(), g.amount])),
      Object.fromEntries(Object.entries(expected.grants).map(([ref, v]) => [at(ref), `${v}`])),
      `${where}: grants`,
    );
  }

  for (const [id, want] of Object.entries(expected.proposals ?? {})) {
    const proposal = await client.getProposal(id);
    if (want.state !== undefined) {
      assert.equal(proposal.state, want.state, `${where}: proposal ${id}`);
    }
    if (want.yesVotes !== undefined) {
      assert.equal(proposal.yesVotes, want.yesVotes, `${where}: proposal ${id} yes`);
    }
    if (want.noVotes !== undefined) {
      assert.equal(proposal.noVotes, want.noVotes, `${where}: proposal ${id} no`);
    }
  }
  for (const [ref, want] of Object.entries(expected.seats ?? {})) {
    const seat = await client.readGovernanceSeat(at(ref));
    assert.equal(seat.power, `${want.power}`, `${where}: seat power of ${ref}`);
    assert.equal(seat.role, want.role, `${where}: seat role of ${ref}`);
  }
  if (expected.governance) {
    const config = await client.readGovernanceConfig();
    const g = expected.governance;
    if (g.humanSeatCount !== undefined) {
      assert.equal(config.humanSeatCount, `${g.humanSeatCount}`, `${where}: human seats`);
    }
    if (g.quorumYes !== undefined) {
      assert.equal(config.quorumYes, `${g.quorumYes}`, `${where}: quorumYes`);
    }
    if (g.unanimityFastPath !== undefined) {
      assert.equal(config.unanimityFastPath, g.unanimityFastPath, `${where}: fast path`);
    }
  }

  for (const want of expected.verdicts ?? []) {
    const verdict = await client.checkPolicy({
      agent: at(want.agent),
      target: at(want.target),
      value: want.value,
      ...(want.module ? { policyModule: at(want.module) } : {}),
    });
    assert.equal(
      verdict,
      want.verdict,
      `${where}: verdict for ${want.agent} -> ${want.target} of ${want.value}`,
    );
  }
  for (const want of expected.denials ?? []) {
    const what = `${where}: denial of ${want.agent} -> ${want.target} of ${want.value}`;
    const denial = await client.explainDenial({
      agent: at(want.agent),
      target: at(want.target),
      value: want.value,
    });
    if (want.by === null) {
      assert.equal(denial, null, what);
      continue;
    }
    assert.equal(denial?.module.toLowerCase(), at(want.by), what);
    if (want.reason !== undefined) assert.equal(denial?.reason, want.reason, what);
  }
}

/** Accounts whose token balance a snapshot records, by the ref they go by. */
export function watched(names: Names): Record<string, Address> {
  const refs = [
    "target",
    "target2",
    "root",
    "manager",
    "worker",
    "stranger",
    "@treasury",
    "@router",
  ];
  return Object.fromEntries(refs.map((ref) => [ref, names.address(ref)]));
}

/**
 * Execute one step on one driver, check what the step expects, and return its
 * transcript entry (nothing for a warp).
 */
export async function runStep(
  driver: Driver,
  names: Names,
  step: Step,
  index: number,
  label: string,
): Promise<TranscriptEntry | null> {
  const where = `${driver.name}: "${label}" step ${index}${describeStep(step)}`;
  switch (step.op) {
    case "warp":
      await driver.warp(step.seconds);
      return null;
    case "assert":
      await checkState(driver, names, step.state, where);
      return { step: index, state: await snapshot(driver, names, watched(names)) };
    case "deploy": {
      const abi = ABIS[step.contract];
      const ctor = abi.find((entry) => entry.type === "constructor");
      const inputs = ctor && ctor.type === "constructor" ? ctor.inputs : [];
      // The transaction runs one second after `now`.
      const args = (step.args ?? []).map((arg, i) =>
        resolveArg(arg, inputs[i]!, names, driver.now() + 1),
      );
      const out = await driver.deploy(names.address(step.from), step.contract, args);
      if (step.expect) {
        assert.deepEqual(out, { ok: false, revert: step.expect.revert }, where);
        return { step: index, ok: false, revert: step.expect.revert };
      }
      assert.ok(out.ok, `${where}: reverted with ${out.ok ? "" : out.revert}`);
      names.define(step.as, out.address, step.contract);
      return { step: index, ok: true, events: [] };
    }
    case "call": {
      const data = encodeCall(step.call, names, driver.now() + 1);
      const out = await driver.send(names.address(step.from), names.address(step.call.to), data);
      if (step.anyOutcome) {
        return out.ok
          ? { step: index, ok: true, events: eventsForTranscript(out.events, names) }
          : { step: index, ok: false, revert: out.revert };
      }
      if (isRevert(step.expect)) {
        assert.deepEqual(out, { ok: false, revert: step.expect.revert }, where);
        return { step: index, ok: false, revert: step.expect.revert };
      }
      assert.ok(out.ok, `${where}: reverted with ${out.ok ? "" : out.revert}`);
      if (step.expect?.verdict) {
        assert.equal(verdictOf(out.events), step.expect.verdict, `${where}: verdict`);
      }
      if (step.expect?.events) {
        assert.deepEqual(
          out.events.map((e) => e.name),
          step.expect.events,
          `${where}: events`,
        );
      }
      return { step: index, ok: true, events: eventsForTranscript(out.events, names) };
    }
  }
}

export async function runScenario(driver: Driver, scenario: Scenario): Promise<RunResult> {
  await driver.reset(scenario.genesis ?? {});
  const names = new Names(driver.book);
  const transcript: TranscriptEntry[] = [];
  for (const [index, step] of scenario.steps.entries()) {
    const entry = await runStep(driver, names, step, index, scenario.name);
    if (entry) transcript.push(entry);
  }
  return { transcript, final: await snapshot(driver, names, watched(names)) };
}

function describeStep(step: Step): string {
  if (step.op === "call") return ` (${step.from} -> ${step.call.to}.${step.call.fn})`;
  if (step.op === "deploy") return ` (deploy ${step.contract} as $${step.as})`;
  if (step.op === "assert" && step.note) return ` (${step.note})`;
  return "";
}
