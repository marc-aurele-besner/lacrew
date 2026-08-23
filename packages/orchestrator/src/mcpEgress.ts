/**
 * Where an attached MCP server is allowed to live (PRD F2.30).
 *
 * `externalMcp.ts` decides whether a *tool* may be called. This file decides
 * whether the orchestrator may open a connection to the far side at all, and
 * the two are separate on purpose: a tool allowlist protects a workspace from
 * what a server can do, an egress allowlist protects the *worker* from where a
 * server is. On a single-tenant self-host those collapse into one operator's
 * judgement. On a hosted pool they do not — the process runs somebody else's
 * crews, and "attach a server" is an instruction from a tenant.
 *
 * Two threats shape everything here.
 *
 * **A subprocess is code execution.** A stdio server is a binary the worker
 * runs with the worker's own filesystem and network. That is a fine trade on a
 * machine the operator owns and an unacceptable one on a shared worker, so
 * under `LACREW_MCP_HOSTED=1` stdio is refused unless the operator explicitly
 * turns it back on for a single-tenant deployment.
 *
 * **A URL is a request from inside the perimeter.** An orchestrator sits where
 * a cloud's metadata service, a database, and every other tenant's internal
 * endpoint are reachable, so an attacker who can name a URL has an SSRF
 * primitive. The answer is a **default-deny host allowlist**: hosted mode
 * reaches the hosts the operator wrote down and nothing else, which also means
 * a hostname that resolves somewhere unpleasant is only reachable if the
 * operator already vouched for it. On top of that, private and link-local
 * address literals are refused outright, and — best-effort — a hostname is
 * resolved before connecting so an allowlisted name pointing at `169.254.169.254`
 * is caught too. That last check is TOCTOU-imperfect by nature (DNS can change
 * between the check and the socket); the allowlist, not the lookup, is the
 * boundary that holds.
 *
 * The env-name rule is the third leg. Credentials are named rather than
 * carried, which is safe when the operator writes the names down and a
 * privilege escalation when a tenant does: naming `GITHUB_TOKEN` on a shared
 * worker would hand a stranger the operator's credential through a server they
 * control. So a **runtime** attach may only name env vars the operator listed;
 * a config the operator wrote at boot is unrestricted, because it is theirs.
 */

/** Every refusal this file can produce, as a stable machine-readable reason. */
export type McpEgressRefusal =
  | "stdio_not_allowed"
  | "url_invalid"
  | "url_credentials"
  | "scheme_not_allowed"
  | "host_not_allowlisted"
  | "host_private_address"
  | "no_allowlist_configured"
  | "env_not_allowlisted";

export type McpEgressVerdict =
  { ok: true } | { ok: false; reason: McpEgressRefusal; detail: string };

export type McpEgressPolicy = {
  /**
   * The process runs more than one workspace's crews. Flips every default to
   * deny; a self-host leaves it off and keeps today's behaviour.
   */
  hosted: boolean;
  /**
   * Hostnames a server may live on. `example.com` is exact; `*.example.com`
   * matches any depth of subdomain; either may carry `:port` to pin one port.
   * Empty under `hosted` means nothing is reachable, which is the correct
   * state for a pool whose operator has not decided yet.
   */
  allowHosts: string[];
  /** Run subprocess servers. Refused under `hosted` unless turned back on. */
  allowStdio: boolean;
  /** Permit loopback endpoints (and plain http on them) under `hosted`. */
  allowLoopback: boolean;
  /**
   * Env var names a **runtime-attached** server may read, as exact names or
   * `PREFIX_*`. Empty means a runtime attach carries no credential at all.
   */
  allowEnv: string[];
};

/** Where a server config came from — an operator's boot config, or an API call. */
export type McpServerOrigin = "env" | "runtime";

/** Self-host defaults: the operator owns the machine, so nothing is refused. */
export const OPEN_MCP_EGRESS: McpEgressPolicy = {
  hosted: false,
  allowHosts: [],
  allowStdio: true,
  allowLoopback: true,
  allowEnv: [],
};

