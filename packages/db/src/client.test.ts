import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getDatabaseUrl, checkDbReady } from "./client.js";
import { orchestratorMeta } from "./schema/meta.js";

describe("@lacrew/db", () => {
  it("exports orchestrator_meta schema", () => {
    assert.equal(orchestratorMeta.key.name, "key");
  });

  it("checkDbReady is false without DATABASE_URL", async () => {
    const prev = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      assert.equal(getDatabaseUrl(), undefined);
      assert.equal(await checkDbReady(), false);
    } finally {
      if (prev !== undefined) process.env.DATABASE_URL = prev;
    }
  });
});
