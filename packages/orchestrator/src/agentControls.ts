/**
 * Standing controls for one agent: whether it may act at all, and what it is
 * standing instructed to do (PRD F1.7).
 *
 * Both answer the same operator question — "steer this thing" — from opposite
 * ends. A pause takes capability away; a brief shapes how the capability is
 * used. They live together because they share one property that has to be got
 * right in both: neither is enforcement.
 *
 * ## What a pause is, precisely
 *
 * Pausing gates *session issuance*. The orchestrator holds scoped, expiring
 * session keys, so refusing to mint one — and revoking the live ones — is
 * genuinely within its authority and genuinely stops the agent acting through
 * it. What it is not:
 *
 *   - It is not an onchain change. The agent keeps its seat, its grant, and
 *     whatever the policy stack allows. Nothing about a pause survives into
 *     the chain's own view of the org.
 *   - It is not a revocation of authority the operator holds elsewhere. A
 *     self-hosted runner with its own key is unaffected, by construction: the
 *     chain never asked this process for permission.
 *
 * Callers must say so. A "pause" that reads as a kill switch, when a key the
 * operator already exported still works, is the kind of false comfort that
 * gets acted on during an incident.
 *
 * ## Why briefs are layered
 *
 * The agent step's system prompt used to be a fixed sentence, which made every
 * agent in every org identical in disposition. Briefs replace it — but a brief
 * is rarely written at one level: an org has a standing policy, a team has its
 * own, and an individual agent has specifics. So a brief is an ordered list of
 * layers, and each layer carries an opaque label for provenance.
 *
 * The labels are deliberately uninterpreted. Grouping above the individual
 * agent is a hosted-product concept the protocol has no notion of, and teaching
 * this module to recognise one would put that concept in the public repo. A
 * caller sends the layers it wants, in the order it wants them applied; this
 * module concatenates and reports what it applied, and understands none of it.
 */

/** One layer of standing instruction, with an opaque provenance label. */
export type BriefLayer = {
  /**
   * Where this layer came from, for display and audit. Never interpreted —
   * "org", "crew:Trading" and "agent" are all equally opaque here.
   */
  label: string;
  text: string;
};

export type AgentBrief = {
  agent: string;
  layers: BriefLayer[];
  updatedAt: string;
};

/** Ceiling on a stored brief. A system prompt is not a document store. */
export const BRIEF_MAX_CHARS = 4_000;

export class BriefTooLongError extends Error {
  constructor(readonly chars: number) {
    super(`brief_too_long (${chars} > ${BRIEF_MAX_CHARS})`);
    this.name = "BriefTooLongError";
  }
}

/** Drop empty layers and trim; returns [] when nothing survives. */
export function normalizeLayers(layers: readonly BriefLayer[]): BriefLayer[] {
  const out: BriefLayer[] = [];
  for (const layer of layers) {
    const text = layer.text.trim();
    if (!text) continue;
    out.push({ label: layer.label.trim() || "unlabelled", text });
  }
  const total = out.reduce((sum, l) => sum + l.text.length, 0);
  if (total > BRIEF_MAX_CHARS) throw new BriefTooLongError(total);
  return out;
}

/**
 * The system prompt for one agent's turn.
 *
 * The identity line always leads and is never overridable, because the model
 * has to know which account it is acting as before it reads anything about how
 * to act — a brief that could rewrite the identity line would let standing
 * instruction impersonate another seat.
 */
export function composeSystemPrompt(
  agent: string,
  layers: readonly BriefLayer[] = [],
): string {
  const identity = `You are agent ${agent} in a LaCrew organization.`;
  const applied = layers.map((l) => l.text.trim()).filter(Boolean);
  return applied.length === 0 ? identity : `${identity}\n\n${applied.join("\n\n")}`;
}

/**
 * Standing per-agent controls, held for the life of the process.
 *
 * Deliberately in-memory, like `sessionScopePolicy`: this is orchestration
 * state, and the authoritative copy belongs to whoever operates the deployment
 * (the hosted control plane keeps its own per tenant, and pushes it in). A
 * restart therefore resumes every agent, which is the safe direction to fail —
 * an operator who lost a pause will see the agent working and can pause it
 * again, whereas a pause that outlived the operator's intent is a silent
 * outage nobody can find.
 */
export class AgentControls {
  private readonly paused = new Map<string, { at: string; reason?: string }>();
  private readonly briefs = new Map<string, AgentBrief>();

  private key(agent: string): string {
    return agent.toLowerCase();
  }

  isPaused(agent: string): boolean {
    return this.paused.has(this.key(agent));
  }

  pausedDetail(agent: string): { at: string; reason?: string } | null {
    return this.paused.get(this.key(agent)) ?? null;
  }

  /** Returns true when this call changed the state (so callers can skip a no-op audit). */
  pause(agent: string, at: string, reason?: string): boolean {
    const key = this.key(agent);
    if (this.paused.has(key)) return false;
    this.paused.set(key, reason ? { at, reason } : { at });
    return true;
  }

  resume(agent: string): boolean {
    return this.paused.delete(this.key(agent));
  }

  listPaused(): Array<{ agent: string; at: string; reason?: string }> {
    return [...this.paused.entries()].map(([agent, detail]) => ({ agent, ...detail }));
  }

  /** Replaces the agent's layers wholesale; empty clears the brief entirely. */
  setBrief(agent: string, layers: readonly BriefLayer[], at: string): AgentBrief | null {
    const key = this.key(agent);
    const normalized = normalizeLayers(layers);
    if (normalized.length === 0) {
      this.briefs.delete(key);
      return null;
    }
    const brief: AgentBrief = { agent: key, layers: normalized, updatedAt: at };
    this.briefs.set(key, brief);
    return brief;
  }

  briefFor(agent: string): AgentBrief | null {
    return this.briefs.get(this.key(agent)) ?? null;
  }

  listBriefs(): AgentBrief[] {
    return [...this.briefs.values()];
  }

  /** The composed system prompt this agent should run under. */
  systemPromptFor(agent: string): string {
    return composeSystemPrompt(agent, this.briefFor(agent)?.layers ?? []);
  }
}

export class AgentPausedError extends Error {
  constructor(
    readonly agent: string,
    readonly since: string,
    readonly reason?: string,
  ) {
    super(
      `agent_paused (${agent} since ${since}${reason ? `: ${reason}` : ""}). ` +
        "Resume it to issue a session key. This gate is the orchestrator refusing " +
        "to mint keys — it is not an onchain change, and it does not stop a key " +
        "issued elsewhere.",
    );
    this.name = "AgentPausedError";
  }
}
