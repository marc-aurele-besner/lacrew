/**
 * Policy modules. Mirrors `contracts/src/policies/*.sol`: PolicyStack,
 * SpendCapPolicy, WhitelistPolicy, RateLimitPolicy (with its recorder) and
 * TimeWindowPolicy.
 *
 * Modules are many-instance: each lives at its own address in
 * `world.policies`, and a function names the module it is called on.
 */

import { emit } from "./frame.js";
import {
  EVM_REVERT,
  ONE_DAY,
  SimRevert,
  ZERO_ADDRESS,
  addr,
  checkedAdd,
  type Address,
  type Hex,
} from "./types.js";
import type { Ctx } from "./world.js";

/** `Verdict`, by ABI value. */
export const Verdict = { ALLOW: 0, ESCALATE: 1, DENY: 2 } as const;
export type VerdictValue = (typeof Verdict)[keyof typeof Verdict];

export interface PolicyStackState {
  kind: "PolicyStack";
  modules: Address[];
}

export interface SpendCapPolicyState {
  kind: "SpendCapPolicy";
  defaultCap: bigint;
  agentCap: Record<Address, bigint>;
  hasAgentCap: Record<Address, boolean>;
  admin: Address;
  governor: Address;
}

export interface WhitelistPolicyState {
  kind: "WhitelistPolicy";
  allowed: Record<Address, boolean>;
  admin: Address;
  governor: Address;
}

export interface RateLimitPolicyState {
  kind: "RateLimitPolicy";
  maxActions: bigint;
  windowSeconds: bigint;
  /** Deployer; the only account that may bind the recorder. */
  admin: Address;
  recorder: Address;
  recorderLocked: boolean;
  windows: Record<Address, { windowStart: bigint; count: bigint }>;
}

export interface TimeWindowPolicyState {
  kind: "TimeWindowPolicy";
  startSecondOfDay: bigint;
  endSecondOfDay: bigint;
}

export type PolicyModuleState =
  | PolicyStackState
  | SpendCapPolicyState
  | WhitelistPolicyState
  | RateLimitPolicyState
  | TimeWindowPolicyState;

type KindOf<K extends PolicyModuleState["kind"]> = Extract<PolicyModuleState, { kind: K }>;

/** The module at `address`, when it is one of `kind`; a call to anything else has no such function. */
function moduleOf<K extends PolicyModuleState["kind"]>(
  ctx: Ctx,
  address: Address,
  ...kinds: K[]
): KindOf<K> {
  const module = ctx.world.policies[addr(address)];
  if (!module || !kinds.includes(module.kind as K)) throw new SimRevert(EVM_REVERT);
  return module as KindOf<K>;
}

// ——— constructors ———

export function deployPolicyStack(ctx: Ctx, address: Address, modules_: Address[]): void {
  if (modules_.length === 0) throw new SimRevert("EmptyStack");
  ctx.world.policies[address] = { kind: "PolicyStack", modules: modules_.map(addr) };
}

export function deploySpendCapPolicy(ctx: Ctx, address: Address, defaultCap_: bigint): void {
  ctx.world.policies[address] = {
    kind: "SpendCapPolicy",
    defaultCap: defaultCap_,
    agentCap: {},
    hasAgentCap: {},
    admin: ctx.sender,
    governor: ZERO_ADDRESS,
  };
}

export function deployWhitelistPolicy(ctx: Ctx, address: Address): void {
  ctx.world.policies[address] = {
    kind: "WhitelistPolicy",
    allowed: {},
    admin: ctx.sender,
    governor: ZERO_ADDRESS,
  };
}

export function deployRateLimitPolicy(
  ctx: Ctx,
  address: Address,
  maxActions_: bigint,
  windowSeconds_: bigint,
): void {
  ctx.world.policies[address] = {
    kind: "RateLimitPolicy",
    maxActions: maxActions_,
    windowSeconds: windowSeconds_,
    admin: ctx.sender,
    recorder: ZERO_ADDRESS,
    recorderLocked: false,
    windows: {},
  };
}

export function deployTimeWindowPolicy(
  ctx: Ctx,
  address: Address,
  startSecondOfDay_: bigint,
  endSecondOfDay_: bigint,
): void {
  if (endSecondOfDay_ <= startSecondOfDay_ || endSecondOfDay_ > ONE_DAY) {
    throw new SimRevert("InvalidWindow", {
      startSecond: startSecondOfDay_,
      endSecond: endSecondOfDay_,
    });
  }
  ctx.world.policies[address] = {
    kind: "TimeWindowPolicy",
    startSecondOfDay: startSecondOfDay_,
    endSecondOfDay: endSecondOfDay_,
  };
}

// ——— IPolicyModule ———

