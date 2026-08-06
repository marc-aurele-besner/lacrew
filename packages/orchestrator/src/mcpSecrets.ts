/**
 * Credentials an attached MCP server reads, when nobody can set an env var
 * (PRD F2.30).
 *
 * The rest of this feature names credentials rather than carrying them: a
 * server config holds the *name* of an environment variable, the value is read
 * at call time, and a config is therefore safe to store, serve and log. That
 * works because whoever writes the config also owns the process's environment.
 *
 * On a shared worker they are different people. A workspace attaching a server
 * cannot set an env var on a runtime that other workspaces are also using, and
 * an operator who provisions one credential per tenant by hand does not scale
 * past the first few. The honest options were: refuse bring-your-own-token
 * outright, or give the worker somewhere to keep a tenant's credential that is
 * not its environment. This is the second.
 *
 * What it is:
 *
 * - **A named, owner-scoped, sealed value.** A server config references
 *   `{ kind: "secret", secretRef }` — still a name, not a value — and the value
 *   lives here, sealed with AES-256-GCM at rest (`secretBox.ts`, the same
 *   envelope and the same key that seals session keys; the trust boundary is
 *   identical, and a second key would be a second thing to lose).
 * - **Never readable back.** There is no route, no view, and no log line that
 *   returns a value. A surface can learn that one is set and see its last four
 *   characters, which is enough to confirm *which* credential is installed.
 * - **Scoped like a server.** A secret carries the scope that wrote it, and a
 *   server may only resolve one whose owner matches its own. Two workspaces
 *   both calling their token `gh` get two rows; neither can reach the other's,
 *   and a server owned by nobody in particular (the operator's boot config) can
 *   only read the operator's own.
 *
 * What it is not: a general secret store. It resolves credentials for external
 * MCP servers and nothing else — no flow step, model call, or connector reads
 * from here, because widening it later is a decision somebody should have to
 * make deliberately rather than inherit.
 *
 * **Sealing is mandatory.** With no sealing key the write is refused rather
 * than stored in cleartext: a customer credential in a database column is the
 * exact outcome this exists to prevent, and "it worked in dev" is how it would
 * get there.
 */

import type { ProtocolEvent } from "@lacrew/core";
import type { ExternalMcpScope } from "./externalMcp.js";
import { externalMcpScopeKey } from "./externalMcp.js";
import { isSealedSecret, seal, sessionSealingAvailable, unseal } from "./secretBox.js";

/** A stored credential. `sealed` is an envelope; nothing here is cleartext. */
export type McpSecretRecord = {
  /** Caller-chosen name a server config references. Unique per owner. */
  ref: string;
  /** Who may reference it. Absent = the operator's own, like a boot config. */
  owner?: ExternalMcpScope;
  /** `secretBox` envelope as JSON. Never a value, in this process or the store. */
  sealed: string;
  /** Last four characters of the value: which credential, never the credential. */
  hint: string;
  at: string;
};

/** A secret as it is safe to publish. Deliberately has no value field at all. */
export type McpSecretView = {
  ref: string;
  owner?: ExternalMcpScope;
  hint: string;
  at: string;
};

export interface McpSecretStore {
  loadMcpSecrets(): Promise<McpSecretRecord[]>;
  saveMcpSecret(record: McpSecretRecord): Promise<void>;
  removeMcpSecret(ownerKey: string, ref: string): Promise<void>;
}

export type McpSecretsSurface = {
  /** Store or replace a credential. Throws when sealing is unavailable. */
  put(input: { ref: string; value: string; owner?: ExternalMcpScope }): Promise<McpSecretView>;
  /** Forget one. False when this owner has no such ref. */
  remove(ref: string, owner?: ExternalMcpScope): Promise<boolean>;
  /** Refs and hints an owner may see. Never a value. */
  describe(owner?: ExternalMcpScope): McpSecretView[];
  /**
   * The value, for the transport to use at call time.
   *
   * `owner` is the *server's* scope, not the caller's: a server resolves only
   * secrets written under its own owner. Undefined when there is no such secret
   * or it belongs to somebody else — the two are the same answer on purpose.
   */
  read(ref: string, owner?: ExternalMcpScope): string | undefined;
  /** Whether a ref resolves for this owner, without decrypting anything. */
  has(ref: string, owner?: ExternalMcpScope): boolean;
  hydrate(): Promise<number>;
};

export type McpSecretsOptions = {
  store?: McpSecretStore;
  onEvent?: (event: ProtocolEvent) => void;
  now?: () => Date;
};

