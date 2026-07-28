/**
 * Turn a crew blueprint into the standing directives its seats should start with
 * (PRD F1.7).
 *
 * Installing a blueprint used to produce a staffed org that knew nothing about
 * itself: every seat booted with the same one-line identity prompt, while the
 * blueprint sitting right beside it already said what each role is for and what
 * must never happen. This closes that — the guidelines an operator would
 * otherwise retype are already written down.
 *
 * ## What is derived, and what is deliberately not
 *
 * Derived, because the blueprint genuinely states it:
 *   - a role's `charter` is that agent's guidelines. It is literally the
 *     sentence describing what the seat is for.
 *   - the crew's `guardrails` are its house rules, and each one is rendered
 *     with the mechanism that actually stops it. A guardrail reproduced as a
 *     bare "never do X" would read as a rule the model is being trusted to
 *     keep, when most of them are refused by a policy module regardless.
 *   - `outOfScope` entries are rendered as what the crew does not do.
 *
 * **Not** derived:
 *   - **skills.** The blueprint names flow ids and tool ids, not procedures. A
 *     skill body synthesised from an id would be invention presented as
 *     configuration, and the operator would have no way to tell which of their
 *     agents' instructions someone actually wrote.
 *   - **resources.** A blueprint cannot know which repos, venues or accounts
 *     belong to the operator who installs it. What it *can* say is which kind
 *     it needs, which is what `caresFor` is for: the editor gets a prompt with
 *     the right noun instead of an empty list with no hint.
 *
 * The distinction is the whole point. Everything here traces to a line in the
 * blueprint, so a directive an operator reads back is either something they
 * wrote or something the blueprint author did — never something this module
 * made up to fill a field.
 */

import type { BriefLayer } from "./crews.js";
import type { CrewBlueprint, CrewRole } from "./crews.js";

/** Label for the layer a blueprint's crew-wide direction occupies. */
export function blueprintCrewLabel(blueprintId: string): string {
  return `crew:${blueprintId}`;
}

/** Label for a seat's own layer. Matches the orchestrator's agent layer. */
export const BLUEPRINT_AGENT_LABEL = "agent";

/**
 * The crew's house rules, from its guardrails and what it does not do.
 *
 * Each guardrail names its mechanism, so an agent reading this learns both the
 * rule and whether anything but its own compliance enforces it.
 */
export function renderCrewGuidelines(blueprint: CrewBlueprint): string {
  const parts: string[] = [blueprint.summary.trim()].filter(Boolean);

  const rails = (blueprint.guardrails ?? []).filter((r) => r.never?.trim());
  if (rails.length > 0) {
    const lines = rails.map((rail) => {
      const how = rail.how?.trim();
      // The mechanism is not decoration. "Never merge to main" enforced by a
      // policy module and the same sentence enforced by nothing are different
      // instructions, and an agent that cannot tell them apart will treat a
      // monitoring-only rail as though something would stop it.
      return `- Never: ${rail.never.trim()}${how ? `\n  Enforced by ${rail.enforcedBy}: ${how}` : ""}`;
    });
    parts.push(`Must never happen:\n${lines.join("\n")}`);
  }

  const outOfScope = (blueprint.outOfScope ?? []).map((s) => s.trim()).filter(Boolean);
  if (outOfScope.length > 0) {
    parts.push(`Not this crew's work:\n${outOfScope.map((s) => `- ${s}`).join("\n")}`);
  }

  return parts.join("\n\n");
}

/**
 * The crew-wide layer a blueprint seeds.
 *
 * `resources` is left empty rather than guessed. `caresFor` tells the editor
 * which noun to prompt for; inventing a repo list here would put addresses in
 * an operator's directive that nobody chose.
 */
export function deriveCrewLayer(blueprint: CrewBlueprint): BriefLayer | null {
  const text = renderCrewGuidelines(blueprint);
  if (!text) return null;
  return { label: blueprintCrewLabel(blueprint.id), text };
}

/** One seat's own layer: its charter, which is exactly what that seat is for. */
export function deriveRoleLayer(role: CrewRole): BriefLayer | null {
  const text = role.charter?.trim();
  if (!text) return null;
  return { label: BLUEPRINT_AGENT_LABEL, text };
}

export type SeededDirective = {
  /** Blueprint role id — the caller maps it to an account once the hire executes. */
  roleId: string;
  label: string;
  layers: BriefLayer[];
};

/**
 * Every seat's starting directive: the crew's house rules, then its own charter.
 *
 * Crew before agent, matching how the orchestrator composes them — the specific
 * qualifies the general.
 */
export function deriveCrewDirectives(blueprint: CrewBlueprint): SeededDirective[] {
  const crewLayer = deriveCrewLayer(blueprint);
  return (blueprint.roles ?? []).map((role) => {
    const layers: BriefLayer[] = [];
    if (crewLayer) layers.push(crewLayer);
    const own = deriveRoleLayer(role);
    if (own) layers.push(own);
    return { roleId: role.id, label: role.label, layers };
  });
}

/**
 * What this crew needs assigned that the blueprint cannot supply.
 *
 * Returns null when a crew looks after nothing external — a directive with an
 * empty "in its care" prompt on a crew that has no such notion is noise.
 */
export function caresForPrompt(
  blueprint: CrewBlueprint,
): NonNullable<CrewBlueprint["caresFor"]> | null {
  return blueprint.caresFor ?? null;
}
