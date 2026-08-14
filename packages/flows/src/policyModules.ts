/**
 * Policy-module listings: a third-party `IPolicyModule` as a marketplace
 * payload (PRD F3.1).
 *
 * `IPolicyModule` is the protocol's extension point — `check(agent, target,
 * value, data)` returning ALLOW / ESCALATE / DENY, stacked per node, first DENY
 * wins. Anyone can write one and deploy it; what has been missing is a way to
 * *distribute* one, so a guardrail somebody wrote is discoverable and payable
 * the way a flow is.
 *
 * ## What a listing is not
 *
 * It is not an install. Buying a module moves USDC and grants the buyer the
 * payload; it binds nothing. Binding is `EscalationRouter.setNodePolicy`, which
 * is constitutional — a marketplace purchase that rewrote a node's stack would
 * hand a seller the one power the org votes on. The orchestrator's attach path
 * (`proposeAttachPolicyModule`) therefore produces a governance proposal and
 * stops there, and the stack the org voted stays in force until the proposal
 * executes.
 *
 * ## Addresses, not bytecode
 *
 * A listing points at a module that is **already deployed** — the cloud never
 * compiles or deploys a seller's bytecode, so there is no path from "published
 * a listing" to "ran code in the orchestrator". A first-party listing names a
 * `standardModule` instead, resolved against the buyer's own address book, so
 * the shipped example is real on every deployment rather than correct only on
 * the chain whose address got hardcoded.
 *
 * ## Unverified means unverified
 *
 * `audit.status` is the seller's own claim and this module treats it as one:
 * absent audit means `unaudited`, which is what the catalog labels. Nothing
 * here inspects the module's code — the protection that matters is that the
 * bind is a vote, not a claim in a JSON field.
 */

/** Which seats a module is meant to guard, as its author intends it. */
export type PolicyModuleSlot = "worker_agent" | "manager_agent" | "org_default";

/** Provenance of the audit claim. Absent is `unaudited`, never "unknown". */
export type PolicyModuleAudit = "unaudited" | "self-attested" | "third-party";

/**
 * Standard modules a LaCrew deployment already carries in its address book.
 * A listing that names one needs no address of its own: it resolves against
 * whatever the buyer's own deployment binds, which is the only form of
 * "first-party" that survives being read on a second chain.
 */
export type StandardPolicyModule = "time_window" | "spend_cap" | "whitelist";

/** One chain this module is deployed on. */
export type PolicyModuleDeployment = {
  chainId: number;
  address: `0x${string}`;
};

export type PolicyModuleListing = {
  id: string;
  /** Opaque beyond equality — an update is any change of it. */
  version: string;
  name: string;
  summary: string;
  /** Set on first-party listings; mutually exclusive with `deployments`. */
  standardModule?: StandardPolicyModule;
  /** Already-deployed addresses, one per chain. Empty only when standard. */
  deployments: PolicyModuleDeployment[];
  slots: PolicyModuleSlot[];
  audit: { status: PolicyModuleAudit; notes?: string; url?: string };
  /** Where the source can be read. Http(s) only — a buyer has to reach it. */
  sourceUrl?: string;
  tags?: string[];
};

export const POLICY_MODULE_SLOTS: PolicyModuleSlot[] = [
  "worker_agent",
  "manager_agent",
  "org_default",
];

export const POLICY_MODULE_AUDIT_STATUSES: PolicyModuleAudit[] = [
  "unaudited",
  "self-attested",
  "third-party",
];

export const STANDARD_POLICY_MODULES: StandardPolicyModule[] = [
  "time_window",
  "spend_cap",
  "whitelist",
];

/** Bounds on one listing, checked before it can be published or attached. */
export const POLICY_MODULE_LIMITS = {
  name: 80,
  summary: 400,
  version: 40,
  notes: 1_000,
  deployments: 12,
  tags: 8,
} as const;