/** Raised when a credential would have to be stored in cleartext. */
export class McpSecretSealingUnavailableError extends Error {
  constructor() {
    super(
      "mcp_secret_sealing_unavailable: set LACREW_SESSION_KEY (32 random bytes, base64) before " +
        "storing a credential; it is refused rather than written in cleartext",
    );
    this.name = "McpSecretSealingUnavailableError";
  }
}

const OPERATOR = "operator";

/** Storage key for an owner scope. The operator's own secrets sit under their own key. */
export function mcpSecretOwnerKey(owner?: ExternalMcpScope): string {
  return owner ? externalMcpScopeKey(owner) : OPERATOR;
}

/** `ref` is a name in a namespace somebody else can also write to; keep it boring. */
export function validateMcpSecretRef(ref: string): string[] {
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(ref)) {
    return [`secret ref "${ref}" must be 1–64 lowercase letters, digits, dashes or underscores`];
  }
  return [];
}

function hintOf(value: string): string {
  return value.length <= 4 ? "••••" : value.slice(-4);
}

export function createMcpSecrets(opts: McpSecretsOptions = {}): McpSecretsSurface {
  const now = opts.now ?? (() => new Date());
  const records = new Map<string, McpSecretRecord>();
  const key = (ownerKey: string, ref: string): string => `${ownerKey}|${ref}`;

  const audit = (action: string, payload: Record<string, unknown>): void => {
    opts.onEvent?.({
      type: "ExternalMcpSecretChanged",
      at: now().toISOString(),
      payload: { action, ...payload },
    });
  };

  const viewOf = (record: McpSecretRecord): McpSecretView => ({
    ref: record.ref,
    ...(record.owner ? { owner: record.owner } : {}),
    hint: record.hint,
    at: record.at,
  });

  return {
    put: async ({ ref, value, owner }) => {
      const errors = validateMcpSecretRef(ref);
      if (errors.length > 0) throw new Error(`invalid_mcp_secret: ${errors.join("; ")}`);
      if (!value.trim()) throw new Error("invalid_mcp_secret: a credential cannot be empty");
      if (!sessionSealingAvailable()) throw new McpSecretSealingUnavailableError();
      const record: McpSecretRecord = {
        ref,
        ...(owner ? { owner } : {}),
        sealed: JSON.stringify(seal(value)),
        hint: hintOf(value),
        at: now().toISOString(),
      };
      records.set(key(mcpSecretOwnerKey(owner), ref), record);
      await opts.store?.saveMcpSecret(record);
      // The hint, not the value — the trail says which credential was installed
      // and when, which is what an incident needs, and nothing more.
      audit("set", {
        ref,
        hint: record.hint,
        ...(owner ? { owner: externalMcpScopeKey(owner) } : {}),
      });
      return viewOf(record);
    },

    remove: async (ref, owner) => {
      const ownerKey = mcpSecretOwnerKey(owner);
      const existed = records.delete(key(ownerKey, ref));
      if (!existed) return false;
      await opts.store?.removeMcpSecret(ownerKey, ref);
      audit("cleared", { ref, ...(owner ? { owner: ownerKey } : {}) });
      return true;
    },

    describe: (owner) => {
      const ownerKey = mcpSecretOwnerKey(owner);
      return [...records.values()]
        .filter((record) => mcpSecretOwnerKey(record.owner) === ownerKey)
        .sort((a, b) => a.ref.localeCompare(b.ref))
        .map(viewOf);
    },

    has: (ref, owner) => records.has(key(mcpSecretOwnerKey(owner), ref)),

    read: (ref, owner) => {
      // Owner key only — deliberately no fallback to the operator's namespace.
      // A workspace that could resolve an operator secret by guessing its name
      // would be reading the pool's own credentials, which is precisely the
      // escalation the env-var allowlist exists to prevent; letting it in
      // through a second door would be worse for being less visible. An
      // operator sharing a credential does it with `LACREW_MCP_ALLOW_ENV`,
      // where the sharing is written down.
      const record = records.get(key(mcpSecretOwnerKey(owner), ref));
      if (!record) return undefined;
      try {
        const parsed = JSON.parse(record.sealed) as unknown;
        if (!isSealedSecret(parsed)) return undefined;
        return unseal(parsed);
      } catch (err) {
        // Loud, and still undefined: an unreadable credential must fail the
        // call rather than silently send an unauthenticated request that the
        // far side answers with an empty list.
        console.error(
          `[@lacrew/orchestrator] mcp secret "${ref}" could not be read:`,
          err instanceof Error ? err.message.split("\n")[0] : err,
        );
        return undefined;
      }
    },

    hydrate: async () => {
      if (!opts.store) return 0;
      const loaded = await opts.store.loadMcpSecrets();
      for (const record of loaded) {
        records.set(key(mcpSecretOwnerKey(record.owner), record.ref), record);
      }
      return loaded.length;
    },
  };
}