const list = (raw: string | undefined): string[] =>
  (raw ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

/**
 * Read the policy from the environment.
 *
 * `LACREW_MCP_HOSTED=1` is the one switch that matters; the rest narrow or
 * widen from there. A pool provider sets these on the worker rather than
 * trusting each control plane in front of it to ask nicely.
 */
export function loadMcpEgressPolicyFromEnv(
  env: Record<string, string | undefined> = process.env,
): McpEgressPolicy {
  const hosted = env.LACREW_MCP_HOSTED === "1";
  return {
    hosted,
    allowHosts: list(env.LACREW_MCP_ALLOW_HOSTS).map((host) => host.toLowerCase()),
    // Under hosted the flag must be set explicitly; self-host keeps stdio.
    allowStdio: hosted ? env.LACREW_MCP_ALLOW_STDIO === "1" : env.LACREW_MCP_ALLOW_STDIO !== "0",
    allowLoopback: hosted ? env.LACREW_MCP_ALLOW_LOOPBACK === "1" : true,
    allowEnv: list(env.LACREW_MCP_ALLOW_ENV),
  };
}

/** Strip the brackets Node's URL parser keeps around an IPv6 literal. */
function bareHost(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

function isLoopbackHost(host: string): boolean {
  const bare = bareHost(host).toLowerCase();
  return bare === "localhost" || bare === "127.0.0.1" || bare === "::1" || bare.startsWith("127.");
}

function ipv4Private(octets: number[]): boolean {
  const [a = 0, b = 0, c = 0] = octets;
  if (a === 0 || a === 127) return true; // this host, loopback
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true; // link-local, incl. cloud metadata
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier NAT
  if (a === 192 && b === 0 && c === 0) return true; // IETF protocol assignments
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a >= 224) return true; // multicast and reserved
  return false;
}

function parseIpv4(host: string): number[] | null {
  const parts = host.split(".");
  if (parts.length !== 4) return null;
  const octets = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : NaN));
  return octets.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) ? octets : null;
}

/**
 * Whether a host is an address literal in a range that never belongs to a
 * third-party MCP server. Hostnames are not judged here — that is the
 * allowlist's job, and guessing from a name would be theatre.
 */
