/**
 * Rich message content: what an agent attaches to a claim (PRD F1.7).
 *
 * Block-Kit-shaped, but built around a threat the general-purpose version does
 * not have to think about. Here, **the author of a block may be a compromised
 * agent, and the reader is about to make a money decision**. Prompt injection
 * that reaches an agent reaches these blocks, so every field below is treated
 * as attacker-controlled and the rules follow from that:
 *
 * ## 1. A block never carries its own action
 *
 * The obvious feature is a button on a message: "approve this". The obvious
 * attack is a button labelled *Approve 5 USDC* wired to a 5,000 USDC intent —
 * phishing inside the product the user came to in order to be safe.
 *
 * So an author supplies a **reference**, never an action or its label: an
 * intent id, a proposal id. The surface renders the control from the record it
 * *serves* — the real value, the real target — and the agent's prose sits
 * beside it, clearly as prose. An author can lie in the body; it cannot make
 * the button lie.
 *
 * ## 2. A link is external until proven otherwise
 *
 * An agent posting "the data I found" is posting a URL it chose. `link` blocks
 * therefore keep the host visible for the reader and refuse any scheme that is
 * not http(s) — `javascript:` is script execution, and `data:` is a document
 * the reader would believe came from us.
 *
 * A link whose label impersonates an internal surface is the same phishing
 * attack in text form, so `looksInternal()` marks those and the surface says
 * plainly that the destination is off-site.
 *
 * ## 3. Nothing here renders as markup
 *
 * Blocks carry text and structure, never HTML. The surface is responsible for
 * escaping, and there is no block whose contract is "render this as markup" —
 * that is the door this shape exists to keep shut.
 */

export type MessageRefKind = "intent" | "proposal" | "tx" | "flowRun";

/** A labelled fact. Both sides are author text, rendered as text. */
export type BlockField = { label: string; value: string };

export type MessageBlock =
  /** A paragraph of the author's own prose. */
  | { kind: "text"; text: string }
  /** Extracted facts — what an agent found, in a form a human can scan. */
  | { kind: "fields"; items: BlockField[] }
  /** Something off-site: data found, a post submitted, a PR opened. */
  | { kind: "link"; url: string; label?: string }
  /** Output, a diff, a payload. Rendered monospaced and never executed. */
  | { kind: "code"; text: string; lang?: string }
  /**
   * Something inside LaCrew. Carries only what it points at — the surface
   * renders the summary and the control from the served record, never from
   * anything the author wrote.
   */
  | { kind: "ref"; ref: MessageRefKind; id: string };

export const BLOCK_KINDS = ["text", "fields", "link", "code", "ref"] as const;
export const REF_KINDS: MessageRefKind[] = ["intent", "proposal", "tx", "flowRun"];

/** Ceilings sized for a message, not a document. */
export const BLOCKS_MAX = 20;
export const BLOCK_TEXT_MAX = 2_000;
export const FIELDS_MAX = 12;

export class BlockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BlockError";
  }
}

/** Schemes a reader can be shown safely. Everything else is refused, not stripped. */
const SAFE_SCHEMES = new Set(["http:", "https:"]);

export type ParsedUrl = { ok: true; href: string; host: string } | { ok: false; reason: string };

/**
 * Accept a URL only if a reader could be shown where it goes.
 *
 * Refused rather than sanitised: quietly rewriting an author's URL produces a
 * link that works and is not the one they wrote, and neither the author nor
 * the reader can tell. A refusal is visible to the agent that posted it.
 */
export function parseSafeUrl(raw: string): ParsedUrl {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, reason: "url_required" };
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, reason: "url_unparseable" };
  }
  if (!SAFE_SCHEMES.has(url.protocol)) {
    // javascript: is script execution; data: is a document the reader would
    // believe came from us.
    return { ok: false, reason: `url_scheme_refused (${url.protocol})` };
  }
  return { ok: true, href: url.toString(), host: url.host };
}

/**
 * Whether a link's label is dressed up as one of our own surfaces.
 *
 * "Approve intent 12" pointing off-site is the same phishing attack as a fake
 * button, in text. This does not refuse the link — an agent may legitimately
 * write "the approval docs" — it tells the surface to say out loud where the
 * link actually goes.
 */
