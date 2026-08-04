/**
 * Skill packs: a directive's skills as a portable, versioned artifact (PRD F2.23).
 *
 * A skill is a procedure with a trigger — it teaches *when* and *how* to use
 * connectors, flows and MCP tools that are already registered. Until now one
 * was only ever typed into the directive editor, which meant vertical know-how
 * stayed in the workspace where somebody wrote it. A pack is the same skills as
 * data: reviewable before install, installable onto another seat, and
 * replaceable in place when its author ships a new version.
 *
 * ## What a pack is not
 *
 * It is not authority. Installing one changes no cap, no whitelist, no session
 * scope and no governance rule — an agent with a merge procedure and no merge
 * connector has a procedure it cannot perform, which is why `requires` exists
 * and why an install with an unmet requirement is refused rather than trimmed.
 * The refusal is the honest answer: a pack silently installed with half its
 * skills would leave the model instructions for tools that are not there.
 *
 * ## Format
 *
 * JSON, not Markdown with frontmatter. A pack travels the same paths a flow
 * definition does — an HTTP body, a marketplace listing payload, a file on
 * disk — and those are already JSON, so a second authoring format would need a
 * parser in every consumer to say the same thing. `exportSkillPack` writes what
 * `parseSkillPack` reads, so a directive can be lifted back out to a file.
 *
 * ## Provenance, not name mangling
 *
 * An installed skill carries `source: {pack, version, skill}` rather than
 * having its pack id folded into its name. Two properties follow: the rendered
 * prompt keeps the name a human wrote, and uninstall is exact — it removes what
 * this pack put there and cannot touch a hand-written skill that happens to
 * share a name.
 *
 * ## Third-party bodies are untrusted text
 *
 * A pack body reaches the model's system prompt, so an installed pack is
 * attacker-controlled content in the same sense a thread message is. This
 * module bounds it (field caps, a skill count, no markup interpretation) and
 * the directive ceiling bounds the whole; what it deliberately does not do is
 * try to detect a malicious instruction, because a filter that sometimes works
 * would be read as one that does.
 */

import type { BriefLayer } from "./crews.js";

/** Where an installed skill came from. Absent on skills a person wrote. */
export type SkillSource = {
  pack: string;
  version: string;
  /** The skill's id *within* its pack — stable across versions. */
  skill: string;
};

/** One procedure in a pack. `trigger` is mandatory; see `validateSkillPack`. */
export type SkillPackSkill = {
  /** Stable within the pack. An update replaces the skill with the same id. */
  id: string;
  /** Display name, rendered into the directive as written. */
  name: string;
  /** When this applies — the trigger, not the procedure. */
  trigger: string;
  /** The procedure itself. */
  body: string;
};

/**
 * What must already be registered for this pack's skills to be performable.
 *
 * `connectors` accepts either a connector id (`github`) or one route
 * (`github.merge_pull_request`). The dotted form is worth using: a crew can
 * have the GitHub connector registered with only its read routes admitted, and
 * a merge procedure installed against that is a procedure that fails.
 */
export type SkillPackRequires = {
  flows?: string[];
  connectors?: string[];
  mcpTools?: string[];
};

/**
 * Which directive layer a pack belongs on.
 *
 * `crew` means a layer labelled `crew:<id>` — the label `deriveCrewLayer`
 * mints. That is this format's own convention, not something the orchestrator
 * knows: to it every label is opaque.
 */
export type SkillPackScope = "agent" | "crew" | "either";

export type SkillPack = {
  id: string;
  /** Opaque to this module beyond equality — an update is any change of it. */
  version: string;
  name: string;
  summary: string;
  scope: SkillPackScope;
  skills: SkillPackSkill[];
  requires?: SkillPackRequires;
};

/** The layer a pack lands on when the caller names none and scope allows it. */
export const DEFAULT_SKILL_PACK_LABEL = "agent";

/** Bounds on one pack, checked before anything is merged into a directive. */
export const SKILL_PACK_LIMITS = {
  skills: 20,
  name: 80,
  summary: 400,
  trigger: 400,
  body: 4_000,
  version: 40,
} as const;

const ID_RE = /^[a-z0-9][a-z0-9._-]*$/;

const SCOPES: SkillPackScope[] = ["agent", "crew", "either"];

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export type SkillPackValidation = {
  ok: boolean;
  errors: string[];
  /** The normalized pack — present only when `ok`. */
  pack?: SkillPack;
};

