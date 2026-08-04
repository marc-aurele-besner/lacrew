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
