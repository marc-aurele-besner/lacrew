/**
 * Session keys: who may propose for an agent, and the ceilings the chain puts
 * on a key — scope, value, target, expiry, time of day, rate.
 */

import { BOTH, DAY, HOUR, PROPOSE, SPEND, USDC, scenario, type Scenario } from "../scenario.js";

const MAX_UINT64 = 2n ** 64n - 1n;

export const sessionScenarios: Scenario[] = [
  scenario("anyone but the agent itself needs a valid session key", (b) => {
    b.crew();
    b.proposeReverts("InvalidSession", "key", "worker", "target", 1n);
    b.session();
    b.allow("key", "worker", "target", 1n);
    b.proposeReverts("InvalidSession", "stranger", "worker", "target", 1n);
    // A key is bound to one agent.
    b.proposeReverts("InvalidSession", "key", "manager", "target", 1n);
    b.expect({
      keys: [
        { agent: "worker", key: "key", valid: true },
        { agent: "worker", key: "stranger", valid: false },
        { agent: "manager", key: "key", valid: false },
      ],
    });
  }),

  scenario("session scope: proposing and settling are separate grants", (b) => {
    b.crew();
    b.session({ mask: PROPOSE });
    // An ALLOW would settle, and this key may not.
    b.proposeReverts("SessionScopeDenied", "key", "worker", "target", 1n);
    // An ESCALATE settles nothing, so the same key may raise it.
    const intent = b.escalate("key", "worker", "target", 75n * USDC);
    b.expect({ pending: [intent], allowance: { worker: 200n * USDC } });

    b.session({ key: "key2", mask: SPEND });
    b.proposeReverts("SessionScopeDenied", "key2", "worker", "target", 1n);
    b.proposeReverts("SessionScopeDenied", "key2", "worker", "target", 75n * USDC);

    b.session({ mask: BOTH });
    b.allow("key", "worker", "target", 1n);
  }),

  scenario("session max value and pinned targets", (b) => {
    b.crew();
    b.call("root", "@whitelist", "setAllowed", ["target2", true]);
    b.call("root", "@whitelist", "setAllowed", ["stranger", true]);

    b.session({ maxValue: 5n * USDC, targets: ["target"] });
    b.proposeReverts("SessionValueExceeded", "key", "worker", "target", 5n * USDC + 1n);
    b.proposeReverts("SessionTargetDenied", "key", "worker", "target2", 1n);
    b.allow("key", "worker", "target", 5n * USDC);
    b.expect({ keys: [{ agent: "worker", key: "key", valid: true, maxValue: 5n * USDC }] });

    b.session({ key: "key2", targets: ["target", "target2", "target"] });
    b.allow("key2", "worker", "target", 1n);
    b.allow("key2", "worker", "target2", 1n);
    b.proposeReverts("SessionTargetDenied", "key2", "worker", "stranger", 1n);

    // No key narrows the agent's own propose.
    b.allow("worker", "worker", "stranger", 5n * USDC + 1n);
  }),

  scenario("a session ends at its expiry or when it is revoked", (b) => {
    b.crew();
    // Issued at second I of the run, expiring at I + 3600.
    b.session({ ttl: HOUR });
    b.allow("key", "worker", "target", 1n);
    b.warp(HOUR - 3);
    // Its last second, I + 3599...
    b.allow("key", "worker", "target", 1n);
    b.expect({ keys: [{ agent: "worker", key: "key", valid: true }] });
    // ...and the expiry itself, at which it is already dead.
    b.proposeReverts("InvalidSession", "key", "worker", "target", 1n);
    b.warp(1);
    b.expect({ keys: [{ agent: "worker", key: "key", valid: false }] });

    // Re-issuing the same key retires the session it replaces.
    const second = b.session();
    b.allow("key", "worker", "target", 1n);
    b.reverts("NotAuthorized", "stranger", "@sessions", "revoke", [BigInt(second)]);
    b.call("root", "@sessions", "revoke", [BigInt(second)], { events: ["SessionRevoked"] });
    b.proposeReverts("InvalidSession", "key", "worker", "target", 1n);
    b.reverts("AlreadyRevoked", "root", "@sessions", "revoke", [BigInt(second)]);
    b.reverts("AlreadyRevoked", "root", "@sessions", "revoke", [BigInt(second - 1)]);
    b.reverts("SessionNotFound", "root", "@sessions", "revoke", [99n]);
  }),

  scenario("a session's daily window is [start, end)", (b) => {
    b.crew();
    b.expect({ secondOfDay: 81_010 });
    b.session({ window: [81_015, 81_020], ttl: 3 * DAY });
    // The session was issued at 81 011; the next transaction runs at 81 012.
    b.proposeReverts("SessionTimeWindowDenied", "key", "worker", "target", 1n);
    b.warp(2);
    b.proposeReverts("SessionTimeWindowDenied", "key", "worker", "target", 1n);
    // The window is the key's; the agent itself may still act (at 81 014).
    b.allow("worker", "worker", "target", 1n);
    // 81 015: the start is inside.
    b.allow("key", "worker", "target", 1n);
    b.warp(3);
    // 81 019: the last second inside.
    b.allow("key", "worker", "target", 1n);
    // 81 020: the end is outside.
    b.proposeReverts("SessionTimeWindowDenied", "key", "worker", "target", 1n);
    b.expect({ secondOfDay: 81_019 });
    // A day later: 81 014 is still outside, 81 015 is the start again.
    b.warp(DAY - 6);
    b.proposeReverts("SessionTimeWindowDenied", "key", "worker", "target", 1n);
    b.allow("worker", "worker", "target", 1n);
    b.allow("key", "worker", "target", 1n);
    b.expect({ secondOfDay: 81_015 });
  }),

  scenario("a session's propose rate limit, and its roll-over to the second", (b) => {
    b.crew();
    b.session({ rate: [2, HOUR], ttl: 3 * DAY });
    // The window opens with the first counted propose, at second T.
    b.call("key", "@router", "propose", ["worker", "target", 1n, "0x"], { verdict: "ALLOW" }, [
      "SessionRegistry.recordProposal",
    ]);
    b.escalate("key", "worker", "target", 75n * USDC);
    b.proposeReverts("RateLimitExceeded", "key", "worker", "target", 1n, "SessionRegistry");
    b.warp(HOUR - 3);
    // T + 3599: the last second of the window.
    b.proposeReverts("RateLimitExceeded", "key", "worker", "target", 1n, "SessionRegistry");
    b.warp(1);
    // T + 3600: a new window. A propose that reverts for another reason is not charged to it.
    b.proposeReverts("UnexpectedVerdict", "key", "worker", "target2", 1n);
    b.allow("key", "worker", "target", 1n);
    b.allow("key", "worker", "target", 1n);
    b.proposeReverts("RateLimitExceeded", "key", "worker", "target", 1n, "SessionRegistry");
  }),

  scenario("who may issue a session, and what an issue must look like", (b) => {
    b.reverts("NotAuthorized", "stranger", "@sessions", "issue", [
      "worker",
      "key",
      { fromNow: HOUR },
      BOTH,
      1n,
      "zero",
    ]);
    b.sessionReverts("ZeroAddress", { agent: "zero" });
    b.sessionReverts("ZeroAddress", { key: "zero" });
    b.sessionReverts("InvalidExpiry", { ttl: 0 });
    // One second ahead is the shortest expiry there is.
    b.session({ key: "key2", ttl: 1 });
    b.sessionReverts("InvalidScopeMask", { mask: 0n });
    b.sessionReverts("InvalidScopeMask", { mask: 4n });
    b.sessionReverts("InvalidWindow", { window: [10, 10] });
    b.sessionReverts("InvalidWindow", { window: [0, DAY + 1] });
    b.sessionReverts("InvalidRateLimit", { rate: [3, 0] });
    b.sessionReverts("InvalidRateLimit", { rate: [0, 60] });
    b.sessionReverts("ZeroAddress", { targets: ["target", "zero"] });

    // A dedicated issuer, bound by a ceiling the root is not.
    b.reverts("NotAuthorized", "stranger", "@sessions", "setIssuer", ["issuer"]);
    b.reverts("ZeroAddress", "root", "@sessions", "setIssuer", ["zero"]);
    b.call("root", "@sessions", "setIssuer", ["issuer"]);
    b.session({ from: "issuer", ttl: 30 * DAY });
    b.sessionReverts("ExpiryExceedsIssuerTtl", { from: "issuer", ttl: 30 * DAY + 1 });
    b.session({ key: "key2", ttl: 365 * DAY });

    b.reverts("NotAuthorized", "issuer", "@sessions", "setMaxIssuerTtl", [BigInt(HOUR)]);
    b.reverts("ZeroTtl", "root", "@sessions", "setMaxIssuerTtl", [0n]);
    b.call("root", "@sessions", "setMaxIssuerTtl", [BigInt(HOUR)]);
    b.sessionReverts("ExpiryExceedsIssuerTtl", { from: "issuer", ttl: HOUR + 1 });
    b.session({ from: "issuer", ttl: HOUR });

    // The ceiling is added to the timestamp in 64 bits, checked.
    b.call("root", "@sessions", "setMaxIssuerTtl", [MAX_UINT64]);
    b.sessionReverts("Panic", { from: "issuer" });

    b.reverts("NotAuthorized", "stranger", "@sessions", "setEscalationRouter", ["@router"]);
    b.reverts("ZeroAddress", "root", "@sessions", "setEscalationRouter", ["zero"]);
    b.call("root", "@sessions", "setEscalationRouter", ["@router"]);
    // Only the router counts proposals into a key's window.
    b.reverts("NotAuthorized", "stranger", "@sessions", "recordProposal", ["worker", "key"]);
    b.expect({
      keys: [
        { agent: "worker", key: "key", valid: true },
        { agent: "worker", key: "key2", valid: true },
      ],
    });
  }),
];