/** `IPolicyModule(module).check(agent, target, value, data)`. */
export function check(
  ctx: Ctx,
  module_: Address,
  agent_: Address,
  target_: Address,
  value: bigint,
  data: Hex,
): VerdictValue {
  const module = ctx.world.policies[addr(module_)];
  if (!module) throw new SimRevert(EVM_REVERT);
  const agent = addr(agent_);
  const target = addr(target_);

  switch (module.kind) {
    case "PolicyStack": {
      let escalate = false;
      for (const member of module.modules) {
        const v = check(ctx, member, agent, target, value, data);
        if (v === Verdict.DENY) return Verdict.DENY;
        if (v === Verdict.ESCALATE) escalate = true;
      }
      return escalate ? Verdict.ESCALATE : Verdict.ALLOW;
    }
    case "SpendCapPolicy":
      if (value <= capOf(ctx, module_, agent)) return Verdict.ALLOW;
      return Verdict.ESCALATE;
    case "WhitelistPolicy":
      if (module.allowed[target]) return Verdict.ALLOW;
      return Verdict.DENY;
    case "RateLimitPolicy": {
      const w = module.windows[agent] ?? { windowStart: 0n, count: 0n };
      if (w.windowStart === 0n || ctx.now >= checkedAdd(w.windowStart, module.windowSeconds)) {
        return Verdict.ALLOW;
      }
      if (w.count >= module.maxActions) return Verdict.ESCALATE;
      return Verdict.ALLOW;
    }
    case "TimeWindowPolicy": {
      const tod = ctx.now % ONE_DAY;
      if (tod < module.startSecondOfDay || tod >= module.endSecondOfDay) return Verdict.DENY;
      return Verdict.ALLOW;
    }
  }
}

/**
 * The module behind a DENY from `module_`: the first member, in `check()`
 * order, that denies when asked on its own. A stack is looked into; a stack
 * none of whose members denies is itself the answer. Null when `module_` does
 * not deny.
 *
 * No contract has this function. `check` answers with a verdict alone, and
 * this reads the same state to say whose verdict it was.
 */
export function denyingModule(
  ctx: Ctx,
  module_: Address,
  agent: Address,
  target: Address,
  value: bigint,
  data: Hex,
): Address | null {
  if (check(ctx, module_, agent, target, value, data) !== Verdict.DENY) return null;
  const module = ctx.world.policies[addr(module_)];
  if (module?.kind === "PolicyStack") {
    for (const member of module.modules) {
      const denying = denyingModule(ctx, member, agent, target, value, data);
      if (denying) return denying;
    }
  }
  return addr(module_);
}

// ——— SpendCapPolicy / WhitelistPolicy ———

/** `setGovernor` on a SpendCapPolicy or WhitelistPolicy: admin-only, once. */
export function setGovernor(ctx: Ctx, module_: Address, governor_: Address): void {
  const module = moduleOf(ctx, module_, "SpendCapPolicy", "WhitelistPolicy");
  const governor = addr(governor_);
  if (ctx.sender !== module.admin) throw new SimRevert("NotAuthorized", { caller: ctx.sender });
  if (governor === ZERO_ADDRESS) throw new SimRevert("ZeroAddress");
  if (module.governor !== ZERO_ADDRESS) throw new SimRevert("GovernorAlreadySet");
  module.governor = governor;
  emit(ctx, addr(module_), module.kind, "GovernorUpdated", { governor });
}

export function setAgentCap(ctx: Ctx, module_: Address, agent_: Address, cap_: bigint): void {
  const module = moduleOf(ctx, module_, "SpendCapPolicy");
  const agent = addr(agent_);
  if (ctx.sender !== module.admin && ctx.sender !== module.governor) {
    throw new SimRevert("NotAuthorized", { caller: ctx.sender });
  }
  module.agentCap[agent] = cap_;
  module.hasAgentCap[agent] = true;
  emit(ctx, addr(module_), module.kind, "AgentCapSet", { agent, cap: cap_ });
}

export function capOf(ctx: Ctx, module_: Address, agent_: Address): bigint {
  const module = moduleOf(ctx, module_, "SpendCapPolicy");
  const agent = addr(agent_);
  if (module.hasAgentCap[agent]) return module.agentCap[agent] ?? 0n;
  return module.defaultCap;
}

export function setAllowed(ctx: Ctx, module_: Address, target_: Address, isAllowed: boolean): void {
  const module = moduleOf(ctx, module_, "WhitelistPolicy");
  const target = addr(target_);
  if (ctx.sender !== module.admin && ctx.sender !== module.governor) {
    throw new SimRevert("NotAuthorized", { caller: ctx.sender });
  }
  module.allowed[target] = isAllowed;
  emit(ctx, addr(module_), module.kind, "TargetAllowed", { target, allowed: isAllowed });
}

// ——— RateLimitPolicy ———

export function setRecorder(ctx: Ctx, module_: Address, recorder_: Address): void {
  const module = moduleOf(ctx, module_, "RateLimitPolicy");
  const recorder = addr(recorder_);
  if (ctx.sender !== module.admin) throw new SimRevert("NotAuthorized", { caller: ctx.sender });
  if (module.recorderLocked) throw new SimRevert("RecorderLocked");
  if (recorder === ZERO_ADDRESS) throw new SimRevert("ZeroAddress");
  module.recorder = recorder;
  module.recorderLocked = true;
  emit(ctx, addr(module_), module.kind, "RecorderBound", { recorder });
}

/** `IRateRecorder(module).record(agent)`: the bound recorder, or the deployer until one is bound. */
export function record(ctx: Ctx, module_: Address, agent_: Address): void {
  const module = moduleOf(ctx, module_, "RateLimitPolicy");
  const agent = addr(agent_);
  const allowed = module.recorder === ZERO_ADDRESS ? module.admin : module.recorder;
  if (ctx.sender !== allowed) throw new SimRevert("NotRecorder", { caller: ctx.sender });

  const w = (module.windows[agent] ??= { windowStart: 0n, count: 0n });
  if (w.windowStart === 0n || ctx.now >= checkedAdd(w.windowStart, module.windowSeconds)) {
    w.windowStart = ctx.now;
    w.count = 1n;
    return;
  }
  w.count = checkedAdd(w.count, 1n, 32);
}
