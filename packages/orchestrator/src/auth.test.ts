import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getOrchToken, isAuthorized } from "./auth.js";

describe("isAuthorized", () => {
  it("accepts the exact bearer token", () => {
    assert.equal(isAuthorized("Bearer secret-token", "secret-token"), true);
  });

  it("accepts a case-insensitive Bearer scheme", () => {
    assert.equal(isAuthorized("bearer secret-token", "secret-token"), true);
  });

  it("rejects a wrong token", () => {
    assert.equal(isAuthorized("Bearer wrong", "secret-token"), false);
  });

  it("rejects a same-length wrong token", () => {
    assert.equal(isAuthorized("Bearer aecret-token", "secret-token"), false);
  });

  it("rejects a missing header", () => {
    assert.equal(isAuthorized(undefined, "secret-token"), false);
  });

  it("rejects a non-bearer scheme", () => {
    assert.equal(isAuthorized("Basic secret-token", "secret-token"), false);
  });

  it("rejects an empty header", () => {
    assert.equal(isAuthorized("", "secret-token"), false);
  });
});

describe("getOrchToken", () => {
  it("returns undefined when unset or blank", () => {
    const prev = process.env.LACREW_ORCH_TOKEN;
    try {
      delete process.env.LACREW_ORCH_TOKEN;
      assert.equal(getOrchToken(), undefined);
      process.env.LACREW_ORCH_TOKEN = "   ";
      assert.equal(getOrchToken(), undefined);
      process.env.LACREW_ORCH_TOKEN = " tok ";
      assert.equal(getOrchToken(), "tok");
    } finally {
      if (prev === undefined) delete process.env.LACREW_ORCH_TOKEN;
      else process.env.LACREW_ORCH_TOKEN = prev;
    }
  });
});