/**
 * Check and normalize an untrusted pack.
 *
 * Every field is read off `unknown` rather than trusted from a type, because
 * the inputs this exists for are a file an operator downloaded and a
 * marketplace payload. An empty `trigger` is the error worth naming twice: a
 * skill with no trigger is one the model applies to everything, which is how a
 * merge procedure ends up answering a triage question.
 */
export function validateSkillPack(input: unknown): SkillPackValidation {
  const errors: string[] = [];
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, errors: ["pack must be an object"] };
  }
  const raw = input as Record<string, unknown>;

  const id = str(raw.id);
  if (!id) errors.push("id is required");
  else if (!ID_RE.test(id)) errors.push(`id "${id}" must be lowercase letters, digits, . _ or -`);

  const version = str(raw.version);
  if (!version) errors.push("version is required");
  else if (version.length > SKILL_PACK_LIMITS.version) errors.push("version is too long");

  const name = str(raw.name);
  if (!name) errors.push("name is required");
  else if (name.length > SKILL_PACK_LIMITS.name) errors.push("name is too long");

  const summary = str(raw.summary);
  if (summary.length > SKILL_PACK_LIMITS.summary) errors.push("summary is too long");

  const scope = str(raw.scope) || "agent";
  if (!SCOPES.includes(scope as SkillPackScope)) {
    errors.push(`scope must be one of ${SCOPES.join(", ")}`);
  }

  const skillsIn = Array.isArray(raw.skills) ? raw.skills : [];
  if (skillsIn.length === 0) errors.push("skills must not be empty");
  if (skillsIn.length > SKILL_PACK_LIMITS.skills) {
    errors.push(`too many skills (${skillsIn.length} > ${SKILL_PACK_LIMITS.skills})`);
  }

  const skills: SkillPackSkill[] = [];
  const seen = new Set<string>();
  skillsIn.forEach((entry, i) => {
    const at = `skills[${i}]`;
    if (!entry || typeof entry !== "object") {
      errors.push(`${at} must be an object`);
      return;
    }
    const s = entry as Record<string, unknown>;
    const skillId = str(s.id);
    const skillName = str(s.name) || skillId;
    const trigger = str(s.trigger);
    const body = str(s.body);

    if (!skillId) errors.push(`${at}.id is required`);
    else if (!ID_RE.test(skillId))
      errors.push(`${at}.id "${skillId}" must be lowercase letters, digits, . _ or -`);
    else if (seen.has(skillId)) errors.push(`${at}.id "${skillId}" is duplicated`);
    seen.add(skillId);

    if (!skillName) errors.push(`${at}.name is required`);
    else if (skillName.length > SKILL_PACK_LIMITS.name) errors.push(`${at}.name is too long`);
    // The trigger carries the whole point of a skill being named rather than
    // pasted into the guidelines, so it is required and never defaulted.
    if (!trigger) errors.push(`${at}.trigger is required — a skill with no trigger is always on`);
    else if (trigger.length > SKILL_PACK_LIMITS.trigger) errors.push(`${at}.trigger is too long`);
    if (!body) errors.push(`${at}.body is required`);
    else if (body.length > SKILL_PACK_LIMITS.body) errors.push(`${at}.body is too long`);

    if (skillId && skillName && trigger && body) {
      skills.push({ id: skillId, name: skillName, trigger, body });
    }
  });

  const requires = normalizeRequires(raw.requires, errors);

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    errors: [],
    pack: {
      id,
      version,
      name,
      summary,
      scope: scope as SkillPackScope,
      skills,
      ...(requires ? { requires } : {}),
    },
  };
}

