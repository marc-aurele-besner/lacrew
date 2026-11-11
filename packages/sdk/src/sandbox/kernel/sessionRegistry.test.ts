import { describe, it } from "node:test";
import assert from "node:assert/strict";

import * as sessionRegistry from "./sessionRegistry.js";
import { SCOPE_ALL, SCOPE_PROPOSE_INTENT } from "./sessionRegistry.js";
import {
  KEY,
  OTHER_KEY,
  OTHER_TARGET,
  ROOT,
  STRANGER,
  Sim,
  T0,
  TARGET,
  WORKER,
} from "./testkit.test.js";
import { MAX_UINT256, MAX_UINT64, ONE_DAY, ZERO_ADDRESS, type Address } from "./types.js";
import { allocateAddress, blankWorld, transact, type Ctx } from "./world.js";

const ISSUER = `0x${"11".repeat(20)}` as Address;
const ROUTER = `0x${"44".repeat(20)}` as Address;
const HOUR = 3_600n;

function registry(): Sim {
  const world = transact(blankWorld(), { sender: STRANGER, at: T0 }, (ctx) =>
    sessionRegistry.deploy(ctx, allocateAddress(ctx), ROOT),
  ).world;
  return new Sim(world);
}

const issue = (ctx: Ctx, key: Address = KEY, target: Address = ZERO_ADDRESS) =>
  sessionRegistry.issue(ctx, WORKER, key, ctx.now + HOUR, SCOPE_ALL, 100n, target);

