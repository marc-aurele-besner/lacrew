import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getDatabaseUrl } from "@lacrew/db";
import { PgBossQueue } from "./pg-boss.js";

describe("PgBossQueue", () => {
  it("starts and stops against DATABASE_URL", async (t) => {
    if (!getDatabaseUrl()) {
      t.skip("DATABASE_URL not set");
      return;
    }

    const q = new PgBossQueue();
    await q.start();
    const status = q.status();
    assert.equal(status.provider, "pg-boss");
    assert.equal(status.ready, true);

    const id = await q.enqueue("tick", { source: "test" });
    assert.ok(typeof id === "string" || id === null || id !== undefined);

    await q.stop();
    assert.equal(q.status().ready, false);
  });
});
