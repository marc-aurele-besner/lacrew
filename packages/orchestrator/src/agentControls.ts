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

/**
 * A named capability the agent can apply, in the shape a person would write it.
 *
 * `when` matters as much as `instructions`: a model given six skill bodies at
 * once applies whichever reads closest, so the trigger is what keeps a merge
 * procedure from being used on a triage question.
 */
export type Skill = {
  name: string;
  /** When this applies — the trigger, not the procedure. */
  when?: string;
  instructions: string;
  /**
   * Set when a skill pack installed this skill (F2.23): which pack, at which
   * version, and its id inside that pack. Absent means somebody wrote it here,
   * which is what makes uninstalling a pack exact — it removes what the pack
   * put there and cannot take a hand-written skill with it.
   *
   * Never rendered into the prompt. It is provenance for the operator and for
   * the installer, and a model reading it would be reading configuration.
   */
  source?: { pack: string; version: string; skill: string };
};

/**
 * Something in the agent's care: a repo, a venue, an account, a contract.
 *
 * Deliberately `kind` + `ref` rather than a repo field. A GitHub crew looks
 * after repositories, a trading crew looks after venues and a content crew
 * looks after accounts — the same standing question ("what am I responsible
 * for?") with a different noun, and one shape answers all of them.
 */
export type Resource = {
  /** "repo", "venue", "account", "contract", … — free-form on purpose. */
  kind: string;
  /** The identifier as its own world writes it: "owner/repo", a URL, an address. */
  ref: string;
  /** What is special about this one. The part a generic list cannot carry. */
  note?: string;
};

/**
 * One layer of standing direction, with an opaque provenance label.
 *
 * A layer is the AGENTS.md of one scope: prose guidelines, the resources that
 * scope looks after, and the skills it knows. All three are optional, so a
 * plain-text layer written before this existed is still a valid layer — it is
 * simply one with only `text`.
 */
export type BriefLayer = {
  /**
   * Where this layer came from, for display and audit. Never interpreted —
   * "org", "crew:Trading" and "agent" are all equally opaque here.
   */
  label: string;
  /** House guidelines for this scope: the prose an AGENTS.md would carry. */
  text?: string;
  /** What this scope is responsible for. */
  resources?: Resource[];
  /** Named procedures this scope knows, each with its own trigger. */
  skills?: Skill[];
};

export type AgentBrief = {
  agent: string;
  layers: BriefLayer[];
  updatedAt: string;
};

/**
 * Ceiling on a stored brief, measured on the *rendered* prompt.
 *
 * Measuring the raw fields would let twenty short skills past a limit that the
 * rendered form blows through — the number that matters is what actually
 * reaches the model's context, not what was typed.
 */
export const BRIEF_MAX_CHARS = 8_000;

export class BriefTooLongError extends Error {
  constructor(readonly chars: number) {
    super(`brief_too_long (${chars} > ${BRIEF_MAX_CHARS})`);
    this.name = "BriefTooLongError";
  }
}

function trimmed(value: string | undefined): string {
  return (value ?? "").trim();
}

/** True when a layer carries nothing a model could act on. */
export function isEmptyLayer(layer: BriefLayer): boolean {
  return (
    !trimmed(layer.text) &&
    (layer.resources ?? []).every((r) => !trimmed(r.ref)) &&
    (layer.skills ?? []).every((s) => !trimmed(s.name) || !trimmed(s.instructions))
  );
}

/**
 * Render one layer as the section a person would have written by hand.
 *
 * Guidelines lead, then what the scope is responsible for, then what it knows
 * how to do — responsibilities before procedures, because a procedure is only
 * meaningful once its subject is established.
 */
export function renderLayer(layer: BriefLayer): string {
  const parts: string[] = [];
  const guidelines = trimmed(layer.text);
  if (guidelines) parts.push(guidelines);

  const resources = (layer.resources ?? []).filter((r) => trimmed(r.ref));
  if (resources.length > 0) {
    const lines = resources.map((r) => {
      const kind = trimmed(r.kind) || "resource";
      const note = trimmed(r.note);
      return `- ${kind} ${trimmed(r.ref)}${note ? ` — ${note}` : ""}`;
    });
    parts.push(`In your care:\n${lines.join("\n")}`);
  }

  const skills = (layer.skills ?? []).filter(
    (s) => trimmed(s.name) && trimmed(s.instructions),
  );
  if (skills.length > 0) {
    const blocks = skills.map((s) => {
      const when = trimmed(s.when);
      // The trigger is rendered on its own line above the body so the model
      // can scan for the applicable skill without reading every procedure.
      return `- ${trimmed(s.name)}${when ? `\n  Use when: ${when}` : ""}\n  ${trimmed(
        s.instructions,
      ).replace(/\n/g, "\n  ")}`;
    });
    parts.push(`Skills:\n${blocks.join("\n")}`);
  }

  return parts.join("\n\n");
}