export function isPrivateAddressLiteral(host: string): boolean {
  const bare = bareHost(host).toLowerCase();
  const v4 = parseIpv4(bare);
  if (v4) return ipv4Private(v4);
  if (!bare.includes(":")) return false; // a name, not an address
  // IPv4-mapped and IPv4-compatible forms carry the real address in the tail —
  // dotted (`::ffff:10.0.0.1`) or, as Node's URL parser renders it, as two hex
  // groups (`::ffff:a00:1`); `64:ff9b::/96` (NAT64) embeds it the same way.
  const tail = bare.slice(bare.lastIndexOf(":") + 1);
  const mapped = parseIpv4(tail);
  if (mapped) return ipv4Private(mapped);
  const hexMapped = /^(?:::ffff|64:ff9b::?)(?::0)*:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(bare);
  if (hexMapped) {
    const hi = Number.parseInt(hexMapped[1]!, 16);
    const lo = Number.parseInt(hexMapped[2]!, 16);
    return ipv4Private([hi >> 8, hi & 0xff, lo >> 8, lo & 0xff]);
  }
  if (bare === "::" || bare === "::1") return true;
  const head = Number.parseInt(bare.split(":")[0] ?? "", 16);
  if (!Number.isFinite(head)) return false;
  if ((head & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
  if ((head & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  return false;
}

/** `example.com`, `*.example.com`, either optionally `:port`-pinned. */
export function hostMatchesPattern(host: string, port: string, pattern: string): boolean {
  const normalised = pattern.trim().toLowerCase();
  if (!normalised) return false;
  const colon = normalised.lastIndexOf(":");
  // A colon inside an IPv6 pattern is not a port separator; only a trailing
  // `:1234` on a bracket-free pattern is.
  const hasPort = colon > 0 && /^\d+$/.test(normalised.slice(colon + 1));
  const wantPort = hasPort ? normalised.slice(colon + 1) : undefined;
  const hostPattern = hasPort ? normalised.slice(0, colon) : normalised;
  if (wantPort !== undefined && wantPort !== port) return false;
  const target = bareHost(host).toLowerCase();
  if (hostPattern.startsWith("*.")) {
    const suffix = hostPattern.slice(1); // keeps the leading dot
    return target.endsWith(suffix) && target.length > suffix.length;
  }
  return target === bareHost(hostPattern);
}

/** The effective port for a URL, since `URL.port` is empty on a default one. */
function portOf(url: URL): string {
  if (url.port) return url.port;
  return url.protocol === "https:" ? "443" : "80";
}

export type McpEgressTarget = {
  transport: "http" | "stdio";
  url?: string;
  /** Env var names the config reads. Checked only for a runtime attach. */
  envVars?: string[];
};

/**
 * May this orchestrator connect to this server?
 *
 * Returns a reason rather than throwing: every caller here has a different way
 * to say no — a boot config refusal is a startup error, a runtime attach is a
 * 403, a call is an audit row — and each needs the reason in its own shape.
 */
export function checkMcpEgress(
  target: McpEgressTarget,
  policy: McpEgressPolicy,
  origin: McpServerOrigin = "env",
): McpEgressVerdict {
  if (origin === "runtime") {
    const named = target.envVars ?? [];
    const unlisted = named.filter(
      (name) => !policy.allowEnv.some((pattern) => envNameMatches(name, pattern)),
    );
    if (unlisted.length > 0) {
      return {
        ok: false,
        reason: "env_not_allowlisted",
        detail:
          `this orchestrator does not offer ${unlisted.join(", ")} to an attached server` +
          (policy.allowEnv.length === 0
            ? " (it offers none; a credential has to be provisioned by the operator)"
            : ` (offered: ${policy.allowEnv.join(", ")})`),
      };
    }
  }

  if (target.transport === "stdio") {
    if (policy.allowStdio) return { ok: true };
    return {
      ok: false,
      reason: "stdio_not_allowed",
      detail:
        "a stdio server is a subprocess on the worker, which is code execution on a machine " +
        "running other workspaces' crews; attach it over http, or self-host",
    };
  }

  let url: URL;
  try {
    url = new URL(target.url ?? "");
  } catch {
    return { ok: false, reason: "url_invalid", detail: `${target.url ?? ""} is not a URL` };
  }
  if (url.username || url.password) {
    // A credential in the URL is carried rather than named, lands in every log
    // line that prints an endpoint, and cannot be rotated without an edit here.
    return {
      ok: false,
      reason: "url_credentials",
      detail: "a url may not carry a username or password; name an env var instead",
    };
  }

  const loopback = isLoopbackHost(url.hostname);
  if (
    url.protocol !== "https:" &&
    !(url.protocol === "http:" && loopback && policy.allowLoopback)
  ) {
    return {
      ok: false,
      reason: "scheme_not_allowed",
      detail: `${url.protocol}//… is refused; use https (plain http only reaches loopback)`,
    };
  }
  if (loopback && !policy.allowLoopback) {
    return {
      ok: false,
      reason: "host_private_address",
      detail: "loopback is the worker itself, not a third party's server",
    };
  }
  if (!loopback && isPrivateAddressLiteral(url.hostname)) {
    return {
      ok: false,
      reason: "host_private_address",
      detail: `${url.hostname} is a private or link-local address, reachable only from inside`,
    };
  }

  // Self-host: an allowlist is honoured when the operator wrote one, and its
  // absence means "anywhere", which is what a machine they own already allows.
  if (!policy.hosted) return policy.allowHosts.length === 0 ? { ok: true } : matches();
  if (loopback) return { ok: true }; // already gated by allowLoopback above
  if (policy.allowHosts.length === 0) {
    return {
      ok: false,
      reason: "no_allowlist_configured",
      detail:
        "this orchestrator is hosted and has no MCP egress allowlist, so it reaches no external " +
        "server; the operator sets LACREW_MCP_ALLOW_HOSTS",
    };
  }
  return matches();

  function matches(): McpEgressVerdict {
    const port = portOf(url);
    const hit = policy.allowHosts.some((pattern) =>
      hostMatchesPattern(url.hostname, port, pattern),
    );
    if (hit) return { ok: true };
    return {
      ok: false,
      reason: "host_not_allowlisted",
      detail: `${url.host} is not on this orchestrator's MCP egress allowlist`,
    };
  }
}

/** `NAME` or `PREFIX_*`. Case-sensitive, as env var names are. */
export function envNameMatches(name: string, pattern: string): boolean {
  const p = pattern.trim();
  if (!p) return false;
  if (p.endsWith("*")) return name.startsWith(p.slice(0, -1));
  return name === p;
}

/**
 * Resolve a hostname and refuse a private answer.
 *
 * Best-effort second line behind the allowlist: an operator who allowlists
 * `*.corp.example` and a tenant who points `mcp.corp.example` at the metadata
 * service is the case this catches. DNS can still change between here and the
 * socket, so this narrows the window rather than closing it — the reason the
 * allowlist is default-deny and not a blocklist.
 */
export async function checkMcpEgressResolves(
  target: McpEgressTarget,
  policy: McpEgressPolicy,
  lookup: (host: string) => Promise<string[]>,
): Promise<McpEgressVerdict> {
  if (target.transport !== "http") return { ok: true };
  let url: URL;
  try {
    url = new URL(target.url ?? "");
  } catch {
    return { ok: false, reason: "url_invalid", detail: `${target.url ?? ""} is not a URL` };
  }
  if (isLoopbackHost(url.hostname)) {
    return policy.allowLoopback
      ? { ok: true }
      : {
          ok: false,
          reason: "host_private_address",
          detail: "loopback is the worker itself, not a third party's server",
        };
  }
  let addresses: string[];
  try {
    addresses = await lookup(bareHost(url.hostname));
  } catch {
    // An unresolvable host is a connection error, not a policy verdict; saying
    // "blocked" here would blame the allowlist for somebody's DNS outage.
    return { ok: true };
  }
  const bad = addresses.find((address) => isPrivateAddressLiteral(address));
  if (!bad) return { ok: true };
  return {
    ok: false,
    reason: "host_private_address",
    detail: `${url.hostname} resolves to ${bad}, which is inside the perimeter`,
  };
}

/** The policy as it is safe to publish: decisions, never a credential. */
export function describeMcpEgress(policy: McpEgressPolicy): {
  hosted: boolean;
  allowHosts: string[];
  allowStdio: boolean;
  allowLoopback: boolean;
  allowEnv: string[];
} {
  return {
    hosted: policy.hosted,
    allowHosts: [...policy.allowHosts],
    allowStdio: policy.allowStdio,
    allowLoopback: policy.allowLoopback,
    allowEnv: [...policy.allowEnv],
  };
}
