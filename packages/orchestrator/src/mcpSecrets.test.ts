/**
 * Bring-your-own-token for an attached MCP server (F2.30).
 *
 * The claims worth proving here are all negative: a value never comes back out,
 * a workspace cannot reach another's credential by naming it, and a runtime
 * with no sealing key refuses the write rather than storing a customer's token
 * in a database column.
 */

import { strict as assert } from "node:assert";
import { randomBytes } from "node:crypto";
import { after, before, test } from "node:test";
import type { ProtocolEvent } from "@lacrew/core";
import {
  createMcpSecrets,
  mcpSecretOwnerKey,
  validateMcpSecretRef,
  type McpSecretRecord,
} from "./mcpSecrets.js";

const OURS = { level: "crew" as const, ref: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" };
const THEIRS = { level: "crew" as const, ref: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" };

let previousKey: string | undefined;

before(() => {
  previousKey = process.env.LACREW_SESSION_KEY;
  process.env.LACREW_SESSION_KEY = randomBytes(32).toString("base64");
});

after(() => {
  if (previousKey === undefined) delete process.env.LACREW_SESSION_KEY;
  else process.env.LACREW_SESSION_KEY = previousKey;
});

function memoryStore() {
  const rows = new Map<string, McpSecretRecord>();
  return {
    rows,
    loadMcpSecrets: async () => [...rows.values()],
    saveMcpSecret: async (record: McpSecretRecord) => {
      rows.set(`${mcpSecretOwnerKey(record.owner)}|${record.ref}`, record);
    },
    removeMcpSecret: async (ownerKey: string, ref: string) => {
      rows.delete(`${ownerKey}|${ref}`);
    },
  };
}

test("a stored credential is sealed, and never comes back out of a view", async () => {
  const store = memoryStore();
  const events: ProtocolEvent[] = [];
  const secrets = createMcpSecrets({ store, onEvent: (event) => events.push(event) });

  const view = await secrets.put({ ref: "gh", value: "ghp_supersecrettoken", owner: OURS });
  assert.equal(view.ref, "gh");
  // The hint says *which* token without being usable as one.
  assert.equal(view.hint, "oken");
  assert.equal(JSON.stringify(view).includes("ghp_supersecrettoken"), false);
  assert.equal(JSON.stringify(secrets.describe(OURS)).includes("ghp_supersecrettoken"), false);

  const row = [...store.rows.values()][0]!;
  // What lands in the store is an envelope, not the token.
  assert.equal(row.sealed.includes("ghp_supersecrettoken"), false);
  assert.match(row.sealed, /"iv":/);
  assert.equal(JSON.stringify(events).includes("ghp_supersecrettoken"), false);
  assert.equal(events[0]?.type, "ExternalMcpSecretChanged");

  // Only the resolver returns the value, and only to the owning scope.
  assert.equal(secrets.read("gh", OURS), "ghp_supersecrettoken");
});

test("one workspace cannot reach another's credential by naming it", async () => {
  const secrets = createMcpSecrets({ store: memoryStore() });
  await secrets.put({ ref: "gh", value: "ours-token", owner: OURS });
  await secrets.put({ ref: "gh", value: "theirs-token", owner: THEIRS });

  // Same ref, two workspaces, two credentials — neither reads the other's.
  assert.equal(secrets.read("gh", OURS), "ours-token");
  assert.equal(secrets.read("gh", THEIRS), "theirs-token");
  assert.deepEqual(
    secrets.describe(OURS).map((s) => s.hint),
    ["oken"],
  );
  assert.equal(secrets.describe(THEIRS).length, 1);
});

test("a workspace cannot resolve the operator's own credential", async () => {
  const secrets = createMcpSecrets({ store: memoryStore() });
  // The operator's, written with no owner — the shape a boot config has.
  await secrets.put({ ref: "shared-gh", value: "operator-token" });
  assert.equal(secrets.read("shared-gh"), "operator-token");
  // No fallback: guessing an operator ref would be the same escalation the
  // env-var allowlist exists to prevent, arriving through a second door.
  assert.equal(secrets.read("shared-gh", OURS), undefined);
  assert.deepEqual(secrets.describe(OURS), []);
});

test("with no sealing key the write is refused, not stored in cleartext", async () => {
  const key = process.env.LACREW_SESSION_KEY;
  delete process.env.LACREW_SESSION_KEY;
  try {
    const store = memoryStore();
    const secrets = createMcpSecrets({ store });
    await assert.rejects(
      secrets.put({ ref: "gh", value: "ghp_token", owner: OURS }),
      /mcp_secret_sealing_unavailable/,
    );
    assert.equal(store.rows.size, 0);
  } finally {
    process.env.LACREW_SESSION_KEY = key;
  }
});

test("a credential survives a restart, and clearing one is not silent", async () => {
  const store = memoryStore();
  const events: ProtocolEvent[] = [];
  const first = createMcpSecrets({ store, onEvent: (event) => events.push(event) });
  await first.put({ ref: "gh", value: "ghp_token", owner: OURS });

  const restarted = createMcpSecrets({ store });
  assert.equal(await restarted.hydrate(), 1);
  assert.equal(restarted.read("gh", OURS), "ghp_token");

  assert.equal(await restarted.remove("gh", OURS), true);
  assert.equal(restarted.read("gh", OURS), undefined);
  assert.equal(store.rows.size, 0);
  // Removing something that is not there is false, not an error: the caller's
  // next move is the same either way.
  assert.equal(await restarted.remove("gh", OURS), false);
});

test("a ref is a name in a namespace somebody else writes to, so it is bounded", () => {
  assert.deepEqual(validateMcpSecretRef("gh-token"), []);
  assert.deepEqual(validateMcpSecretRef("gh_token_2"), []);
  assert.equal(validateMcpSecretRef("GH").length, 1);
  assert.equal(validateMcpSecretRef("gh token").length, 1);
  assert.equal(validateMcpSecretRef("").length, 1);
  assert.equal(validateMcpSecretRef("a".repeat(65)).length, 1);
});

test("an empty credential is refused rather than stored as a blank token", async () => {
  const secrets = createMcpSecrets({ store: memoryStore() });
  await assert.rejects(secrets.put({ ref: "gh", value: "   " }), /invalid_mcp_secret/);
});
