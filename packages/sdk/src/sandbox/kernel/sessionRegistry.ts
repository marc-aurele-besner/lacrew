/**
 * SessionRegistry: scoped, expiring agent session keys.
 * Mirrors `contracts/src/SessionRegistry.sol`.
 */

import { emit } from "./frame.js";
import { ONE_DAY, SimRevert, ZERO_ADDRESS, addr, checkedAdd, type Address } from "./types.js";
import type { Ctx } from "./world.js";

const CONTRACT = "SessionRegistry";

/** `SessionScopes`. */
export const SCOPE_PROPOSE_INTENT = 1n << 0n;
export const SCOPE_SPEND_WHITELIST = 1n << 1n;
export const SCOPE_ALL = SCOPE_PROPOSE_INTENT | SCOPE_SPEND_WHITELIST;

const DEFAULT_MAX_ISSUER_TTL = 30n * ONE_DAY;

export interface SessionState {
  agent: Address;
  key: Address;
  expiresAt: bigint;
  scopeMask: bigint;
  maxValue: bigint;
  /** The first pinned target; zero when the session is unpinned. */
  allowedTarget: Address;
  revoked: boolean;
  exists: boolean;
  /** Daily window `[windowStart, windowEnd)` in seconds since midnight UTC; both zero = any time. */
  windowStart: bigint;
  windowEnd: bigint;
}

export interface RateLimitState {
  maxProposals: bigint;
  ratePeriod: bigint;
  windowStart: bigint;
  count: bigint;
}

export interface SessionRegistryState {
  humanRoot: Address;
  issuer: Address;
  maxIssuerTtl: bigint;
  nextSessionId: bigint;
  /** Keyed by session id as a decimal string. */
  sessions: Record<string, SessionState>;
  byAgent: Record<Address, bigint[]>;
  /** agent => key => session id (0 = none / cleared). */
  activeKeySession: Record<Address, Record<Address, bigint>>;
  /** session id => pinned targets (empty = any policy-allowed target). */
  sessionTargets: Record<string, Address[]>;
  rateLimits: Record<string, RateLimitState>;
  escalationRouter: Address;
}

export function blankSessionRegistry(): SessionRegistryState {
  return {
    humanRoot: ZERO_ADDRESS,
    issuer: ZERO_ADDRESS,
    maxIssuerTtl: DEFAULT_MAX_ISSUER_TTL,
    nextSessionId: 1n,
    sessions: {},
    byAgent: {},
    activeKeySession: {},
    sessionTargets: {},
    rateLimits: {},
    escalationRouter: ZERO_ADDRESS,
  };
}

function sessionAt(state: SessionRegistryState, id: bigint): SessionState {
  return (
    state.sessions[id.toString()] ?? {
      agent: ZERO_ADDRESS,
      key: ZERO_ADDRESS,
      expiresAt: 0n,
      scopeMask: 0n,
      maxValue: 0n,
      allowedTarget: ZERO_ADDRESS,
      revoked: false,
      exists: false,
      windowStart: 0n,
      windowEnd: 0n,
    }
  );
}

function activeId(state: SessionRegistryState, agent: Address, key: Address): bigint {
  return state.activeKeySession[addr(agent)]?.[addr(key)] ?? 0n;
}

export function deploy(ctx: Ctx, address: Address, humanRoot_: Address): void {
  const humanRoot = addr(humanRoot_);
  if (humanRoot === ZERO_ADDRESS) throw new SimRevert("ZeroAddress");
  ctx.world.addresses.sessionRegistry = address;
  ctx.world.sessionRegistry = { ...blankSessionRegistry(), humanRoot, issuer: humanRoot };
}

export function setIssuer(ctx: Ctx, issuer_: Address): void {
  const state = ctx.world.sessionRegistry;
  const issuer = addr(issuer_);
  if (ctx.sender !== state.humanRoot) throw new SimRevert("NotAuthorized", { caller: ctx.sender });
  if (issuer === ZERO_ADDRESS) throw new SimRevert("ZeroAddress");
  state.issuer = issuer;
  emit(ctx, ctx.world.addresses.sessionRegistry, CONTRACT, "IssuerUpdated", { issuer });
}

