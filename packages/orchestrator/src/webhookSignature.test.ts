import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  generateWebhookSecret,
  isWebhookScheme,
  signGithubDelivery,
  signLacrewDelivery,
  verifyWebhookSignature,
} from "./webhookSignature.js";

const SECRET = "s3cr3t-webhook-key";
const BODY = JSON.stringify({ action: "opened", pull_request: { number: 7 } });
const NOW_MS = 1_800_000_000_000;
const NOW_SEC = Math.floor(NOW_MS / 1000);

function headers(map: Record<string, string>): (name: string) => string | undefined {
  return (name) => map[name.toLowerCase()];
}

describe("webhook signatures", () => {
  it("accepts a correctly signed lacrew delivery", () => {
    const check = verifyWebhookSignature({
      scheme: "lacrew",
      secret: SECRET,
      rawBody: BODY,
      nowMs: NOW_MS,
      header: headers({
        [SIGNATURE_HEADER.lacrew]: signLacrewDelivery(SECRET, NOW_SEC, BODY),
        [TIMESTAMP_HEADER]: String(NOW_SEC),
      }),
    });
    assert.deepEqual(check, { ok: true });
  });

  it("refuses a body that changed after signing", () => {
    const check = verifyWebhookSignature({
      scheme: "lacrew",
      secret: SECRET,
      rawBody: `${BODY} `,
      nowMs: NOW_MS,
      header: headers({
        [SIGNATURE_HEADER.lacrew]: signLacrewDelivery(SECRET, NOW_SEC, BODY),
        [TIMESTAMP_HEADER]: String(NOW_SEC),
      }),
    });
    assert.deepEqual(check, { ok: false, reason: "signature_invalid" });
  });

  it("refuses a signature minted with a different secret", () => {
    const check = verifyWebhookSignature({
      scheme: "lacrew",
      secret: SECRET,
      rawBody: BODY,
      nowMs: NOW_MS,
      header: headers({
        [SIGNATURE_HEADER.lacrew]: signLacrewDelivery("rotated-away", NOW_SEC, BODY),
        [TIMESTAMP_HEADER]: String(NOW_SEC),
      }),
    });
    assert.deepEqual(check, { ok: false, reason: "signature_invalid" });
  });

  it("reports a missing signature apart from an invalid one", () => {
    assert.deepEqual(
      verifyWebhookSignature({
        scheme: "lacrew",
        secret: SECRET,
        rawBody: BODY,
        nowMs: NOW_MS,
        header: headers({ [TIMESTAMP_HEADER]: String(NOW_SEC) }),
      }),
      { ok: false, reason: "signature_missing" },
    );
    assert.deepEqual(
      verifyWebhookSignature({
        scheme: "lacrew",
        secret: SECRET,
        rawBody: BODY,
        nowMs: NOW_MS,
        header: headers({
          [SIGNATURE_HEADER.lacrew]: "sha256=nothex",
          [TIMESTAMP_HEADER]: String(NOW_SEC),
        }),
      }),
      { ok: false, reason: "signature_malformed" },
    );
  });

  it("refuses a replay outside the tolerance window, in both directions", () => {
    const stale = NOW_SEC - 3_600;
    assert.deepEqual(
      verifyWebhookSignature({
        scheme: "lacrew",
        secret: SECRET,
        rawBody: BODY,
        nowMs: NOW_MS,
        toleranceSec: 300,
        header: headers({
          [SIGNATURE_HEADER.lacrew]: signLacrewDelivery(SECRET, stale, BODY),
          [TIMESTAMP_HEADER]: String(stale),
        }),
      }),
      { ok: false, reason: "timestamp_stale" },
    );

    const future = NOW_SEC + 3_600;
    assert.deepEqual(
      verifyWebhookSignature({
        scheme: "lacrew",
        secret: SECRET,
        rawBody: BODY,
        nowMs: NOW_MS,
        toleranceSec: 300,
        header: headers({
          [SIGNATURE_HEADER.lacrew]: signLacrewDelivery(SECRET, future, BODY),
          [TIMESTAMP_HEADER]: String(future),
        }),
      }),
      { ok: false, reason: "timestamp_stale" },
    );
  });

  it("answers signature_invalid, not timestamp_stale, for an unsigned stale request", () => {
    // Otherwise the endpoint tells an unauthenticated caller how far off its
    // clock is, which is a free oracle for forging a fresh-looking replay.
    const stale = NOW_SEC - 3_600;
    const check = verifyWebhookSignature({
      scheme: "lacrew",
      secret: SECRET,
      rawBody: BODY,
      nowMs: NOW_MS,
      toleranceSec: 300,
      header: headers({
        [SIGNATURE_HEADER.lacrew]: `sha256=${"0".repeat(64)}`,
        [TIMESTAMP_HEADER]: String(stale),
      }),
    });
    assert.deepEqual(check, { ok: false, reason: "signature_invalid" });
  });

  it("requires a timestamp on the lacrew scheme", () => {
    assert.deepEqual(
      verifyWebhookSignature({
        scheme: "lacrew",
        secret: SECRET,
        rawBody: BODY,
        nowMs: NOW_MS,
        header: headers({
          [SIGNATURE_HEADER.lacrew]: signLacrewDelivery(SECRET, NOW_SEC, BODY),
        }),
      }),
      { ok: false, reason: "timestamp_missing" },
    );
  });

  it("verifies the github scheme over the body alone", () => {
    assert.deepEqual(
      verifyWebhookSignature({
        scheme: "github",
        secret: SECRET,
        rawBody: BODY,
        nowMs: NOW_MS,
        header: headers({ [SIGNATURE_HEADER.github]: signGithubDelivery(SECRET, BODY) }),
      }),
      { ok: true },
    );
    assert.deepEqual(
      verifyWebhookSignature({
        scheme: "github",
        secret: SECRET,
        rawBody: BODY,
        nowMs: NOW_MS,
        // A lacrew-shaped signature must not verify here: the schemes cover
        // different material, and accepting either would let a producer's
        // timestamp be stripped without changing the outcome.
        header: headers({
          [SIGNATURE_HEADER.github]: signLacrewDelivery(SECRET, NOW_SEC, BODY),
        }),
      }),
      { ok: false, reason: "signature_invalid" },
    );
  });

  it("generates distinct, URL-safe secrets", () => {
    const a = generateWebhookSecret();
    const b = generateWebhookSecret();
    assert.notEqual(a, b);
    assert.match(a, /^[A-Za-z0-9_-]+$/);
    assert.ok(a.length >= 40);
  });

  it("recognizes only the schemes it can verify", () => {
    assert.equal(isWebhookScheme("lacrew"), true);
    assert.equal(isWebhookScheme("github"), true);
    assert.equal(isWebhookScheme("stripe"), false);
    assert.equal(isWebhookScheme(undefined), false);
  });
});
