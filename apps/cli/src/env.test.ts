import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadEnvFile, parseEnvFile } from "./env.js";

test("parses assignments, skipping comments and blanks", () => {
  const parsed = parseEnvFile(
    ["# comment", "", "LACREW_ORG_REGISTRY=0xabc", "export PORT=8788", "  SPACED = value  "].join(
      "\n",
    ),
  );
  assert.deepEqual(parsed, {
    LACREW_ORG_REGISTRY: "0xabc",
    PORT: "8788",
    SPACED: "value",
  });
});

test("strips matched surrounding quotes", () => {
  const parsed = parseEnvFile(['A="quoted"', "B='single'", 'C=un"even'].join("\n"));
  assert.equal(parsed.A, "quoted");
  assert.equal(parsed.B, "single");
  assert.equal(parsed.C, 'un"even');
});

test("keeps '=' inside values (connection strings)", () => {
  const parsed = parseEnvFile("DATABASE_URL=postgres://u:p@h/db?sslmode=require");
  assert.equal(parsed.DATABASE_URL, "postgres://u:p@h/db?sslmode=require");
});

test("blank assignments are not exported as empty strings", () => {
  const dir = mkdtempSync(join(tmpdir(), "lacrew-env-"));
  const path = join(dir, ".env");
  // .env.example ships blank placeholders; forge reads an empty PRIVATE_KEY
  // as a malformed key rather than falling back to its Anvil default.
  writeFileSync(path, "LACREW_TEST_BLANK=\nLACREW_TEST_SET=value\n");

  try {
    const applied = loadEnvFile(path);
    assert.equal(process.env.LACREW_TEST_BLANK, undefined);
    assert.equal(process.env.LACREW_TEST_SET, "value");
    assert.deepEqual(applied, ["LACREW_TEST_SET"]);
  } finally {
    delete process.env.LACREW_TEST_SET;
  }
});

test("missing file is a no-op", () => {
  assert.deepEqual(loadEnvFile(join(tmpdir(), "lacrew-absent-.env")), []);
});

test("does not clobber values already in process.env", () => {
  const dir = mkdtempSync(join(tmpdir(), "lacrew-env-"));
  const path = join(dir, ".env");
  writeFileSync(path, "LACREW_TEST_PRESET=from-file\nLACREW_TEST_FRESH=from-file\n");

  const saved = process.env.LACREW_TEST_PRESET;
  try {
    process.env.LACREW_TEST_PRESET = "from-shell";
    const applied = loadEnvFile(path);

    assert.equal(process.env.LACREW_TEST_PRESET, "from-shell");
    assert.equal(process.env.LACREW_TEST_FRESH, "from-file");
    assert.deepEqual(applied, ["LACREW_TEST_FRESH"]);
  } finally {
    if (saved === undefined) delete process.env.LACREW_TEST_PRESET;
    else process.env.LACREW_TEST_PRESET = saved;
    delete process.env.LACREW_TEST_FRESH;
  }
});