const ID_RE = /^[a-z0-9][a-z0-9._-]*$/;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export type PolicyModuleValidation = {
  ok: boolean;
  errors: string[];
  /** The normalized listing — present only when `ok`. */
  listing?: PolicyModuleListing;
};

/**
 * Check and normalize an untrusted policy-module payload.
 *
 * Every field is read off `unknown`: the inputs this exists for are a publish
 * form and a marketplace payload, and a payload that does not resolve to a
 * module is a listing that sells a buyer an install they cannot perform. The
 * address rules are the load-bearing ones — the zero address and a malformed
 * address both end as a stack member whose `check` reverts, which would strand
 * the node the moment governance executed the bind.
 */
export function validatePolicyModulePayload(input: unknown): PolicyModuleValidation {
  const errors: string[] = [];
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, errors: ["policy module must be an object"] };
  }
  const raw = input as Record<string, unknown>;

  const id = str(raw.id);
  if (!id) errors.push("id is required");
  else if (!ID_RE.test(id)) errors.push(`id "${id}" must be lowercase letters, digits, . _ or -`);

  const version = str(raw.version);
  if (!version) errors.push("version is required");
  else if (version.length > POLICY_MODULE_LIMITS.version) errors.push("version is too long");

  const name = str(raw.name);
  if (!name) errors.push("name is required");
  else if (name.length > POLICY_MODULE_LIMITS.name) errors.push("name is too long");

  const summary = str(raw.summary);
  if (!summary) errors.push("summary is required");
  else if (summary.length > POLICY_MODULE_LIMITS.summary) errors.push("summary is too long");

  const standardModule = str(raw.standardModule);
  if (standardModule && !STANDARD_POLICY_MODULES.includes(standardModule as StandardPolicyModule)) {
    errors.push(`standardModule must be one of ${STANDARD_POLICY_MODULES.join(", ")}`);
  }

  const deployments = normalizeDeployments(raw.deployments, errors);

  // A listing has to resolve to exactly one module for a given chain, and the
  // two ways of saying which are alternatives: a standard module comes from the
  // buyer's address book, a third-party one from its own address. Accepting
  // both would leave the attach path choosing on the buyer's behalf.
  if (standardModule && deployments.length > 0) {
    errors.push("a standardModule listing carries no deployments of its own");
  }
  if (!standardModule && deployments.length === 0) {
    errors.push("deployments must name at least one chain and address");
  }

  const slots = normalizeSlots(raw.slots, errors);
  const audit = normalizeAudit(raw.audit, errors);

  const sourceUrl = str(raw.sourceUrl);
  if (sourceUrl && !/^https?:\/\/\S+$/.test(sourceUrl)) {
    errors.push("sourceUrl must be an http(s) URL");
  }

  const tags = Array.isArray(raw.tags)
    ? [...new Set(raw.tags.map(str).filter(Boolean))].slice(0, POLICY_MODULE_LIMITS.tags)
    : [];
  if (raw.tags !== undefined && !Array.isArray(raw.tags)) errors.push("tags must be an array");

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    errors: [],
    listing: {
      id,
      version,
      name,
      summary,
      ...(standardModule ? { standardModule: standardModule as StandardPolicyModule } : {}),
      deployments,
      slots,
      audit,
      ...(sourceUrl ? { sourceUrl } : {}),
      ...(tags.length > 0 ? { tags } : {}),
    },
  };
}

