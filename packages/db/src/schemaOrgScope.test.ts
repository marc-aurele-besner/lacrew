/**
 * Every table is scoped by org, and no key can collide across orgs.
 *
 * One database holds many orgs. A table added without `org_id`, or with a key
 * that leaves it out, would let one org read or overwrite another's rows, so
 * the rule is checked over the whole schema rather than remembered per table.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as schema from "./schema/index.js";

const tables = Object.entries(schema as Record<string, unknown>).flatMap(([exportName, value]) =>
  value instanceof PgTable ? [{ exportName, config: getTableConfig(value) }] : [],
);

describe("schema org scope", () => {
  it("finds the tables", () => {
    assert.ok(tables.length >= 25, `only ${tables.length} tables exported from the schema index`);
  });

  for (const { exportName, config } of tables) {
    describe(`${config.name} (${exportName})`, () => {
      it("has a not-null text org_id", () => {
        const column = config.columns.find((c) => c.name === "org_id");
        assert.ok(column, "no org_id column");
        assert.equal(column.notNull, true, "org_id is nullable");
        assert.equal(column.getSQLType(), "text");
      });

      it("includes org_id in every key", () => {
        const names = (columns: Array<{ name?: string }>) => columns.map((c) => c.name);
        // A surrogate serial id identifies a row and nothing else: it cannot
        // collide across orgs, so it is the one key allowed to stand alone.
        const serial = (cols: (string | undefined)[]) =>
          cols.length === 1 &&
          config.columns.find((c) => c.name === cols[0])?.getSQLType() === "serial";
        const keys: Array<{ what: string; columns: (string | undefined)[] }> = [
          ...config.columns
            .filter((c) => c.primary)
            .map((c) => ({ what: `primary key ${c.name}`, columns: [c.name] })),
          ...config.columns
            .filter((c) => c.isUnique)
            .map((c) => ({ what: `unique ${c.name}`, columns: [c.name] })),
          ...config.primaryKeys.map((pk) => ({
            what: "composite primary key",
            columns: names(pk.columns),
          })),
          ...config.uniqueConstraints.map((u) => ({
            what: `unique ${u.name}`,
            columns: names(u.columns),
          })),
          ...config.indexes
            .filter((i) => i.config.unique)
            .map((i) => ({
              what: `unique index ${i.config.name}`,
              columns: names(i.config.columns as Array<{ name?: string }>),
            })),
        ];
        assert.ok(keys.length > 0, "no key at all");
        for (const key of keys) {
          if (serial(key.columns)) continue;
          assert.ok(
            key.columns.includes("org_id"),
            `${key.what} (${key.columns.join(", ")}) leaves org_id out`,
          );
        }
      });
    });
  }
});
