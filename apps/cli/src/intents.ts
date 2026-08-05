/**
 * `lacrew intents …` — root-authorized approvals through an orchestrator
 * (F2.6 / F1.3).
 *
 * The sibling of `lacrew session revoke|rotate`, and for the same reason: the
 * orchestrator issues the challenge and checks the answer, so nothing here —
 * and nothing between here and there — can stand in for the workspace root.
 *
 * `lacrew approve <id>` (the older command) still writes straight to
 * EscalationRouter with the local `PRIVATE_KEY`. That is the self-host path
 * where the operator *is* the approver at the terminal, and it stays; this is
 * the path for an orchestrator someone else is running, and the only one that
 * can settle an intent awaiting a root this terminal holds no key for.
 *
 * Three roots, three ways in:
 *
 * - **wallet** — signs the challenge here from `ROOT_PRIVATE_KEY`, or takes a
 *   signature made elsewhere as `--root-proof`.
 * - **passkey** — the private half never leaves the authenticator, so the
 *   assertion has to be collected where it is and handed in as `--root-proof`.
 * - **safe-passkey** — the same, with one extra rule the Safe imposes: the
 *   challenge is the Safe transaction's own hash and the ceremony must be run
 *   with `userVerification: "required"`, because the Safe's signer contract
 *   will not accept an assertion without that flag. Where the orchestrator
 *   relays, the approval lands here; where it does not, it hands back the
 *   Safe's transaction for a wallet to send, and `lacrew intents confirm`
 *   records it *after* re-reading the chain.
 */

import { privateKeyToAccount } from "viem/accounts";
import type { RootAuthAction, RootChallenge, RootProof } from "@lacrew/core";

function flagValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  if (i >= 0 && args[i + 1] && !args[i + 1]!.startsWith("-")) return args[i + 1];
  return undefined;
}

function orchUrl(args: string[]): string {
  return (flagValue(args, "--url") ?? process.env.ORCH_URL ?? "http://127.0.0.1:8788").replace(
    /\/$/,
    "",
  );
}

/** The body of a refusal, kept whole so a caller can act on what it carries. */
class OrchRefusal extends Error {
  constructor(
    readonly status: number,
    readonly body: Record<string, unknown>,
  ) {
    super(String(body.error ?? `${status}`));
  }
}

