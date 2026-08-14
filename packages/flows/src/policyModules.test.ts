import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parsePolicyModuleListing,
  policyModuleAddressOn,
  policyModuleFitsSlot,
  validatePolicyModulePayload,
} from "./policyModules.js";
import { firstPartyPolicyModules, getPolicyModuleListing } from "./policyModuleLibrary.js";

const MODULE = "0x8A791620dd6260079BF849Dc5567aDC3F2FdC318";

const listing = {
  id: "office-hours",
  version: "1.0.0",
  name: "Office hours",
  summary: "DENY outside 09:00–17:00 UTC.",
  deployments: [{ chainId: 31337, address: MODULE }],
  slots: ["worker_agent"],
};

/* ——— validation ——— */

test("a well-formed listing validates and normalizes", () => {
  const result = validatePolicyModulePayload({ ...listing, name: "  Office hours  " });
  assert.equal(result.ok, true);
  assert.equal(result.listing?.name, "Office hours");
  assert.equal(result.listing?.deployments.length, 1);
  // Absent audit is a claim of nothing, which the catalog labels unverified.
  assert.equal(result.listing?.audit.status, "unaudited");
});

test("non-objects are rejected", () => {
  for (const bad of [null, undefined, "x", 3, []]) {
    assert.equal(validatePolicyModulePayload(bad).ok, false);
  }
});

test("identity fields are required", () => {
  for (const key of ["id", "version", "name", "summary"] as const) {
    const result = validatePolicyModulePayload({ ...listing, [key]: "  " });
    assert.equal(result.ok, false, `${key} should be required`);
    assert.ok(result.errors.some((e) => e.startsWith(key)));
  }
  assert.equal(validatePolicyModulePayload({ ...listing, id: "Office Hours" }).ok, false);
});

test("a listing must resolve to a module — address or standard, never both or neither", () => {
  const neither = validatePolicyModulePayload({ ...listing, deployments: [] });
  assert.equal(neither.ok, false);
  assert.ok(neither.errors.some((e) => e.includes("at least one chain")));

  const both = validatePolicyModulePayload({ ...listing, standardModule: "time_window" });
  assert.equal(both.ok, false);
  assert.ok(both.errors.some((e) => e.includes("carries no deployments")));

  const standard = validatePolicyModulePayload({
    ...listing,
    standardModule: "time_window",
    deployments: [],
  });
  assert.equal(standard.ok, true);
  assert.equal(standard.listing?.standardModule, "time_window");

  assert.equal(
    validatePolicyModulePayload({ ...listing, standardModule: "rate_limit", deployments: [] }).ok,
    false,
  );
});

test("an address that would brick a node's stack is refused", () => {
  // A zero or malformed member makes every `check` revert once governance
  // binds the stack, which is the failure the whole address check exists for.
  const zero = validatePolicyModulePayload({
    ...listing,
    deployments: [{ chainId: 31337, address: "0x0000000000000000000000000000000000000000" }],
  });
  assert.equal(zero.ok, false);
  assert.ok(zero.errors.some((e) => e.includes("zero address")));

  assert.equal(
    validatePolicyModulePayload({
      ...listing,
      deployments: [{ chainId: 31337, address: "0xdeadbeef" }],
    }).ok,
    false,
  );
});

test("a chain may be listed once", () => {
  const dupe = validatePolicyModulePayload({
    ...listing,
    deployments: [
      { chainId: 8453, address: MODULE },
      { chainId: 8453, address: "0x1111111111111111111111111111111111111111" },
    ],
  });
  assert.equal(dupe.ok, false);
  assert.ok(dupe.errors.some((e) => e.includes("listed twice")));

  assert.equal(
    validatePolicyModulePayload({ ...listing, deployments: [{ chainId: 0, address: MODULE }] }).ok,
    false,
  );
});

test("slots name the seats the author wrote it for", () => {
  assert.equal(validatePolicyModulePayload({ ...listing, slots: [] }).ok, false);
  assert.equal(validatePolicyModulePayload({ ...listing, slots: undefined }).ok, false);
  assert.equal(validatePolicyModulePayload({ ...listing, slots: ["human_root"] }).ok, false);
  const deduped = validatePolicyModulePayload({
    ...listing,
    slots: ["worker_agent", "worker_agent", "org_default"],
  });
  assert.deepEqual(deduped.listing?.slots, ["worker_agent", "org_default"]);
});

test("audit and source claims are shaped, not believed", () => {
  const bad = validatePolicyModulePayload({ ...listing, audit: { status: "audited" } });
  assert.equal(bad.ok, false);

  const ok = validatePolicyModulePayload({
    ...listing,
    audit: { status: "self-attested", notes: "Reviewed in-house.", url: "https://example.com/a" },
    sourceUrl: "https://example.com/src",
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.listing?.audit.status, "self-attested");

  assert.equal(
    validatePolicyModulePayload({ ...listing, sourceUrl: "javascript:alert(1)" }).ok,
    false,
  );
  assert.equal(
    validatePolicyModulePayload({ ...listing, audit: { status: "unaudited", url: "ftp://x/y" } })
      .ok,
    false,
  );
});

test("JSON text parses through the same rules", () => {
  assert.equal(parsePolicyModuleListing(JSON.stringify(listing)).ok, true);
  const broken = parsePolicyModuleListing("{ not json");
  assert.equal(broken.ok, false);
  assert.ok(broken.errors[0]?.includes("not valid JSON"));
});

/* ——— resolution helpers ——— */

test("an address is answered per chain, and a standard listing answers none", () => {
  const parsed = validatePolicyModulePayload(listing).listing!;
  assert.equal(policyModuleAddressOn(parsed, 31337), MODULE);
  assert.equal(policyModuleAddressOn(parsed, 8453), undefined);
  assert.equal(policyModuleFitsSlot(parsed, "worker_agent"), true);
  assert.equal(policyModuleFitsSlot(parsed, "manager_agent"), false);

  const standard = validatePolicyModulePayload({
    ...listing,
    standardModule: "whitelist",
    deployments: [],
  }).listing!;
  assert.equal(policyModuleAddressOn(standard, 31337), undefined);
});

/* ——— first-party library ——— */

test("every shipped listing passes the rules it is published under", () => {
  assert.ok(firstPartyPolicyModules.length > 0);
  for (const entry of firstPartyPolicyModules) {
    const result = validatePolicyModulePayload(entry);
    assert.equal(result.ok, true, `${entry.id}: ${result.errors.join("; ")}`);
    // A shipped entry resolves against the buyer's own address book — hardcoding
    // an address here would be right on one chain and wrong on every other.
    assert.ok(entry.standardModule, `${entry.id} should name a standard module`);
  }
  assert.equal(getPolicyModuleListing("time-window")?.standardModule, "time_window");
  assert.equal(getPolicyModuleListing("nope"), undefined);
});