export function setMaxIssuerTtl(ctx: Ctx, maxIssuerTtl_: bigint): void {
  const state = ctx.world.sessionRegistry;
  if (ctx.sender !== state.humanRoot) throw new SimRevert("NotAuthorized", { caller: ctx.sender });
  if (maxIssuerTtl_ === 0n) throw new SimRevert("ZeroTtl");
  state.maxIssuerTtl = maxIssuerTtl_;
  emit(ctx, ctx.world.addresses.sessionRegistry, CONTRACT, "MaxIssuerTtlUpdated", {
    maxIssuerTtl: maxIssuerTtl_,
  });
}

export function setEscalationRouter(ctx: Ctx, escalationRouter_: Address): void {
  const state = ctx.world.sessionRegistry;
  const escalationRouter = addr(escalationRouter_);
  if (ctx.sender !== state.humanRoot) throw new SimRevert("NotAuthorized", { caller: ctx.sender });
  if (escalationRouter === ZERO_ADDRESS) throw new SimRevert("ZeroAddress");
  state.escalationRouter = escalationRouter;
  emit(ctx, ctx.world.addresses.sessionRegistry, CONTRACT, "EscalationRouterUpdated", {
    escalationRouter,
  });
}

export function issue(
  ctx: Ctx,
  agent: Address,
  key: Address,
  expiresAt: bigint,
  scopeMask: bigint,
  maxValue: bigint,
  allowedTarget: Address,
): bigint {
  onlyRootOrIssuer(ctx);
  const targets = addr(allowedTarget) !== ZERO_ADDRESS ? [allowedTarget] : [];
  return issueInternal(ctx, agent, key, expiresAt, scopeMask, maxValue, targets, 0n, 0n, 0n, 0n);
}

export function issueScoped(
  ctx: Ctx,
  agent: Address,
  key: Address,
  expiresAt: bigint,
  scopeMask: bigint,
  maxValue: bigint,
  allowedTargets: Address[],
): bigint {
  onlyRootOrIssuer(ctx);
  return issueInternal(
    ctx,
    agent,
    key,
    expiresAt,
    scopeMask,
    maxValue,
    allowedTargets,
    0n,
    0n,
    0n,
    0n,
  );
}

export function issueScopedTimed(
  ctx: Ctx,
  agent: Address,
  key: Address,
  expiresAt: bigint,
  scopeMask: bigint,
  maxValue: bigint,
  allowedTargets: Address[],
  windowStart: bigint,
  windowEnd: bigint,
  maxProposals: bigint,
  ratePeriod: bigint,
): bigint {
  onlyRootOrIssuer(ctx);
  return issueInternal(
    ctx,
    agent,
    key,
    expiresAt,
    scopeMask,
    maxValue,
    allowedTargets,
    windowStart,
    windowEnd,
    maxProposals,
    ratePeriod,
  );
}

