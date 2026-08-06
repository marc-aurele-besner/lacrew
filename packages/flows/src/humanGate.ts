/**
 * Who may resolve a blocking human gate (PRD F2.27).
 *
 * The `human` step carries an optional `assignee`: the one seat the question is
 * for. Pure on purpose and kept here rather than in the orchestrator, so the
 * surface that *renders* a gate answers "may I answer this?" with the same
 * function the runtime uses to refuse — a rail that disabled the box on one
 * rule while the backend enforced another would either block a person who is
 * allowed to decide or offer a box that always fails.
 *
 * ## Empty means anyone
 *
 * No assignee is not "nobody": it is the behaviour gates shipped with — any
 * human seat with access to the crew may answer. Reading a blank field as a
 * lock would silently stop every gate already in production.
 *
 * ## What is compared
 *
 * A gate is answered by an ordinary conversation message, and the only identity
 * that message carries is the one the surface attributed to it server-side: a
 * rendered author name, plus a stable seat id where the caller knows one. Both
 * are compared, because the id space `assignee` is written in is the operator's
 * choice — a cloud seat id, the seat's name, or an agent address whose thread
 * the question belongs in. Nothing self-reported is consulted: a message cannot
 * claim to be from the assignee, it can only have been attributed to them.
 *
 * ## Why the field is not free text
 *
 * A gate assigned to a seat that does not exist is worse than an unassigned
 * one: it looks decided, nobody can answer it, and the run sits there until the
 * deadline fails it closed. The runtime cannot check a name against a workspace
 * directory it does not have — that is the control plane's job, and its picker
 * offers real seats only — but it can refuse the shapes that are obviously not
 * a reference to anybody. `gateAssigneeIssue` is that check, kept beside the
 * matcher so a definition cannot declare an assignee this file could never
 * match.
 */

/**
 * Case- and prefix-insensitive. `seat:` / `human:` show up because that is how
 * the reviewer spec in dual control names a seat, and an operator who wrote one
 * form here meant the other.
 */
function normalizeSeat(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^(seat|human):/, "")
    .trim();
}

/** What a conversation attributed an answer to. Never what the answer claims. */
export type GateAnswerAuthor = {
  /** The author as the thread records it — an address, or a human seat's name. */
  author: string;
  /**
   * Stable id of the seat the surface authenticated, when it has one. The cloud
   * passes its seat id here: a display name is renameable, and a control that
   * hinged on one would move with a rename.
   */
  authorId?: string;
};

/**
 * Whether this author is the seat the gate was assigned to.
 *
 * True when the gate names nobody in particular — that is the documented
 * default, not an oversight.
 */
export function gateAssigneeMatches(
  assignee: string | undefined | null,
  author: GateAnswerAuthor,
): boolean {
  const wanted = normalizeSeat(assignee ?? "");
  if (!wanted) return true;
  return [author.authorId, author.author].some(
    (id) => typeof id === "string" && id.trim() !== "" && normalizeSeat(id) === wanted,
  );
}

/** Ceiling on an assignee. A seat reference is an identifier, not a payload. */
export const GATE_ASSIGNEE_MAX_CHARS = 128;

/**
 * Why this assignee could never name a seat, or null when it might.
 *
 * The rule is deliberately narrow: **one token**. A seat id, an address, or a
 * single-word handle, optionally `seat:`/`human:` prefixed. Anything with
 * whitespace in it is prose — "ask Grace", "whoever is on call", "the reviewer"
 * — and prose is exactly the input that produces a gate nobody can release.
 *
 * This is a shape check and says so: it cannot tell a live seat from a typo'd
 * one, and it is not the enforcement. The enforcement is `gateAssigneeMatches`
 * at answer time; a workspace that knows its own people (the control plane's
 * seat picker) is what turns a valid shape into a real person.
 *
 * `{{…}}` passes untouched, like every other interpolated field: the value is
 * not known until the run resolves it, and refusing the template here would
 * refuse the flows that pick an assignee per run.
 */
export function gateAssigneeIssue(assignee: string | undefined | null): string | null {
  const raw = (assignee ?? "").trim();
  // Empty is the documented default — any human seat with access — not a gap.
  if (!raw) return null;
  if (raw.includes("{{")) return null;
  if (raw.length > GATE_ASSIGNEE_MAX_CHARS) {
    return `must be at most ${GATE_ASSIGNEE_MAX_CHARS} characters`;
  }
  if (/\s/.test(raw)) {
    return "must be a single seat id or 0x address, not a sentence or a display name with spaces";
  }
  // After the prefix there has to be something left: `seat:` names nobody, and
  // reading it as an empty assignee would silently reopen the gate to everyone.
  if (!normalizeSeat(raw)) return "must name a seat, not just a prefix";
  return null;
}
