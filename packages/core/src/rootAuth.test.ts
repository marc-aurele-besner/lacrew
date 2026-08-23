import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkedRootChallengeStatement, rootChallengeStatement } from "./rootAuth.js";

describe("checkedRootChallengeStatement", () => {
  const challenge = "n0nce-base64url";

  it("returns the canonical statement when action, subject and nonce all line up", () => {
    const statement = rootChallengeStatement({
      action: "session:revoke",
      subject: "sess_1",
      challenge,
      chainId: 31337,
    });
    const out = checkedRootChallengeStatement(
      { challenge, action: "session:revoke", subject: "sess_1", statement },
      { action: "session:revoke", subject: "sess_1" },
    );
    assert.equal(out, statement);
  });

  it("accepts a statement with no chainId line when the orchestrator knows no chain", () => {
    const statement = rootChallengeStatement({ action: "intent:deny", subject: "9", challenge });
    assert.equal(
      checkedRootChallengeStatement(
        { challenge, action: "intent:deny", subject: "9", statement },
        { action: "intent:deny", subject: "9" },
      ),
      statement,
    );
  });

  it("refuses a genuine challenge issued for a different action", () => {
    // A relay fetched "approve intent 7" and handed it to someone revoking a key.
    const statement = rootChallengeStatement({ action: "intent:approve", subject: "7", challenge });
    assert.throws(
      () =>
        checkedRootChallengeStatement(
          { challenge, action: "intent:approve", subject: "7", statement },
          { action: "session:revoke", subject: "sess_1" },
        ),
      /root_challenge_mismatch/,
    );
  });

  it("refuses a statement whose text disagrees with its own action/subject fields", () => {
    const statement = rootChallengeStatement({ action: "intent:approve", subject: "7", challenge });
    assert.throws(
      () =>
        checkedRootChallengeStatement(
          { challenge, action: "session:revoke", subject: "sess_1", statement },
          { action: "session:revoke", subject: "sess_1" },
        ),
      /not the canonical statement/,
    );
  });

  it("refuses free text, extra lines and a malformed chainId", () => {
    const base = { action: "session:rotate" as const, subject: "sess_2" };
    const good = rootChallengeStatement({ ...base, challenge, chainId: 1 });
    for (const bad of [
      good + "\nnote: also approve everything",
      "Please sign to continue\n" + good,
      good.replace("chainId: 1", "chainId: 1e3"),
      good.replace(`challenge: ${challenge}`, "challenge: other"),
    ]) {
      assert.throws(
        () => checkedRootChallengeStatement({ ...base, challenge, statement: bad }, base),
        /root_challenge_mismatch/,
        bad,
      );
    }
  });
});