function issueInternal(
  ctx: Ctx,
  agent_: Address,
  key_: Address,
  expiresAt: bigint,
  scopeMask: bigint,
  maxValue: bigint,
  allowedTargets: Address[],
  windowStart: bigint,
  windowEnd: bigint,
  maxProposals: bigint,
  ratePeriod: bigint,
): bigint {
  const state = ctx.world.sessionRegistry;
  const self = ctx.world.addresses.sessionRegistry;
  const agent = addr(agent_);
  const key = addr(key_);
  if (agent === ZERO_ADDRESS || key === ZERO_ADDRESS) throw new SimRevert("ZeroAddress");
  if (expiresAt <= ctx.now) throw new SimRevert("InvalidExpiry", { expiresAt });
  if (ctx.sender !== state.humanRoot) {
    const maxExpiresAt = checkedAdd(ctx.now, state.maxIssuerTtl, 64);
    if (expiresAt > maxExpiresAt) {
      throw new SimRevert("ExpiryExceedsIssuerTtl", { expiresAt, maxExpiresAt });
    }
  }
  if (scopeMask === 0n || (scopeMask & ~SCOPE_ALL) !== 0n) {
    throw new SimRevert("InvalidScopeMask", { scopeMask });
  }
  if (windowStart !== 0n || windowEnd !== 0n) {
    if (windowEnd <= windowStart || windowEnd > ONE_DAY) {
      throw new SimRevert("InvalidWindow", { windowStart, windowEnd });
    }
  }
  if (maxProposals !== 0n || ratePeriod !== 0n) {
    if (maxProposals === 0n || ratePeriod === 0n) {
      throw new SimRevert("InvalidRateLimit", { maxProposals, ratePeriod });
    }
  }

  // Revoke any prior active session for this key binding.
  const prior = activeId(state, agent, key);
  if (prior !== 0n && !sessionAt(state, prior).revoked) {
    state.sessions[prior.toString()]!.revoked = true;
    emit(ctx, self, CONTRACT, "SessionRevoked", { sessionId: prior, by: ctx.sender });
  }

  const sessionId = state.nextSessionId++;
  const pinned: Address[] = [];
  let first: Address = ZERO_ADDRESS;
  for (const raw of allowedTargets) {
    const t = addr(raw);
    if (t === ZERO_ADDRESS) throw new SimRevert("ZeroAddress");
    if (pinned.includes(t)) continue;
    pinned.push(t);
    if (first === ZERO_ADDRESS) first = t;
  }
  state.sessionTargets[sessionId.toString()] = pinned;

  state.sessions[sessionId.toString()] = {
    agent,
    key,
    expiresAt,
    scopeMask,
    maxValue,
    allowedTarget: first,
    revoked: false,
    exists: true,
    windowStart,
    windowEnd,
  };
  (state.byAgent[agent] ??= []).push(sessionId);
  (state.activeKeySession[agent] ??= {})[key] = sessionId;

  if (maxProposals !== 0n) {
    // windowStart 0 / count 0: the first recorded proposal opens the window.
    state.rateLimits[sessionId.toString()] = {
      maxProposals,
      ratePeriod,
      windowStart: 0n,
      count: 0n,
    };
  }

  emit(ctx, self, CONTRACT, "SessionIssued", {
    sessionId,
    agent,
    key,
    expiresAt,
    scopeMask,
    maxValue,
    allowedTarget: first,
  });
  if (pinned.length > 1) {
    emit(ctx, self, CONTRACT, "SessionTargetsPinned", { sessionId, targets: [...pinned] });
  }
  return sessionId;
}

export function revoke(ctx: Ctx, sessionId: bigint): void {
  onlyRootOrIssuer(ctx);
  const state = ctx.world.sessionRegistry;
  const s = sessionAt(state, sessionId);
  if (!s.exists) throw new SimRevert("SessionNotFound", { sessionId });
  if (s.revoked) throw new SimRevert("AlreadyRevoked", { sessionId });
  state.sessions[sessionId.toString()]!.revoked = true;
  if (activeId(state, s.agent, s.key) === sessionId) {
    state.activeKeySession[s.agent]![s.key] = 0n;
  }
  emit(ctx, ctx.world.addresses.sessionRegistry, CONTRACT, "SessionRevoked", {
    sessionId,
    by: ctx.sender,
  });
}

export function isValid(ctx: Ctx, sessionId: bigint): boolean {
  const s = sessionAt(ctx.world.sessionRegistry, sessionId);
  if (!s.exists || s.revoked) return false;
  return ctx.now < s.expiresAt;
}

export function isKeyValid(ctx: Ctx, agent: Address, key: Address): boolean {
  const id = activeId(ctx.world.sessionRegistry, agent, key);
  if (id === 0n) return false;
  return isValid(ctx, id);
}