function normalizeRequires(input: unknown, errors: string[]): SkillPackRequires | undefined {
  if (input === undefined || input === null) return undefined;
  if (typeof input !== "object" || Array.isArray(input)) {
    errors.push("requires must be an object");
    return undefined;
  }
  const raw = input as Record<string, unknown>;
  const out: SkillPackRequires = {};
  for (const key of ["flows", "connectors", "mcpTools"] as const) {
    const value = raw[key];
    if (value === undefined) continue;
    if (!Array.isArray(value)) {
      errors.push(`requires.${key} must be an array of ids`);
      continue;
    }
    const ids = [...new Set(value.map(str).filter(Boolean))];
    if (ids.length > 0) out[key] = ids;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Parse JSON text into a pack; a syntax error is an error like any other. */
export function parseSkillPack(text: string): SkillPackValidation {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return {
      ok: false,
      errors: [`pack is not valid JSON: ${err instanceof Error ? err.message : "parse failed"}`],
    };
  }
  return validateSkillPack(parsed);
}

/** `<pack>:<skill>` — how a pack's skill is named in audit rows and the CLI. */
export function packSkillKey(packId: string, skillId: string): string {
  return `${packId}:${skillId}`;
}

/** Whether this pack may sit on a layer with that label. */
export function skillPackScopeFits(pack: SkillPack, label: string): boolean {
  if (pack.scope === "either") return true;
  const isCrewLayer = label.startsWith("crew:");
  return pack.scope === "crew" ? isCrewLayer : !isCrewLayer;
}

type LayerSkill = NonNullable<BriefLayer["skills"]>[number];

/** A pack's skills in the shape a directive layer stores them. */
export function skillPackSkills(pack: SkillPack): LayerSkill[] {
  return pack.skills.map((s) => ({
    name: s.name,
    when: s.trigger,
    instructions: s.body,
    source: { pack: pack.id, version: pack.version, skill: s.id },
  }));
}

/** What a pack needs that is not registered. Empty arrays mean nothing missing. */
export type SkillPackAvailability = {
  /** Flow ids saved on this orchestrator. */
  flows?: string[];
  /** Registered connector ids. */
  connectors?: string[];
  /** Registered connector routes, as `<connector>.<route>`. */
  connectorTools?: string[];
  /** MCP tool names the runtime serves. */
  mcpTools?: string[];
};

export type MissingRequirements = {
  flows: string[];
  connectors: string[];
  mcpTools: string[];
};

/**
 * Which of a pack's requirements are unmet.
 *
 * An availability list the caller could not read is `undefined`, and this
 * treats it as empty — everything required from that dimension comes back
 * missing. A registry that cannot be asked must not be answered for: reporting
 * "nothing missing" because the connector registry was unwired is exactly the
 * install that leaves an agent a procedure for a tool it does not have.
 */
export function missingRequirements(
  pack: SkillPack,
  available: SkillPackAvailability = {},
): MissingRequirements {
  const flows = new Set(available.flows ?? []);
  const connectors = new Set(available.connectors ?? []);
  const connectorTools = new Set(available.connectorTools ?? []);
  const mcpTools = new Set(available.mcpTools ?? []);
  const req = pack.requires ?? {};
  return {
    flows: (req.flows ?? []).filter((id) => !flows.has(id)),
    connectors: (req.connectors ?? []).filter((id) =>
      id.includes(".") ? !connectorTools.has(id) : !connectors.has(id),
    ),
    mcpTools: (req.mcpTools ?? []).filter((id) => !mcpTools.has(id)),
  };
}

export function hasMissingRequirements(missing: MissingRequirements): boolean {
  return missing.flows.length + missing.connectors.length + missing.mcpTools.length > 0;
}

/** One line naming what is missing, in the terms an operator has to go fix. */
export function describeMissing(missing: MissingRequirements): string {
  const parts: string[] = [];
  if (missing.flows.length > 0) parts.push(`flows: ${missing.flows.join(", ")}`);
  if (missing.connectors.length > 0) parts.push(`connectors: ${missing.connectors.join(", ")}`);
  if (missing.mcpTools.length > 0) parts.push(`tools: ${missing.mcpTools.join(", ")}`);
  return parts.join(" · ");
}

export type SkillPackInstallResult = {
  layers: BriefLayer[];
  label: string;
  /** Skills this pack now contributes to the directive. */
  installed: number;
  /** Skills an earlier install of the same pack left, which this replaced. */
  replaced: number;
};

/**
 * Merge a pack into a directive, replacing whatever an earlier version of the
 * same pack left.
 *
 * The pack is first cleared from *every* layer, then written to the target
 * one: installing the same pack twice against different labels would otherwise
 * leave the model the same procedure twice, differing only in provenance it
 * cannot see. Where a pack already occupied a slot in the target layer, its
 * replacement goes back in that slot rather than at the end, so an update does
 * not quietly reorder a directive somebody arranged.
 *
 * Hand-written skills are never touched: they carry no `source`, and nothing
 * here matches on name.
 */
export function installSkillPack(
  layers: readonly BriefLayer[],
  pack: SkillPack,
  opts: { label?: string } = {},
): SkillPackInstallResult {
  const label = opts.label?.trim() || (pack.scope === "crew" ? "" : DEFAULT_SKILL_PACK_LABEL);
  if (!label)
    throw new Error("label_required: a crew-scoped pack must name the crew layer it installs onto");
  if (!skillPackScopeFits(pack, label)) {
    throw new Error(
      `scope_mismatch: pack "${pack.id}" is ${pack.scope}-scoped and cannot install onto "${label}"`,
    );
  }

  const fresh = skillPackSkills(pack);
  let replaced = 0;
  let insertAt = -1;

  const cleared: BriefLayer[] = layers.map((layer) => {
    const skills = layer.skills ?? [];
    const kept: LayerSkill[] = [];
    skills.forEach((skill) => {
      if (skill.source?.pack === pack.id) {
        replaced += 1;
        if (layer.label === label && insertAt < 0) insertAt = kept.length;
        return;
      }
      kept.push(skill);
    });
    return { ...layer, ...(kept.length > 0 ? { skills: kept } : { skills: undefined }) };
  });

  const out: BriefLayer[] = [];
  let landed = false;
  for (const layer of cleared) {
    if (layer.label !== label) {
      out.push(stripEmptySkills(layer));
      continue;
    }
    const kept = layer.skills ?? [];
    const at = insertAt < 0 ? kept.length : insertAt;
    out.push(
      stripEmptySkills({ ...layer, skills: [...kept.slice(0, at), ...fresh, ...kept.slice(at)] }),
    );
    landed = true;
  }
  if (!landed) out.push({ label, skills: fresh });

  return { layers: out, label, installed: fresh.length, replaced };
}

function stripEmptySkills(layer: BriefLayer): BriefLayer {
  if (layer.skills && layer.skills.length > 0) return layer;
  const { skills: _skills, ...rest } = layer;
  return rest;
}

export type SkillPackRemoveResult = { layers: BriefLayer[]; removed: number };

/** Remove every skill this pack installed, in any layer and any version. */
export function removeSkillPack(
  layers: readonly BriefLayer[],
  packId: string,
): SkillPackRemoveResult {
  let removed = 0;
  const out = layers.map((layer) => {
    const kept = (layer.skills ?? []).filter((skill) => {
      if (skill.source?.pack !== packId) return true;
      removed += 1;
      return false;
    });
    return stripEmptySkills({ ...layer, skills: kept });
  });
  return { layers: out, removed };
}

export type InstalledSkillPack = {
  pack: string;
  version: string;
  label: string;
  skills: number;
  /** Skill ids from the pack that are present, in directive order. */
  skillIds: string[];
};

/**
 * Which packs a directive currently carries.
 *
 * Keyed by pack *and* label, since the same pack can legitimately sit on two
 * seats' layers of different labels in one crew's rendered directive. A pack
 * whose skills disagree about version is reported at the first version seen —
 * that state means a half-applied update and is worth surfacing as-is rather
 * than smoothing over.
 */
export function installedSkillPacks(layers: readonly BriefLayer[]): InstalledSkillPack[] {
  const out = new Map<string, InstalledSkillPack>();
  for (const layer of layers) {
    for (const skill of layer.skills ?? []) {
      const source = skill.source;
      if (!source) continue;
      const key = `${source.pack}@${layer.label}`;
      const entry = out.get(key);
      if (entry) {
        entry.skills += 1;
        entry.skillIds.push(source.skill);
        continue;
      }
      out.set(key, {
        pack: source.pack,
        version: source.version,
        label: layer.label,
        skills: 1,
        skillIds: [source.skill],
      });
    }
  }
  return [...out.values()];
}

/**
 * Lift a layer's skills back out as a pack, for backup or for sharing.
 *
 * Exports what is actually in the directive — hand-written skills included,
 * which is the point: the ones with no pack behind them are exactly the ones a
 * restore would otherwise lose. Ids come from the pack a skill was installed
 * from when it has one, so re-installing an export lands on the same slots.
 */
export function exportSkillPack(
  layers: readonly BriefLayer[],
  meta: {
    id: string;
    version: string;
    name: string;
    summary?: string;
    label?: string;
    scope?: SkillPackScope;
  },
): SkillPack {
  const label = meta.label?.trim();
  const chosen = layers.filter((layer) => !label || layer.label === label);
  const skills: SkillPackSkill[] = [];
  const used = new Set<string>();
  for (const layer of chosen) {
    for (const skill of layer.skills ?? []) {
      const base = skill.source?.skill || slug(skill.name);
      let id = base || `skill-${skills.length + 1}`;
      let n = 2;
      while (used.has(id)) id = `${base}-${n++}`;
      used.add(id);
      skills.push({
        id,
        name: skill.name,
        // A hand-written skill may have no trigger, which a pack may not: the
        // export names the gap in the field itself rather than dropping the
        // skill or inventing a condition its author never wrote.
        trigger: skill.when?.trim() || "TODO: say when this applies",
        body: skill.instructions,
      });
    }
  }
  return {
    id: meta.id,
    version: meta.version,
    name: meta.name,
    summary: meta.summary ?? "",
    scope: meta.scope ?? (label?.startsWith("crew:") ? "crew" : "agent"),
    skills,
  };
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}