export function looksInternal(label: string | undefined): boolean {
  if (!label) return false;
  return /\b(approve|approval|proposal|governance|intent|treasury|session|revoke|sign)\b/i.test(
    label,
  );
}

function trimmed(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Validate and normalize author-supplied blocks.
 *
 * Throws on anything malformed rather than dropping it silently: an agent whose
 * link was discarded should learn that, not discover its message rendered
 * without the evidence it attached.
 */
export function normalizeBlocks(raw: readonly unknown[]): MessageBlock[] {
  if (raw.length > BLOCKS_MAX) {
    throw new BlockError(`too_many_blocks (${raw.length} > ${BLOCKS_MAX})`);
  }

  return raw.map((entry, index) => {
    const block = entry as Record<string, unknown>;
    const kind = trimmed(block.kind);
    const at = `block[${index}]`;

    if (kind === "text" || kind === "code") {
      const text = trimmed(block.text);
      if (!text) throw new BlockError(`${at}: text_required`);
      if (text.length > BLOCK_TEXT_MAX) {
        throw new BlockError(`${at}: text_too_long (${text.length} > ${BLOCK_TEXT_MAX})`);
      }
      return kind === "code"
        ? { kind, text, ...(trimmed(block.lang) ? { lang: trimmed(block.lang) } : {}) }
        : { kind, text };
    }

    if (kind === "fields") {
      const items = Array.isArray(block.items) ? block.items : [];
      const parsed = items
        .map((i) => i as Record<string, unknown>)
        .map((i) => ({ label: trimmed(i.label), value: trimmed(i.value) }))
        .filter((i) => i.label || i.value);
      if (parsed.length === 0) throw new BlockError(`${at}: fields_required`);
      if (parsed.length > FIELDS_MAX) {
        throw new BlockError(`${at}: too_many_fields (${parsed.length} > ${FIELDS_MAX})`);
      }
      return { kind: "fields", items: parsed };
    }

    if (kind === "link") {
      const parsedUrl = parseSafeUrl(trimmed(block.url));
      if (!parsedUrl.ok) throw new BlockError(`${at}: ${parsedUrl.reason}`);
      const label = trimmed(block.label);
      return {
        kind: "link",
        url: parsedUrl.href,
        ...(label ? { label } : {}),
      };
    }

    if (kind === "ref") {
      const refKind = trimmed(block.ref) as MessageRefKind;
      if (!REF_KINDS.includes(refKind)) {
        throw new BlockError(`${at}: unknown_ref_kind (${refKind}); known: ${REF_KINDS.join(", ")}`);
      }
      const id = trimmed(block.id);
      if (!id) throw new BlockError(`${at}: ref_id_required`);
      // Deliberately nothing else. A label or an amount here would be the
      // author describing the thing it points at, and the surface renders that
      // from the served record instead.
      return { kind: "ref", ref: refKind, id };
    }

    throw new BlockError(`${at}: unknown_block_kind (${kind}); known: ${BLOCK_KINDS.join(", ")}`);
  });
}

/** Internal references in these blocks, for a surface that resolves them up front. */
export function refsOfBlocks(blocks: readonly MessageBlock[]): Array<{
  kind: MessageRefKind;
  id: string;
}> {
  return blocks
    .filter((b): b is Extract<MessageBlock, { kind: "ref" }> => b.kind === "ref")
    .map((b) => ({ kind: b.ref, id: b.id }));
}

/** One-line summary for a surface with no room for the blocks themselves. */
export function summarizeBlocks(blocks: readonly MessageBlock[]): string {
  if (blocks.length === 0) return "";
  const counts = new Map<string, number>();
  for (const block of blocks) counts.set(block.kind, (counts.get(block.kind) ?? 0) + 1);
  const order = ["ref", "link", "fields", "code", "text"];
  return order
    .filter((k) => counts.has(k))
    .map((k) => `${counts.get(k)} ${k}`)
    .join(" · ");
}
