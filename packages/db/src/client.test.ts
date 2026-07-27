import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  assertValidSchemaName,
  checkDbReady,
  getDatabaseSchema,
  getDatabaseUrl,
} from "./client.js";
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

describe("DATABASE_SCHEMA", () => {
  it("is undefined when unset or blank, so the default stays `public`", () => {
    const prev = process.env.DATABASE_SCHEMA;
    try {
      delete process.env.DATABASE_SCHEMA;
      assert.equal(getDatabaseSchema(), undefined);
      process.env.DATABASE_SCHEMA = "   ";
      assert.equal(getDatabaseSchema(), undefined);
      process.env.DATABASE_SCHEMA = " tenant_a ";
      assert.equal(getDatabaseSchema(), "tenant_a");
    } finally {
      if (prev === undefined) delete process.env.DATABASE_SCHEMA;
      else process.env.DATABASE_SCHEMA = prev;
    }
  });

  it("refuses a schema name it would otherwise interpolate into SQL", () => {
    // The name reaches `CREATE SCHEMA` and `search_path` as text, and may
    // arrive from a control plane naming a tenant. Config that cannot be used
    // safely should stop the boot rather than be quoted into submission.
    for (const bad of [
      "public; drop table orchestrator_audit_events",
      'tenant"a',
      "tenant-a",
      "Tenant",
      "1tenant",
      "",
      "t".repeat(64),
    ]) {
      assert.throws(() => assertValidSchemaName(bad), /DATABASE_SCHEMA/, bad);
    }
  });

  it("accepts the shape a tenant schema actually takes", () => {
    for (const ok of ["public", "tenant_a", "lacrew_ten_01hxyz", "_x", "t".repeat(63)]) {
      assert.equal(assertValidSchemaName(ok), ok);
    }
  });
});