/** Drop empty layers and trim; returns [] when nothing survives. */
export function normalizeLayers(layers: readonly BriefLayer[]): BriefLayer[] {
  const out: BriefLayer[] = [];
  for (const layer of layers) {
    if (isEmptyLayer(layer)) continue;
    const resources = (layer.resources ?? [])
      .filter((r) => trimmed(r.ref))
      .map((r) => ({
        kind: trimmed(r.kind) || "resource",
        ref: trimmed(r.ref),
        ...(trimmed(r.note) ? { note: trimmed(r.note) } : {}),
      }));
    const skills = (layer.skills ?? [])
      .filter((s) => trimmed(s.name) && trimmed(s.instructions))
      .map((s) => ({
        name: trimmed(s.name),
        ...(trimmed(s.when) ? { when: trimmed(s.when) } : {}),
        instructions: trimmed(s.instructions),
        // Carried through rather than rebuilt from the rendered fields: a
        // normalization that dropped it would make every stored skill look
        // hand-written, and an uninstall would then find nothing to remove.
        ...(s.source?.pack && s.source.skill
          ? {
              source: {
                pack: trimmed(s.source.pack),
                version: trimmed(s.source.version),
                skill: trimmed(s.source.skill),
              },
            }
          : {}),
      }));
    out.push({
      label: trimmed(layer.label) || "unlabelled",
      ...(trimmed(layer.text) ? { text: trimmed(layer.text) } : {}),
      ...(resources.length > 0 ? { resources } : {}),
      ...(skills.length > 0 ? { skills } : {}),
    });
  }
  const rendered = out.map(renderLayer).join("\n\n").length;
  if (rendered > BRIEF_MAX_CHARS) throw new BriefTooLongError(rendered);
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
  const applied = layers.map(renderLayer).filter(Boolean);
  return applied.length === 0 ? identity : `${identity}\n\n${applied.join("\n\n")}`;
}

/** One agent's durable standing state, as the store round-trips it. */
export type AgentControlRecord = {
  agent: string;
  paused: boolean;
  pausedAt?: string;
  pausedReason?: string;
  layers: BriefLayer[];
  updatedAt: string;
};

/**
 * Persistence for standing controls. Implemented by `RuntimeStore`, which is
 * Postgres when `DATABASE_URL` is set and a memory map otherwise.
 */
export interface AgentControlStore {
  loadAgentControls(): Promise<AgentControlRecord[]>;
  saveAgentControl(record: AgentControlRecord): Promise<void>;
}

/**
 * Standing per-agent controls: the pause gate and the directive.
 *
 * These outlive the process. An earlier version held them in memory only, on
 * the argument that a restart resuming every agent fails in the safe
 * direction — which is true of a pause and badly wrong for a directive: an
 * agent silently reverting to no guidelines, no resources and no skills goes
 * on working, and does the wrong thing competently. So both persist through
 * `AgentControlStore`, and a restart restores exactly what an operator left.
 *
 * Writes go to memory first and the store after, so a store that is down
 * degrades to the old in-memory behaviour rather than refusing the pause an
 * operator is trying to apply during an incident.
 */
export class AgentControls {
  private readonly paused = new Map<string, { at: string; reason?: string }>();
  private readonly briefs = new Map<string, AgentBrief>();
  private store?: AgentControlStore;
  /** Surfaced so a caller can report "loaded from store" vs "nothing was stored". */
  hydrated = false;

  constructor(store?: AgentControlStore) {
    this.store = store;
  }

  /**
   * Load stored controls into memory. Idempotent, and never throws: a store
   * that cannot be read must not stop the orchestrator from booting, so it
   * boots with nothing standing and says so through `hydrated`.
   */
  async hydrate(store = this.store): Promise<{ ok: boolean; loaded: number }> {
    if (!store) return { ok: false, loaded: 0 };
    this.store = store;
    try {
      const records = await store.loadAgentControls();
      for (const record of records) {
        const key = this.key(record.agent);
        if (record.paused && record.pausedAt) {
          this.paused.set(
            key,
            record.pausedReason ? { at: record.pausedAt, reason: record.pausedReason } : { at: record.pausedAt },
          );
        }
        if (record.layers.length > 0) {
          this.briefs.set(key, {
            agent: key,
            layers: record.layers,
            updatedAt: record.updatedAt,
          });
        }
      }
      this.hydrated = true;
      return { ok: true, loaded: records.length };
    } catch {
      return { ok: false, loaded: 0 };
    }
  }

  /** Fire-and-forget write-through; the store swallows its own errors. */
  private persist(agent: string, at: string): void {
    if (!this.store) return;
    const key = this.key(agent);
    const paused = this.paused.get(key);
    void this.store
      .saveAgentControl({
        agent: key,
        paused: Boolean(paused),
        ...(paused ? { pausedAt: paused.at } : {}),
        ...(paused?.reason ? { pausedReason: paused.reason } : {}),
        layers: this.briefs.get(key)?.layers ?? [],
        updatedAt: at,
      })
      .catch(() => {
        /* a store blip must not turn a successful pause into a failure */
      });
  }

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
    this.persist(key, at);
    return true;
  }

  resume(agent: string, at = new Date().toISOString()): boolean {
    const key = this.key(agent);
    const changed = this.paused.delete(key);
    // Persisted even on a no-op resume: the stored row is the source of truth
    // a restart reads, and leaving a stale paused row there would re-pause an
    // agent the operator had already let go.
    this.persist(key, at);
    return changed;
  }

  listPaused(): Array<{ agent: string; at: string; reason?: string }> {
    return [...this.paused.entries()].map(([agent, detail]) => ({ agent, ...detail }));
  }

  /**
   * Replaces the agent's layers wholesale; empty clears the directive entirely.
   *
   * Normalization runs before anything is stored, so an over-long directive
   * throws without having half-written itself.
   */
  setBrief(agent: string, layers: readonly BriefLayer[], at: string): AgentBrief | null {
    const key = this.key(agent);
    const normalized = normalizeLayers(layers);
    if (normalized.length === 0) {
      this.briefs.delete(key);
      this.persist(key, at);
      return null;
    }
    const brief: AgentBrief = { agent: key, layers: normalized, updatedAt: at };
    this.briefs.set(key, brief);
    this.persist(key, at);
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