async function orchFetch<T>(args: string[], path: string, init: RequestInit = {}): Promise<T> {
  const token = process.env.ORCH_TOKEN?.trim();
  const res = await fetch(`${orchUrl(args)}${path}`, {
    ...init,
    headers: {
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init.headers ?? {}),
    },
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new OrchRefusal(res.status, body);
  return body as T;
}

type ChallengeResponse =
  | ({
      required: true;
      kind: "passkey" | "wallet" | "safe-passkey";
      safeAddress?: `0x${string}`;
      safeTxHash?: `0x${string}`;
      relayed?: boolean;
    } & RootChallenge)
  | { required: false; challenge: null; kind: null; awaitingApprover?: string | null };

/**
 * Collect a proof for one decision on one intent, or report that none is
 * needed. `undefined` means the intent has not climbed to the root — a
 * manager-depth approval is the manager's to make, and asking for the root's
 * authenticator there would be a prompt operators learn to click through.
 */
async function proveRoot(
  args: string[],
  action: RootAuthAction,
  intentId: string,
): Promise<{ challenge: string; rootProof: RootProof } | undefined> {
  const issued = await orchFetch<ChallengeResponse>(args, "/root-auth/challenge", {
    method: "POST",
    body: JSON.stringify({ action, subject: intentId }),
  });
  if (!issued.required) {
    if (issued.awaitingApprover) {
      console.error(
        `! This intent awaits ${issued.awaitingApprover}, not the workspace root — no root proof is asked for.`,
      );
    } else {
      console.error(
        "! This orchestrator has no root configured, so it is not asking anyone to authorize this.",
      );
    }
    return undefined;
  }

  const supplied = flagValue(args, "--root-proof");
  if (supplied) {
    let parsed: RootProof;
    try {
      parsed = JSON.parse(supplied) as RootProof;
    } catch {
      throw new Error(
        "--root-proof must be a JSON object (a WebAuthn assertion or a wallet signature)",
      );
    }
    return { challenge: issued.challenge, rootProof: parsed };
  }

  const verb = action === "intent:deny" ? "deny" : "approve";
  if (issued.kind === "safe-passkey") {
    // Refused rather than approximated. There is no key here that could sign,
    // and — unlike a bare passkey root — the challenge is a Safe transaction
    // hash, so the assertion is also the signature that moves the money.
    throw new Error(
      [
        `This workspace's root is a Safe owned by a passkey (${issued.safeAddress}).`,
        "The challenge below is that Safe's own transaction hash: signing it both proves the root",
        'and authorizes the transfer, so the ceremony must use userVerification: "required".',
        "",
        "Collect the assertion where the authenticator is, then:",
        `  lacrew intents ${verb} ${intentId} --root-proof '{"kind":"passkey",…}'`,
        "",
        `Challenge to sign: ${issued.challenge}`,
        `Safe transaction:  ${issued.safeTxHash}`,
        issued.relayed
          ? "This orchestrator will broadcast the Safe transaction for you."
          : "This orchestrator relays on no chain, so it will hand the transaction back for you to send.",
      ].join("\n"),
    );
  }

  if (issued.kind === "passkey") {
    throw new Error(
      [
        "This workspace's root is a passkey, which this terminal cannot sign with.",
        "Collect the assertion where the authenticator is (the Approvals inbox, or a local WebAuthn helper), then:",
        `  lacrew intents ${verb} ${intentId} --root-proof '{"kind":"passkey",…}'`,
        "",
        `Challenge to sign: ${issued.challenge}`,
      ].join("\n"),
    );
  }

  const key = process.env.ROOT_PRIVATE_KEY?.trim();
  if (!key) {
    throw new Error(
      [
        "This workspace's root is a wallet. Either:",
        "  - set ROOT_PRIVATE_KEY and re-run, so this command signs the challenge, or",
        '  - sign it elsewhere and pass --root-proof \'{"kind":"wallet","address":"0x…","signature":"0x…"}\'',
        "",
        "Statement to sign (personal_sign, exactly as written):",
        issued.statement,
      ].join("\n"),
    );
  }
  const account = privateKeyToAccount(key as `0x${string}`);
  return {
    challenge: issued.challenge,
    rootProof: {
      kind: "wallet",
      address: account.address,
      signature: await account.signMessage({ message: issued.statement }),
    },
  };
}

function usage(): void {
  console.log(
    [
      "Usage:",
      "  lacrew intents list                       Pending escalations, and who each awaits",
      "  lacrew intents approve <intentId>         Approve (root-authorized where it has climbed)",
      "  lacrew intents deny <intentId>            Refuse the same way",
      "  lacrew intents confirm <intentId>         Record a Safe approval you broadcast yourself",
      "",
      "Flags:",
      "  --url <orchestrator>   defaults to ORCH_URL or http://127.0.0.1:8788",
      "  --root-proof <json>    a proof collected elsewhere (required for passkey roots)",
      "  --approved / --denied  confirm only: which decision the transaction carried",
      "  --tx <0x…>             confirm only: the transaction you broadcast",
      "",
      "Env:",
      "  ORCH_TOKEN         bearer token, when the orchestrator is protected",
      "  ROOT_PRIVATE_KEY   wallet roots only — signs the challenge locally",
    ].join("\n"),
  );
}

/**
 * A Safe approval this orchestrator would not broadcast. Printed rather than
 * thrown away: the transaction is the whole answer, and the operator's own
 * wallet is the sender.
 */
function reportUnsigned(body: Record<string, unknown>, intentId: string): void {
  const tx = body.transaction as { to: string; data: string; value: string } | undefined;
  console.error(
    [
      "This orchestrator relays on no chain, so the root Safe's transaction is yours to send.",
      "Nothing has been approved yet — the intent is still pending.",
      "",
      `Safe transaction hash: ${String(body.safeTxHash ?? "?")}`,
      "Send this, exactly:",
      JSON.stringify(tx ?? {}, null, 2),
      "",
      "Then record it:",
      `  lacrew intents confirm ${intentId} --approved --tx <hash>`,
    ].join("\n"),
  );
}

export async function cmdIntents(args: string[]): Promise<void> {
  const [sub = "help", ...rest] = args;

  if (sub === "list") {
    console.log(JSON.stringify(await orchFetch(args, "/intents"), null, 2));
    return;
  }

  if (sub === "approve" || sub === "deny") {
    const intentId = rest.find((a) => !a.startsWith("-"));
    if (!intentId) {
      console.error(`Usage: lacrew intents ${sub} <intentId>`);
      process.exitCode = 1;
      return;
    }
    const approved = sub === "approve";
    const action: RootAuthAction = approved ? "intent:approve" : "intent:deny";
    const proof = await proveRoot(args, action, intentId);
    try {
      const body = await orchFetch<Record<string, unknown>>(args, "/intents/resolve", {
        method: "POST",
        body: JSON.stringify({ intentId, approved, ...(proof ?? {}) }),
      });
      console.log(JSON.stringify(body, null, 2));
    } catch (err) {
      if (err instanceof OrchRefusal && err.body.error === "safe_exec_unsigned") {
        reportUnsigned(err.body, intentId);
        process.exitCode = 1;
        return;
      }
      throw err;
    }
    return;
  }

  if (sub === "confirm") {
    const intentId = rest.find((a) => !a.startsWith("-"));
    if (!intentId) {
      console.error("Usage: lacrew intents confirm <intentId> --approved|--denied [--tx <hash>]");
      process.exitCode = 1;
      return;
    }
    const denied = args.includes("--denied");
    if (!denied && !args.includes("--approved")) {
      // Never defaulted. The decision is what gets written to the trail, and
      // guessing it would record a refusal as an approval or the reverse.
      console.error("Pass --approved or --denied so the record says what you decided.");
      process.exitCode = 1;
      return;
    }
    const tx = flagValue(args, "--tx");
    const body = await orchFetch<{ confirmed: boolean }>(args, "/intents/confirm", {
      method: "POST",
      body: JSON.stringify({
        intentId,
        approved: !denied,
        ...(tx ? { txHash: tx } : {}),
      }),
    });
    console.log(JSON.stringify(body, null, 2));
    if (!body.confirmed) process.exitCode = 1;
    return;
  }

  usage();
}
