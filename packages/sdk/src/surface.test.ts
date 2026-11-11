import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import * as root from "./index.js";
import * as sandbox from "./sandbox/index.js";
import * as testing from "./testing/index.js";

/**
 * The package root must not hand out fabricated data.
 *
 * `createLacrewClient` answers every read with an organisation that does not
 * exist — a treasury, an allowance, an audit trail, all invented. It used to
 * sit in the root export, one plausible import away from any production code
 * path, and that is how invented numbers reached real surfaces.
 *
 * This test is the guard on that boundary. If it fails, something moved back.
 */
describe("SDK public surface", () => {
  it("does not export the test client from the package root", () => {
    assert.equal(
      "createLacrewClient" in root,
      false,
      "createLacrewClient belongs to @lacrew/sdk/testing, not the root",
    );
    assert.equal("LacrewClient" in root, false);
  });

  it("does not export demo fixtures from the package root", () => {
    for (const name of [
      "mockOrgNodes",
      "mockAllowances",
      "mockPendingIntents",
      "mockSessionKeys",
      "mockAuditTrail",
    ]) {
      assert.equal(name in root, false, `${name} must not be reachable from the root`);
    }
  });

  it("still exports the onchain client and pure helpers", () => {
    // The flip side: moving the mock must not have taken the real client with it.
    assert.equal(typeof root.createOnchainClient, "function");
    assert.equal(typeof root.simulateIntentAction, "function");
    assert.equal(typeof root.checkClientPolicy, "function");
  });

  it("keeps the test client reachable from ./testing", () => {
    assert.equal(typeof testing.createLacrewClient, "function");
    assert.ok(Array.isArray(testing.mockOrgNodes));
  });
});

/**
 * The sandbox simulates an org; it must never be mistaken for one.
 *
 * It answers reads with numbers no chain produced, so it sits behind its own
 * subpath for the same reason the test client does. And it is not the test
 * client: it starts from an empty org and may not borrow the demo fixtures,
 * which would put an invented crew in every new sandbox.
 */
describe("SDK sandbox surface", () => {
  it("does not export the sandbox from the package root", () => {
    for (const name of [
      "createSandboxClient",
      "SandboxLacrewClient",
      "SandboxNeedsChainError",
      "SimRevert",
      "kernel",
      "manualClock",
      "systemClock",
    ]) {
      assert.equal(name in root, false, `${name} belongs to @lacrew/sdk/sandbox, not the root`);
    }
  });

  it("exports the sandbox from ./sandbox, declared as a package subpath", () => {
    assert.equal(typeof sandbox.createSandboxClient, "function");
    assert.equal(typeof sandbox.kernel.genesis, "function");
    const pkg = JSON.parse(
      readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
    ) as { exports: Record<string, { import: string; types: string }> };
    assert.deepEqual(pkg.exports["./sandbox"], {
      types: "./dist/sandbox/index.d.ts",
      import: "./dist/sandbox/index.js",
    });
  });

  it("imports nothing from the test client or its fixtures", () => {
    const dir = fileURLToPath(new URL("./sandbox/", import.meta.url));
    const sources = (readdirSync(dir, { recursive: true }) as string[]).filter(
      (file) => file.endsWith(".ts") && !file.endsWith(".test.ts"),
    );
    assert.ok(sources.length >= 15, "the sandbox sources were not found");
    for (const file of sources) {
      const text = readFileSync(`${dir}/${file}`, "utf8");
      const specifiers = [...text.matchAll(/(?:from|import)\s*\(?\s*"([^"]+)"/g)].map((m) => m[1]!);
      for (const specifier of specifiers) {
        assert.equal(
          /testing|fixtures|mock/i.test(specifier),
          false,
          `sandbox/${file} imports ${specifier}`,
        );
      }
    }
  });
});
