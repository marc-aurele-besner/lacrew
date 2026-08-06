/**
 * Installing skill packs onto a live directive (PRD F2.23).
 *
 * `@lacrew/flows` owns the format and the merge — both are pure functions over
 * data, and a marketplace or a CLI validating a pack should not have to boot an
 * orchestrator to do it. What is here is everything that needs the running
 * process: which flows are saved, which connectors and routes are registered,
 * which MCP tools this runtime serves, and the directive the install writes to.
 *
 * ## An install is refused, never trimmed
 *
 * `requires` is checked against the live registries and an unmet requirement
 * refuses the whole pack. Installing the skills that happen to fit would leave
 * an operator a directive that reads complete and an agent with a procedure for
 * a tool that is not there — and the model has no way to discover the
 * difference at the moment it matters.
 *
 * Nothing here widens authority. The directive is instruction; the caps,
 * whitelists, session scopes and policy stack are untouched by every path in
 * this file, which is why an install is not a governance action.
 */

import {
  describeMissing,
  hasMissingRequirements,
  installSkillPack,
  installedSkillPacks,
  missingRequirements,
  removeSkillPack,
  skillPackScopeFits,
  validateSkillPack,
  type InstalledSkillPack,
  type MissingRequirements,
  type SkillPack,
  type SkillPackAvailability,
} from "@lacrew/flows";
import { BriefTooLongError, BRIEF_MAX_CHARS, type BriefLayer } from "./agentControls.js";
import type { CrewRuntime } from "./runtime.js";

/** Raised when a pack's `requires` names something this runtime does not have. */
export class SkillPackRequirementsError extends Error {
  constructor(
    readonly pack: string,
    readonly missing: MissingRequirements,
  ) {
    super(`skill_pack_requirements_unmet (${pack}) — missing ${describeMissing(missing)}`);
    this.name = "SkillPackRequirementsError";
  }
}

/** Raised when the merged directive would blow the rendered ceiling. */
export class SkillPackTooLargeError extends Error {
  constructor(
    readonly pack: string,
    readonly chars: number,
  ) {
    super(
      `skill_pack_too_large (${pack}) — the directive would render ${chars} characters, over the ` +
        `${BRIEF_MAX_CHARS} ceiling. Remove an installed pack or shorten a layer, then install again.`,
    );
    this.name = "SkillPackTooLargeError";
  }
}

export type SkillPackInstallReport = {
  agent: string;
  pack: string;
  version: string;
  label: string;
  installed: number;
  replaced: number;
  layers: BriefLayer[];
};

/**
 * Whose tools a requirements check is about.
 *
 * A `lacrew_*` tool is the same for everyone, but an external MCP tool is
 * admitted per seat: on a shared orchestrator the process-wide list is some
 * other workspace's answer. Omitted, the check reads the process default —
 * which is the right answer for a self-host and the wrong one to guess with.
 */
export type SkillPackSubject = { principal?: string; managers?: Iterable<string> };

export type SkillPacksSurface = {
  /** What is registered here, for a requirements check or a library listing. */
  availability(subject?: SkillPackSubject): Promise<SkillPackAvailability>;
  /** Unmet requirements for one pack; empty arrays mean it can be installed. */
  check(pack: SkillPack, subject?: SkillPackSubject): Promise<MissingRequirements>;
  install(
    agent: `0x${string}`,
    pack: SkillPack,
    opts?: { label?: string },
  ): Promise<SkillPackInstallReport>;
  remove(agent: `0x${string}`, packId: string): { agent: string; pack: string; removed: number };
  installed(agent: `0x${string}`): InstalledSkillPack[];
};