describe("kernel SessionRegistry", () => {
  it("starts with the root as issuer and a 30-day issuer ceiling", () => {
    const sim = registry();
    assert.equal(sim.world.sessionRegistry.issuer, ROOT);
    assert.equal(sim.world.sessionRegistry.maxIssuerTtl, 30n * ONE_DAY);
    assert.equal(sim.world.sessionRegistry.nextSessionId, 1n);
  });

  it("issues a session and reports its limits", () => {
    const sim = registry();
    const id = sim.send(ROOT, (ctx) => issue(ctx, KEY, TARGET));
    assert.equal(id, 1n);
    assert.deepEqual(
      sim.read((ctx) => sessionRegistry.keyLimits(ctx, WORKER, KEY)),
      { valid: true, maxValue: 100n, allowedTarget: TARGET, scopeMask: SCOPE_ALL },
    );
    assert.deepEqual(
      sim.read((ctx) => sessionRegistry.sessionsOf(ctx, WORKER)),
      [1n],
    );
    assert.deepEqual(sim.lastEvent("SessionIssued").args, {
      sessionId: 1n,
      agent: WORKER,
      key: KEY,
      expiresAt: T0 + HOUR,
      scopeMask: SCOPE_ALL,
      maxValue: 100n,
      allowedTarget: TARGET,
    });
  });

  it("only the root or the issuer may issue and revoke", () => {
    const sim = registry();
    sim.reverts("NotAuthorized", STRANGER, (ctx) => issue(ctx));
    sim.reverts("NotAuthorized", STRANGER, (ctx) => sessionRegistry.setIssuer(ctx, STRANGER));
    sim.reverts("ZeroAddress", ROOT, (ctx) => sessionRegistry.setIssuer(ctx, ZERO_ADDRESS));
    sim.send(ROOT, (ctx) => sessionRegistry.setIssuer(ctx, ISSUER));
    const id = sim.send(ISSUER, (ctx) => issue(ctx));
    sim.reverts("NotAuthorized", STRANGER, (ctx) => sessionRegistry.revoke(ctx, id));
    sim.send(ISSUER, (ctx) => sessionRegistry.revoke(ctx, id));
    // The root keeps its own authority alongside the issuer's.
    sim.send(ROOT, (ctx) => issue(ctx));
  });

  it("validates its arguments in the contract's order", () => {
    const sim = registry();
    const call = (
      over: Partial<{
        agent: Address;
        key: Address;
        expiresAt: bigint;
        mask: bigint;
        targets: Address[];
        ws: bigint;
        we: bigint;
        mp: bigint;
        rp: bigint;
      }>,
    ) => {
      return (ctx: Ctx) =>
        sessionRegistry.issueScopedTimed(
          ctx,
          over.agent ?? WORKER,
          over.key ?? KEY,
          over.expiresAt ?? ctx.now + HOUR,
          over.mask ?? SCOPE_ALL,
          1n,
          over.targets ?? [],
          over.ws ?? 0n,
          over.we ?? 0n,
          over.mp ?? 0n,
          over.rp ?? 0n,
        );
    };
    sim.reverts("ZeroAddress", ROOT, call({ agent: ZERO_ADDRESS, expiresAt: 0n }));
    sim.reverts("ZeroAddress", ROOT, call({ key: ZERO_ADDRESS }));
    sim.reverts("InvalidExpiry", ROOT, call({ expiresAt: T0, mask: 0n }));
    sim.reverts("InvalidScopeMask", ROOT, call({ mask: 0n, we: 5n, ws: 9n }));
    sim.reverts("InvalidScopeMask", ROOT, call({ mask: 4n }));
    sim.reverts("InvalidScopeMask", ROOT, call({ mask: SCOPE_ALL | 8n }));
    sim.reverts("InvalidWindow", ROOT, call({ ws: 10n, we: 10n, mp: 1n }));
    sim.reverts("InvalidWindow", ROOT, call({ ws: 10n, we: 0n }));
    sim.reverts("InvalidWindow", ROOT, call({ ws: 0n, we: ONE_DAY + 1n }));
    sim.reverts("InvalidRateLimit", ROOT, call({ mp: 3n, rp: 0n }));
    sim.reverts("InvalidRateLimit", ROOT, call({ mp: 0n, rp: 60n }));
    sim.reverts("ZeroAddress", ROOT, call({ targets: [TARGET, ZERO_ADDRESS] }));
    sim.send(ROOT, call({ ws: 0n, we: ONE_DAY, mp: 3n, rp: 60n }));
  });

  it("caps how far ahead the issuer may set an expiry, but not the root", () => {
    const sim = registry();
    sim.send(ROOT, (ctx) => sessionRegistry.setIssuer(ctx, ISSUER));
    const ceiling = T0 + 30n * ONE_DAY;
    const withExpiry = (expiresAt: bigint) => (ctx: Ctx) =>
      sessionRegistry.issue(ctx, WORKER, KEY, expiresAt, SCOPE_ALL, 1n, ZERO_ADDRESS);

    const err = sim.reverts("ExpiryExceedsIssuerTtl", ISSUER, withExpiry(ceiling + 1n));
    assert.deepEqual(err.args, { expiresAt: ceiling + 1n, maxExpiresAt: ceiling });
    sim.send(ISSUER, withExpiry(ceiling));
    sim.send(ROOT, withExpiry(ceiling + 365n * ONE_DAY));

    sim.reverts("NotAuthorized", ISSUER, (ctx) => sessionRegistry.setMaxIssuerTtl(ctx, 1n));
    sim.reverts("ZeroTtl", ROOT, (ctx) => sessionRegistry.setMaxIssuerTtl(ctx, 0n));
    sim.send(ROOT, (ctx) => sessionRegistry.setMaxIssuerTtl(ctx, HOUR));
    sim.reverts("ExpiryExceedsIssuerTtl", ISSUER, withExpiry(T0 + HOUR + 1n));
    sim.send(ISSUER, withExpiry(T0 + HOUR));
  });

  it("panics when the issuer ceiling overflows uint64", () => {
    const sim = registry();
    sim.send(ROOT, (ctx) => sessionRegistry.setIssuer(ctx, ISSUER));
    sim.send(ROOT, (ctx) => sessionRegistry.setMaxIssuerTtl(ctx, MAX_UINT64));
    sim.reverts("Panic", ISSUER, (ctx) => issue(ctx));
  });

  it("re-issuing a key revokes the session it replaces", () => {
    const sim = registry();
    sim.send(ROOT, (ctx) => issue(ctx));
    const mark = sim.events.length;
    const second = sim.send(ROOT, (ctx) => issue(ctx));
    assert.equal(second, 2n);
    assert.deepEqual(sim.eventNames(mark), ["SessionRevoked", "SessionIssued"]);
    assert.equal(sim.read((ctx) => sessionRegistry.sessions(ctx, 1n)).revoked, true);
    assert.equal(
      sim.read((ctx) => sessionRegistry.isValid(ctx, 1n)),
      false,
    );
    assert.equal(sim.world.sessionRegistry.activeKeySession[WORKER]![KEY], 2n);
    assert.deepEqual(
      sim.read((ctx) => sessionRegistry.sessionsOf(ctx, WORKER)),
      [1n, 2n],
    );
  });

  it("pins several targets, de-duplicated, and reports the first", () => {
    const sim = registry();
    const id = sim.send(ROOT, (ctx) =>
      sessionRegistry.issueScoped(ctx, WORKER, KEY, ctx.now + HOUR, SCOPE_ALL, 1n, [
        TARGET,
        OTHER_TARGET,
        TARGET,
      ]),
    );
    assert.deepEqual(
      sim.read((ctx) => sessionRegistry.allowedTargetsOf(ctx, id)),
      [TARGET, OTHER_TARGET],
    );
    assert.equal(
      sim.read((ctx) => sessionRegistry.keyLimits(ctx, WORKER, KEY)).allowedTarget,
      TARGET,
    );
    assert.deepEqual(sim.lastEvent("SessionTargetsPinned").args, {
      sessionId: id,
      targets: [TARGET, OTHER_TARGET],
    });
    const allowed = (target: Address) =>
      sim.read((ctx) => sessionRegistry.isTargetAllowed(ctx, WORKER, KEY, target));
    assert.equal(allowed(TARGET), true);
    assert.equal(allowed(OTHER_TARGET), true);
    assert.equal(allowed(STRANGER), false);
  });

  it("an unpinned session allows any target; a missing one allows none", () => {
    const sim = registry();
    sim.send(ROOT, (ctx) => issue(ctx));
    assert.equal(
      sim.read((ctx) => sessionRegistry.isTargetAllowed(ctx, WORKER, KEY, STRANGER)),
      true,
    );
    assert.equal(
      sim.read((ctx) => sessionRegistry.isTargetAllowed(ctx, WORKER, OTHER_KEY, TARGET)),
      false,
    );
    assert.deepEqual(sim.eventNames().includes("SessionTargetsPinned"), false);
  });

  it("revokes once, and only sessions that exist", () => {
    const sim = registry();
    const id = sim.send(ROOT, (ctx) => issue(ctx));
    sim.reverts("SessionNotFound", ROOT, (ctx) => sessionRegistry.revoke(ctx, 99n));
    sim.send(ROOT, (ctx) => sessionRegistry.revoke(ctx, id));
    sim.reverts("AlreadyRevoked", ROOT, (ctx) => sessionRegistry.revoke(ctx, id));
    assert.equal(sim.world.sessionRegistry.activeKeySession[WORKER]![KEY], 0n);
    assert.equal(
      sim.read((ctx) => sessionRegistry.isKeyValid(ctx, WORKER, KEY)),
      false,
    );
    assert.equal(sim.read((ctx) => sessionRegistry.keyLimits(ctx, WORKER, KEY)).valid, false);
    assert.deepEqual(sim.lastEvent("SessionRevoked").args, { sessionId: id, by: ROOT });
  });

  it("expires at expiresAt exactly", () => {
    const sim = registry();
    sim.send(ROOT, (ctx) => issue(ctx));
    sim.warp(HOUR - 1n);
    assert.equal(
      sim.read((ctx) => sessionRegistry.isKeyValid(ctx, WORKER, KEY)),
      true,
    );
    sim.warp(1n);
    assert.equal(
      sim.read((ctx) => sessionRegistry.isKeyValid(ctx, WORKER, KEY)),
      false,
    );
    assert.deepEqual(
      sim.read((ctx) => sessionRegistry.keyLimits(ctx, WORKER, KEY)),
      { valid: false, maxValue: 0n, allowedTarget: ZERO_ADDRESS, scopeMask: 0n },
    );
  });

  it("answers the daily window as [start, end) and true when there is none", () => {
    const sim = registry();
    const within = (key: Address) =>
      sim.read((ctx) => sessionRegistry.withinTimeWindow(ctx, WORKER, key));
    sim.send(ROOT, (ctx) => issue(ctx, OTHER_KEY));
    // T0 is 80 000 seconds into its day.
    sim.send(ROOT, (ctx) =>
      sessionRegistry.issueScopedTimed(
        ctx,
        WORKER,
        KEY,
        ctx.now + ONE_DAY,
        SCOPE_PROPOSE_INTENT,
        MAX_UINT256,
        [],
        80_000n,
        80_100n,
        0n,
        0n,
      ),
    );
    assert.equal(within(OTHER_KEY), true);
    assert.equal(within(STRANGER), true);
    assert.equal(within(KEY), true);
    sim.warp(99n);
    assert.equal(within(KEY), true);
    sim.warp(1n);
    assert.equal(within(KEY), false);
  });

  describe("recordProposal", () => {
    function rated(): Sim {
      const sim = registry();
      sim.send(ROOT, (ctx) =>
        sessionRegistry.issueScopedTimed(
          ctx,
          WORKER,
          KEY,
          ctx.now + ONE_DAY,
          SCOPE_ALL,
          MAX_UINT256,
          [],
          0n,
          0n,
          2n,
          HOUR,
        ),
      );
      return sim;
    }
    const record = (ctx: Ctx) => sessionRegistry.recordProposal(ctx, WORKER, KEY);

    it("is a no-op until a router is wired, then accepts the router only", () => {
      const sim = rated();
      sim.send(STRANGER, record);
      assert.equal(sim.read((ctx) => sessionRegistry.rateLimits(ctx, 1n)).count, 0n);

      sim.reverts("NotAuthorized", STRANGER, (ctx) =>
        sessionRegistry.setEscalationRouter(ctx, ROUTER),
      );
      sim.reverts("ZeroAddress", ROOT, (ctx) =>
        sessionRegistry.setEscalationRouter(ctx, ZERO_ADDRESS),
      );
      sim.send(ROOT, (ctx) => sessionRegistry.setEscalationRouter(ctx, ROUTER));
      sim.reverts("NotAuthorized", STRANGER, record);
      sim.send(ROUTER, record);
      assert.deepEqual(
        sim.read((ctx) => sessionRegistry.rateLimits(ctx, 1n)),
        { maxProposals: 2n, ratePeriod: HOUR, windowStart: T0, count: 1n },
      );
    });

    it("reverts past the limit and resets when the period has elapsed", () => {
      const sim = rated();
      sim.send(ROOT, (ctx) => sessionRegistry.setEscalationRouter(ctx, ROUTER));
      sim.send(ROUTER, record);
      sim.send(ROUTER, record);
      const err = sim.reverts("RateLimitExceeded", ROUTER, record);
      assert.deepEqual(err.args, { agent: WORKER, key: KEY, maxProposals: 2n });
      // The refused proposal was not counted.
      assert.equal(sim.read((ctx) => sessionRegistry.rateLimits(ctx, 1n)).count, 2n);

      sim.warp(HOUR - 1n);
      sim.reverts("RateLimitExceeded", ROUTER, record);
      sim.warp(1n);
      sim.send(ROUTER, record);
      assert.deepEqual(
        sim.read((ctx) => sessionRegistry.rateLimits(ctx, 1n)),
        { maxProposals: 2n, ratePeriod: HOUR, windowStart: T0 + HOUR, count: 1n },
      );
    });

    it("ignores keys with no session and sessions with no limit", () => {
      const sim = registry();
      sim.send(ROOT, (ctx) => sessionRegistry.setEscalationRouter(ctx, ROUTER));
      sim.send(ROOT, (ctx) => issue(ctx));
      for (let i = 0; i < 5; i++) {
        sim.send(ROUTER, record);
        sim.send(ROUTER, (ctx) => sessionRegistry.recordProposal(ctx, WORKER, OTHER_KEY));
      }
      assert.deepEqual(sim.world.sessionRegistry.rateLimits, {});
    });
  });
});