export function keyLimits(
  ctx: Ctx,
  agent: Address,
  key: Address,
): { valid: boolean; maxValue: bigint; allowedTarget: Address; scopeMask: bigint } {
  const none = { valid: false, maxValue: 0n, allowedTarget: ZERO_ADDRESS, scopeMask: 0n };
  const state = ctx.world.sessionRegistry;
  const id = activeId(state, agent, key);
  if (id === 0n) return none;
  const s = sessionAt(state, id);
  if (!s.exists || s.revoked || ctx.now >= s.expiresAt) return none;
  return {
    valid: true,
    maxValue: s.maxValue,
    allowedTarget: s.allowedTarget,
    scopeMask: s.scopeMask,
  };
}

export function withinTimeWindow(ctx: Ctx, agent: Address, key: Address): boolean {
  const state = ctx.world.sessionRegistry;
  const id = activeId(state, agent, key);
  if (id === 0n) return true;
  const s = sessionAt(state, id);
  if (s.windowEnd === 0n) return true;
  const tod = ctx.now % ONE_DAY;
  return tod >= s.windowStart && tod < s.windowEnd;
}

export function recordProposal(ctx: Ctx, agent: Address, key: Address): void {
  const state = ctx.world.sessionRegistry;
  if (state.escalationRouter === ZERO_ADDRESS) return;
  if (ctx.sender !== state.escalationRouter) {
    throw new SimRevert("NotAuthorized", { caller: ctx.sender });
  }
  const id = activeId(state, agent, key);
  if (id === 0n) return;
  const r = state.rateLimits[id.toString()];
  if (!r || r.maxProposals === 0n) return;
  if (r.windowStart === 0n || ctx.now >= r.windowStart + r.ratePeriod) {
    // First proposal, or the prior window has elapsed: start a new one.
    r.windowStart = ctx.now;
    r.count = 1n;
  } else {
    r.count = checkedAdd(r.count, 1n, 32);
    if (r.count > r.maxProposals) {
      throw new SimRevert("RateLimitExceeded", {
        agent: addr(agent),
        key: addr(key),
        maxProposals: r.maxProposals,
      });
    }
  }
}

export function allowedTargetsOf(ctx: Ctx, sessionId: bigint): Address[] {
  return [...(ctx.world.sessionRegistry.sessionTargets[sessionId.toString()] ?? [])];
}

export function isTargetAllowed(ctx: Ctx, agent: Address, key: Address, target: Address): boolean {
  const state = ctx.world.sessionRegistry;
  const id = activeId(state, agent, key);
  if (id === 0n || !isValid(ctx, id)) return false;
  const pinned = state.sessionTargets[id.toString()] ?? [];
  if (pinned.length === 0) return true;
  return pinned.includes(addr(target));
}

export function sessionsOf(ctx: Ctx, agent: Address): bigint[] {
  return [...(ctx.world.sessionRegistry.byAgent[addr(agent)] ?? [])];
}

/** `sessions(id)`: the stored struct, or the zero struct for an unknown id. */
export function sessions(ctx: Ctx, sessionId: bigint): SessionState {
  return { ...sessionAt(ctx.world.sessionRegistry, sessionId) };
}

/** `rateLimits(id)`: the stored limit, or zeros when the session has none. */
export function rateLimits(ctx: Ctx, sessionId: bigint): RateLimitState {
  return {
    ...(ctx.world.sessionRegistry.rateLimits[sessionId.toString()] ?? {
      maxProposals: 0n,
      ratePeriod: 0n,
      windowStart: 0n,
      count: 0n,
    }),
  };
}

function onlyRootOrIssuer(ctx: Ctx): void {
  const state = ctx.world.sessionRegistry;
  if (ctx.sender !== state.humanRoot && ctx.sender !== state.issuer) {
    throw new SimRevert("NotAuthorized", { caller: ctx.sender });
  }
}
