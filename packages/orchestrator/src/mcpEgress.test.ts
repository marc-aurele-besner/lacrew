import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  checkMcpEgress,
  checkMcpEgressResolves,
  envNameMatches,
  hostMatchesPattern,
  isPrivateAddressLiteral,
  loadMcpEgressPolicyFromEnv,
  OPEN_MCP_EGRESS,
  type McpEgressPolicy,
} from "./mcpEgress.js";

const hosted = (over: Partial<McpEgressPolicy> = {}): McpEgressPolicy => ({
  hosted: true,
  allowHosts: ["mcp.example.com"],
  allowStdio: false,
  allowLoopback: false,
  allowEnv: [],
  ...over,
});

const http = (url: string, envVars: string[] = []) => ({
  transport: "http" as const,
  url,
  envVars,
});

test("a self-host refuses nothing it was not told to refuse", () => {
  assert.equal(checkMcpEgress(http("https://anything.example.com/rpc"), OPEN_MCP_EGRESS).ok, true);
  assert.equal(checkMcpEgress({ transport: "stdio" }, OPEN_MCP_EGRESS).ok, true);
  // Loopback over plain http is the local-dev case and stays reachable.
  assert.equal(checkMcpEgress(http("http://127.0.0.1:9000/rpc"), OPEN_MCP_EGRESS).ok, true);
});

test("a self-host that wrote an allowlist gets the allowlist it wrote", () => {
  const policy: McpEgressPolicy = { ...OPEN_MCP_EGRESS, allowHosts: ["mcp.example.com"] };
  assert.equal(checkMcpEgress(http("https://mcp.example.com/rpc"), policy).ok, true);
  const denied = checkMcpEgress(http("https://elsewhere.example.com/rpc"), policy);
  assert.equal(denied.ok, false);
  assert.equal(denied.ok === false && denied.reason, "host_not_allowlisted");
});

test("a hosted worker refuses a subprocess server", () => {
  const verdict = checkMcpEgress({ transport: "stdio" }, hosted());
  assert.equal(verdict.ok, false);
  assert.equal(verdict.ok === false && verdict.reason, "stdio_not_allowed");
  // A single-tenant deployment can turn it back on deliberately.
  assert.equal(checkMcpEgress({ transport: "stdio" }, hosted({ allowStdio: true })).ok, true);
});

test("a hosted worker reaches allowlisted hosts and nothing else", () => {
  assert.equal(checkMcpEgress(http("https://mcp.example.com/rpc"), hosted()).ok, true);
  const off = checkMcpEgress(http("https://evil.example.net/rpc"), hosted());
  assert.equal(off.ok === false && off.reason, "host_not_allowlisted");
});

test("a hosted worker with no allowlist reaches nothing, and says which knob", () => {
  const verdict = checkMcpEgress(http("https://mcp.example.com/rpc"), hosted({ allowHosts: [] }));
  assert.equal(verdict.ok, false);
  assert.equal(verdict.ok === false && verdict.reason, "no_allowlist_configured");
  assert.match(verdict.ok === false ? verdict.detail : "", /LACREW_MCP_ALLOW_HOSTS/);
});

test("a hosted worker refuses the perimeter it sits inside, allowlist or not", () => {
  for (const [url, host] of [
    ["http://127.0.0.1:8788/rpc", "127.0.0.1"],
    ["https://169.254.169.254/latest/meta-data", "169.254.169.254"],
    ["https://10.0.0.5/rpc", "10.0.0.5"],
    ["https://[fd00::1]/rpc", "fd00::1"],
    ["https://192.168.1.10/rpc", "192.168.1.10"],
  ] as const) {
    // The host is on the allowlist and still refused: an operator who pasted an
    // internal address into the allowlist has not thereby made it a third party.
    const verdict = checkMcpEgress(http(url), hosted({ allowHosts: [host] }));
    assert.equal(verdict.ok, false, `${url} should be refused`);
  }
});

test("plain http is refused off loopback whatever the allowlist says", () => {
  const verdict = checkMcpEgress(http("http://mcp.example.com/rpc"), hosted());
  assert.equal(verdict.ok === false && verdict.reason, "scheme_not_allowed");
});

test("a credential smuggled into the url is refused rather than carried", () => {
  const verdict = checkMcpEgress(http("https://user:pass@mcp.example.com/rpc"), hosted());
  assert.equal(verdict.ok === false && verdict.reason, "url_credentials");
});