export type SkillPacksDeps = {
  runtime: Pick<CrewRuntime, "agentBrief" | "setAgentBrief" | "recordAudit">;
  /** Flow ids saved here. Absent (or throwing) means none can be proven saved. */
  listFlowIds: () => Promise<string[]>;
  /** Registered connector ids and their `<connector>.<route>` tool names. */
  listConnectors: () => { ids: string[]; tools: string[] };
  /**
   * Callable tool names for one subject: the first-party `lacrew_*` set plus
   * whatever external MCP tools that seat is allowed to call. Not the servers'
   * tool lists — a tool nobody admitted is not a tool this pack can use.
   */
  listMcpTools: (subject?: SkillPackSubject) => string[];
  /** The agent a pack is being installed onto, as a requirements subject. */
  subjectFor?: (agent: `0x${string}`) => Promise<SkillPackSubject>;
};

export function createSkillPacksSurface(deps: SkillPacksDeps): SkillPacksSurface {
  const availability = async (subject?: SkillPackSubject): Promise<SkillPackAvailability> => {
    // A registry that cannot be read is reported as empty rather than skipped:
    // `missingRequirements` treats an absent dimension as nothing registered,
    // so a probe failure refuses the install instead of waving it through.
    let flows: string[] = [];
    try {
      flows = await deps.listFlowIds();
    } catch {
      flows = [];
    }
    const connectors = deps.listConnectors();
    return {
      flows,
      connectors: connectors.ids,
      connectorTools: connectors.tools,
      mcpTools: deps.listMcpTools(subject),
    };
  };

  const check = async (pack: SkillPack, subject?: SkillPackSubject) =>
    missingRequirements(pack, await availability(subject));

  return {
    availability,
    check,

    async install(agent, pack, opts = {}) {
      // Checked as the agent being installed onto, not as the process: a pack
      // naming `mcp__gh__search_issues` must be refused when *this* seat cannot
      // call it, even where another workspace on the same orchestrator can.
      const subject = (await deps.subjectFor?.(agent)) ?? { principal: agent };
      const missing = await check(pack, subject);
      if (hasMissingRequirements(missing)) throw new SkillPackRequirementsError(pack.id, missing);

      const before = deps.runtime.agentBrief(agent)?.layers ?? [];
      const merged = installSkillPack(before, pack, opts);
      try {
        deps.runtime.setAgentBrief(agent, merged.layers);
      } catch (err) {
        // The ceiling is measured on the rendered prompt, so only the write
        // knows. Re-raised naming the pack, since "brief too long" alone does
        // not say which install to undo.
        if (err instanceof BriefTooLongError) throw new SkillPackTooLargeError(pack.id, err.chars);
        throw err;
      }

      deps.runtime.recordAudit({
        type: "SkillPackInstalled",
        at: new Date().toISOString(),
        payload: {
          agent,
          pack: pack.id,
          version: pack.version,
          label: merged.label,
          // Counts, never bodies: a pack body runs to thousands of characters
          // and the trail is a bounded ring. /agents/skills serves the text.
          skills: merged.installed,
          replaced: merged.replaced,
        },
      });

      return {
        agent,
        pack: pack.id,
        version: pack.version,
        label: merged.label,
        installed: merged.installed,
        replaced: merged.replaced,
        layers: merged.layers,
      };
    },

    remove(agent, packId) {
      const before = deps.runtime.agentBrief(agent)?.layers ?? [];
      const result = removeSkillPack(before, packId);
      // A no-op removal still writes: it is cheap, and refusing it would make
      // "already uninstalled" an error the caller has to special-case.
      deps.runtime.setAgentBrief(agent, result.layers);
      if (result.removed > 0) {
        deps.runtime.recordAudit({
          type: "SkillPackRemoved",
          at: new Date().toISOString(),
          payload: { agent, pack: packId, skills: result.removed },
        });
      }
      return { agent, pack: packId, removed: result.removed };
    },

    installed(agent) {
      return installedSkillPacks(deps.runtime.agentBrief(agent)?.layers ?? []);
    },
  };
}

/** Validate an untrusted pack body from an HTTP caller or a file. */
export function readSkillPack(input: unknown): { pack?: SkillPack; errors: string[] } {
  const result = validateSkillPack(input);
  return result.ok && result.pack ? { pack: result.pack, errors: [] } : { errors: result.errors };
}

export { skillPackScopeFits };
