import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  BLOCKS_MAX,
  BLOCK_TEXT_MAX,
  BlockError,
  looksInternal,
  normalizeBlocks,
  parseSafeUrl,
  refsOfBlocks,
  summarizeBlocks,
} from "./messageBlocks.js";

describe("parseSafeUrl", () => {
  it("accepts http and https and exposes the host for the reader", () => {
    const parsed = parseSafeUrl("https://github.com/owner/repo/pull/7");
    assert.equal(parsed.ok, true);
    assert.equal(parsed.ok && parsed.host, "github.com");
  });

  it("refuses schemes that execute or impersonate us", () => {
    // javascript: is script execution. data: is a document a reader would
    // believe came from us.
    for (const url of ["javascript:alert(1)", "data:text/html,<b>hi", "file:///etc/passwd"]) {
      const parsed = parseSafeUrl(url);
      assert.equal(parsed.ok, false, `${url} was accepted`);
      assert.match(parsed.ok ? "" : parsed.reason, /scheme_refused/);
    }
  });

  it("refuses rather than sanitising", () => {
    // Quietly rewriting an author's URL produces a link that works and is not
    // the one they wrote, and neither side can tell.
    assert.equal(parseSafeUrl("not a url").ok, false);
    assert.equal(parseSafeUrl("").ok, false);
  });
});

describe("looksInternal", () => {
  it("flags a label dressed up as one of our surfaces", () => {
    // "Approve intent 12" pointing off-site is a fake button, in text.
    for (const label of ["Approve intent 12", "Open the proposal", "Revoke session"]) {
      assert.equal(looksInternal(label), true, `${label} not flagged`);
    }
  });

  it("leaves ordinary labels alone", () => {
    assert.equal(looksInternal("the CI run"), false);
    assert.equal(looksInternal(undefined), false);
  });
});

describe("normalizeBlocks", () => {
  it("normalizes the shapes an agent actually attaches", () => {
    const blocks = normalizeBlocks([
      { kind: "text", text: "  Found 3 stale PRs.  " },
      {
        kind: "fields",
        items: [
          { label: " repo ", value: " owner/repo " },
          { label: "", value: "" },
        ],
      },
      { kind: "link", url: "https://github.com/owner/repo/pull/7", label: "PR #7" },
      { kind: "code", text: "npm ERR! 1", lang: " bash " },
      { kind: "ref", ref: "intent", id: " 12 " },
    ]);

    assert.deepEqual(blocks, [
      { kind: "text", text: "Found 3 stale PRs." },
      { kind: "fields", items: [{ label: "repo", value: "owner/repo" }] },
      { kind: "link", url: "https://github.com/owner/repo/pull/7", label: "PR #7" },
      { kind: "code", text: "npm ERR! 1", lang: "bash" },
      { kind: "ref", ref: "intent", id: "12" },
    ]);
  });

  it("lets a ref carry nothing but what it points at", () => {
    // A label or an amount here would be the author describing the thing it
    // points at — which is exactly how a button comes to say 5 while resolving
    // 5,000. The surface renders that from the served record instead.
    const [block] = normalizeBlocks([
      { kind: "ref", ref: "intent", id: "12", label: "Approve 5 USDC", amount: "5" },
    ]);
    assert.deepEqual(block, { kind: "ref", ref: "intent", id: "12" });
  });

  it("refuses an unsafe link rather than dropping it silently", () => {
    // An agent whose evidence was discarded should learn that, not discover
    // its message rendered without it.
    assert.throws(
      () => normalizeBlocks([{ kind: "link", url: "javascript:alert(1)" }]),
      BlockError,
    );
  });

  it("refuses an unknown block kind and an unknown ref kind", () => {
    assert.throws(() => normalizeBlocks([{ kind: "html", text: "<b>" }]), /unknown_block_kind/);
    assert.throws(
      () => normalizeBlocks([{ kind: "ref", ref: "wallet", id: "1" }]),
      /unknown_ref_kind/,
    );
  });

  it("names the offending block so an agent can fix it", () => {
    assert.throws(
      () => normalizeBlocks([{ kind: "text", text: "fine" }, { kind: "link", url: "nope" }]),
      /block\[1\]/,
    );
  });

  it("holds its ceilings", () => {
    assert.throws(
      () => normalizeBlocks(Array.from({ length: BLOCKS_MAX + 1 }, () => ({ kind: "text", text: "x" }))),
      /too_many_blocks/,
    );
    assert.throws(
      () => normalizeBlocks([{ kind: "text", text: "x".repeat(BLOCK_TEXT_MAX + 1) }]),
      /text_too_long/,
    );
    assert.throws(
      () =>
        normalizeBlocks([
          { kind: "fields", items: Array.from({ length: 13 }, (_, i) => ({ label: `l${i}`, value: "v" })) },
        ]),
      /too_many_fields/,
    );
  });

  it("refuses a block that would carry nothing", () => {
    assert.throws(() => normalizeBlocks([{ kind: "text", text: "   " }]), /text_required/);
    assert.throws(() => normalizeBlocks([{ kind: "fields", items: [] }]), /fields_required/);
    assert.throws(() => normalizeBlocks([{ kind: "ref", ref: "intent", id: " " }]), /ref_id_required/);
  });

  it("has no block whose contract is to render markup", () => {
    // The door this shape exists to keep shut: text stays text, and a surface
    // escapes it.
    const [block] = normalizeBlocks([{ kind: "text", text: "<script>alert(1)</script>" }]);
    assert.deepEqual(block, { kind: "text", text: "<script>alert(1)</script>" });
  });
});

describe("refsOfBlocks / summarizeBlocks", () => {
  it("collects internal references for a surface to resolve up front", () => {
    const blocks = normalizeBlocks([
      { kind: "text", text: "done" },
      { kind: "ref", ref: "intent", id: "12" },
      { kind: "ref", ref: "proposal", id: "3" },
    ]);
    assert.deepEqual(refsOfBlocks(blocks), [
      { kind: "intent", id: "12" },
      { kind: "proposal", id: "3" },
    ]);
  });

  it("summarizes for a surface with no room for the blocks", () => {
    const blocks = normalizeBlocks([
      { kind: "text", text: "a" },
      { kind: "ref", ref: "intent", id: "1" },
      { kind: "link", url: "https://example.com" },
    ]);
    assert.equal(summarizeBlocks(blocks), "1 ref · 1 link · 1 text");
    assert.equal(summarizeBlocks([]), "");
  });
});
