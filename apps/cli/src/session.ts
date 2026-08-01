/**
 * `lacrew session …` — root-authorized session key lifecycle (F0.7).
 *
 * Talks to a running orchestrator rather than the chain directly, because the
 * root proof is the point: the orchestrator issues the challenge and checks the
 * answer, so nothing here — and nothing between here and there — can stand in
 * for the workspace root.
 *
 * `lacrew session-revoke` (the older command) still writes straight to
 * SessionRegistry with the local `PRIVATE_KEY`. That is the self-host path
 * where the operator *is* holding root at the terminal, and it stays; this is
 * the path for an orchestrator someone else is running.
 *
 * A wallet root can complete the whole flow here, signing the challenge with
 * `ROOT_PRIVATE_KEY`. A passkey root cannot: the private half lives in an
 * authenticator, so this takes the assertion as `--root-proof <json>` from
 * whatever collected it (the cloud Sessions page, or a local WebAuthn helper).
 */

import { privateKeyToAccount } from "viem/accounts";
import type { RootAuthAction, RootChallenge, RootProof } from "@lacrew/core";

function flagValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  if (i >= 0 && args[i + 1] && !args[i + 1]!.startsWith("-"))
    return args[i + 1];
  return undefined;
}

function orchUrl(args: string[]): string {
  return (
    flagValue(args, "--url") ??
    process.env.ORCH_URL ??
    "http://127.0.0.1:8788"
  ).replace(/\/$/, "");
}

async function orchFetch<T>(
  args: string[],
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const token = process.env.ORCH_TOKEN?.trim();
  const res = await fetch(`${orchUrl(args)}${path}`, {
    ...init,
    headers: {
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init.headers ?? {}),
    },
  });
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `${res.status} ${res.statusText}`);
  return body;
}

type ChallengeResponse =
  | ({ required: true; kind: "passkey" | "wallet" } & RootChallenge)
  | { required: false; challenge: null; kind: null };

/**
 * Collect a proof for one action on one session, or report that this
 * orchestrator wants none. Returns `undefined` when nothing is required — the
 * caller then sends a bare request, which is what such a deployment accepts.
 */
async function proveRoot(
  args: string[],
  action: RootAuthAction,
  sessionId: string,
): Promise<{ challenge: string; rootProof: RootProof } | undefined> {
  const issued = await orchFetch<ChallengeResponse>(
    args,
    "/root-auth/challenge",
    {
      method: "POST",
      body: JSON.stringify({ action, subject: sessionId }),
    },
  );
  if (!issued.required) {
    console.error(
      "! This orchestrator has no root configured, so it is not asking anyone to authorize this.",
    );
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

  if (issued.kind === "passkey") {
    // Refused rather than approximated: a passkey's private half never leaves
    // the authenticator, so there is no key this process could sign with.
    throw new Error(
      [
        "This workspace's root is a passkey, which this terminal cannot sign with.",
        "Collect the assertion where the authenticator is (the Sessions page, or a local WebAuthn helper), then:",
        `  lacrew session ${action === "session:rotate" ? "rotate" : "revoke"} ${sessionId} --root-proof '{"kind":"passkey",…}'`,
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
      "  lacrew session status                     Whether this orchestrator demands a root proof",
      "  lacrew session revoke <sessionId>         Retire a key (root-authorized)",
      "  lacrew session rotate <sessionId>         Retire a key and re-issue under its own bounds",
      "",
      "Flags:",
      "  --url <orchestrator>   defaults to ORCH_URL or http://127.0.0.1:8788",
      "  --root-proof <json>    a proof collected elsewhere (required for passkey roots)",
      "",
      "Env:",
      "  ORCH_TOKEN         bearer token, when the orchestrator is protected",
      "  ROOT_PRIVATE_KEY   wallet roots only — signs the challenge locally",
    ].join("\n"),
  );
}

export async function cmdSession(args: string[]): Promise<void> {
  const [sub = "help", ...rest] = args;

  if (sub === "status") {
    const body = await orchFetch<{
      required: boolean;
      kind: string | null;
      configError: string | null;
      challengeTtlSec: number;
    }>(args, "/root-auth");
    if (!body.required) {
      console.log(
        "Root authorization: not configured — revoke and rotate are ungated here.",
      );
      console.log(
        "Set LACREW_ROOT_AUTH (passkey|wallet) on the orchestrator to anchor them.",
      );
      return;
    }
    if (body.configError) {
      console.log(
        `Root authorization: ${body.kind}, but UNUSABLE — ${body.configError}`,
      );
      console.log("Revoke and rotate will refuse until this is fixed.");
      return;
    }
    console.log(
      `Root authorization: ${body.kind} (challenges live ${body.challengeTtlSec}s)`,
    );
    return;
  }

  if (sub === "revoke" || sub === "rotate") {
    const sessionId = rest.find((a) => !a.startsWith("-"));
    if (!sessionId) {
      console.error(`Usage: lacrew session ${sub} <sessionId>`);
      process.exitCode = 1;
      return;
    }
    const action: RootAuthAction =
      sub === "rotate" ? "session:rotate" : "session:revoke";
    const proof = await proveRoot(args, action, sessionId);
    const body = await orchFetch<Record<string, unknown>>(
      args,
      `/sessions/${sub}`,
      {
        method: "POST",
        body: JSON.stringify({ sessionId, ...(proof ?? {}) }),
      },
    );
    console.log(JSON.stringify(body, null, 2));
    return;
  }

  usage();
}