test("a runtime attach may only name env vars the operator offered", () => {
  const policy = hosted({ allowEnv: ["TENANT_MCP_*"] });
  const refused = checkMcpEgress(
    http("https://mcp.example.com/rpc", ["GITHUB_TOKEN"]),
    policy,
    "runtime",
  );
  assert.equal(refused.ok === false && refused.reason, "env_not_allowlisted");
  assert.equal(
    checkMcpEgress(http("https://mcp.example.com/rpc", ["TENANT_MCP_GH"]), policy, "runtime").ok,
    true,
  );
  // The operator's own boot config names whatever it likes: it is theirs.
  assert.equal(
    checkMcpEgress(http("https://mcp.example.com/rpc", ["GITHUB_TOKEN"]), policy, "env").ok,
    true,
  );
});

test("with no env offered at all, a runtime attach carries no credential", () => {
  const verdict = checkMcpEgress(
    http("https://mcp.example.com/rpc", ["ANY_TOKEN"]),
    hosted(),
    "runtime",
  );
  assert.equal(verdict.ok === false && verdict.reason, "env_not_allowlisted");
  assert.match(verdict.ok === false ? verdict.detail : "", /offers none/);
});

test("host patterns match a subdomain, an exact name, and a pinned port", () => {
  assert.equal(hostMatchesPattern("a.example.com", "443", "*.example.com"), true);
  assert.equal(hostMatchesPattern("a.b.example.com", "443", "*.example.com"), true);
  // The bare apex is not a subdomain of itself: an operator allowing
  // `*.example.com` did not necessarily mean `example.com`.
  assert.equal(hostMatchesPattern("example.com", "443", "*.example.com"), false);
  assert.equal(hostMatchesPattern("example.com", "443", "example.com"), true);
  assert.equal(hostMatchesPattern("example.com", "8443", "example.com:8443"), true);
  assert.equal(hostMatchesPattern("example.com", "443", "example.com:8443"), false);
  // A near-miss suffix must not slip through the subdomain rule.
  assert.equal(hostMatchesPattern("notexample.com", "443", "*.example.com"), false);
});

test("private address literals are recognised in both families", () => {
  for (const address of [
    "127.0.0.1",
    "10.1.2.3",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.0.1",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "::1",
    "fd00::1",
    "fe80::1",
    "::ffff:10.0.0.1",
  ]) {
    assert.equal(isPrivateAddressLiteral(address), true, `${address} is private`);
  }
  for (const address of ["8.8.8.8", "172.32.0.1", "93.184.216.34", "2606:2800::1"]) {
    assert.equal(isPrivateAddressLiteral(address), false, `${address} is public`);
  }
});

test("an allowlisted hostname that resolves inside is refused before the socket", async () => {
  const policy = hosted();
  const target = http("https://mcp.example.com/rpc");
  const inside = await checkMcpEgressResolves(target, policy, async () => ["169.254.169.254"]);
  assert.equal(inside.ok === false && inside.reason, "host_private_address");
  const outside = await checkMcpEgressResolves(target, policy, async () => ["93.184.216.34"]);
  assert.equal(outside.ok, true);
  // DNS failing is a connection problem, not a policy verdict — blaming the
  // allowlist for somebody's resolver outage would send an operator the wrong way.
  const broken = await checkMcpEgressResolves(target, policy, async () => {
    throw new Error("ENOTFOUND");
  });
  assert.equal(broken.ok, true);
});

test("env name patterns are exact or prefixed, never a bare wildcard match", () => {
  assert.equal(envNameMatches("GH_TOKEN", "GH_TOKEN"), true);
  assert.equal(envNameMatches("GH_TOKEN", "GH_"), false);
  assert.equal(envNameMatches("GH_TOKEN", "GH_*"), true);
  assert.equal(envNameMatches("OTHER", "GH_*"), false);
});

test("the environment reads hosted as deny-first and self-host as today", () => {
  const pool = loadMcpEgressPolicyFromEnv({
    LACREW_MCP_HOSTED: "1",
    LACREW_MCP_ALLOW_HOSTS: "mcp.example.com, *.tools.example.com",
  });
  assert.equal(pool.hosted, true);
  assert.equal(pool.allowStdio, false);
  assert.equal(pool.allowLoopback, false);
  assert.deepEqual(pool.allowHosts, ["mcp.example.com", "*.tools.example.com"]);

  const selfHost = loadMcpEgressPolicyFromEnv({});
  assert.equal(selfHost.hosted, false);
  assert.equal(selfHost.allowStdio, true);
  assert.equal(selfHost.allowLoopback, true);
  assert.deepEqual(selfHost.allowHosts, []);
});