function normalizeDeployments(input: unknown, errors: string[]): PolicyModuleDeployment[] {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) {
    errors.push("deployments must be an array of {chainId, address}");
    return [];
  }
  if (input.length > POLICY_MODULE_LIMITS.deployments) {
    errors.push(`too many deployments (${input.length} > ${POLICY_MODULE_LIMITS.deployments})`);
  }
  const out: PolicyModuleDeployment[] = [];
  const chains = new Set<number>();
  input.forEach((entry, i) => {
    const at = `deployments[${i}]`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      errors.push(`${at} must be an object`);
      return;
    }
    const e = entry as Record<string, unknown>;
    const chainId = typeof e.chainId === "number" ? e.chainId : Number(str(e.chainId));
    const address = str(e.address);
    if (!Number.isSafeInteger(chainId) || chainId <= 0) {
      errors.push(`${at}.chainId must be a positive integer`);
    } else if (chains.has(chainId)) {
      // Two addresses for one chain leaves the attach path picking one, which
      // is a choice about what gets bound and not one this format may make.
      errors.push(`${at}.chainId ${chainId} is listed twice`);
    }
    chains.add(chainId);
    if (!ADDRESS_RE.test(address)) {
      errors.push(`${at}.address must be a 20-byte hex address`);
    } else if (address.toLowerCase() === ZERO_ADDRESS) {
      errors.push(`${at}.address is the zero address`);
    } else if (Number.isSafeInteger(chainId) && chainId > 0) {
      out.push({ chainId, address: address as `0x${string}` });
    }
  });
  return out;
}

function normalizeSlots(input: unknown, errors: string[]): PolicyModuleSlot[] {
  if (input === undefined || input === null) {
    errors.push("slots must name at least one seat this module is written for");
    return [];
  }
  if (!Array.isArray(input)) {
    errors.push("slots must be an array");
    return [];
  }
  const out: PolicyModuleSlot[] = [];
  for (const value of input) {
    const slot = str(value);
    if (!POLICY_MODULE_SLOTS.includes(slot as PolicyModuleSlot)) {
      errors.push(`slot "${slot}" must be one of ${POLICY_MODULE_SLOTS.join(", ")}`);
      continue;
    }
    if (!out.includes(slot as PolicyModuleSlot)) out.push(slot as PolicyModuleSlot);
  }
  if (out.length === 0 && errors.length === 0) {
    errors.push("slots must name at least one seat this module is written for");
  }
  return out;
}

function normalizeAudit(input: unknown, errors: string[]): PolicyModuleListing["audit"] {
  // Absent is `unaudited` rather than a validation error: most community
  // modules will have no audit, and the catalog's job is to say so plainly.
  if (input === undefined || input === null) return { status: "unaudited" };
  if (typeof input !== "object" || Array.isArray(input)) {
    errors.push("audit must be an object");
    return { status: "unaudited" };
  }
  const raw = input as Record<string, unknown>;
  const status = str(raw.status) || "unaudited";
  if (!POLICY_MODULE_AUDIT_STATUSES.includes(status as PolicyModuleAudit)) {
    errors.push(`audit.status must be one of ${POLICY_MODULE_AUDIT_STATUSES.join(", ")}`);
  }
  const notes = str(raw.notes);
  if (notes.length > POLICY_MODULE_LIMITS.notes) errors.push("audit.notes is too long");
  const url = str(raw.url);
  if (url && !/^https?:\/\/\S+$/.test(url)) errors.push("audit.url must be an http(s) URL");
  return {
    status: status as PolicyModuleAudit,
    ...(notes ? { notes } : {}),
    ...(url ? { url } : {}),
  };
}

/** Parse JSON text into a listing; a syntax error is an error like any other. */
export function parsePolicyModuleListing(text: string): PolicyModuleValidation {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return {
      ok: false,
      errors: [
        `policy module is not valid JSON: ${err instanceof Error ? err.message : "parse failed"}`,
      ],
    };
  }
  return validatePolicyModulePayload(parsed);
}

/**
 * The address this listing binds on `chainId`, or undefined when it names no
 * deployment there. A standard-module listing always answers undefined — its
 * address comes from the buyer's own address book, which this format does not
 * hold.
 */
export function policyModuleAddressOn(
  listing: PolicyModuleListing,
  chainId: number,
): `0x${string}` | undefined {
  return listing.deployments.find((d) => d.chainId === chainId)?.address;
}

/** Whether a listing claims to fit the seat a buyer is attaching it to. */
export function policyModuleFitsSlot(
  listing: PolicyModuleListing,
  slot: PolicyModuleSlot,
): boolean {
  return listing.slots.includes(slot);
}
