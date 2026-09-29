import type {
  KnowledgeChunk,
  KnowledgeSearchOutcome,
  KnowledgeSectionChunk,
} from "@/lib/knowledge";
import type { AnswerMode } from "@/lib/personas";

/**
 * Material replies: the turns whose answer is the corpus's own words.
 *
 * A material turn locates its reply rather than composing one. The search is
 * asked for a single result, expanded to that result's whole section, and the
 * section never reaches a prompt, because a material turn has no prompt; the
 * hit supplies the facts the gate decides on — its `collections` and `score` —
 * and the passage to speak, its `section` beside the size the service states
 * for it (design.md D2, D3).
 *
 * Two stages, split because they fail differently and only the first is pure:
 *
 *   selectMaterialHit   the gate — preference ∩ speakability ∩ confidence ∩ a
 *                       section that came back whole (D3)
 *   sectionToReply      the passage — the section joined, its heading once (D4)
 *
 * `resolveMaterialReply` composes them for the route, which is the one caller
 * that wants either a reply or the reason there is none (D9). Nothing here
 * throws or rejects: a rejection with no handler ends the process under Node's
 * default `--unhandled-rejections=throw`, which would turn a doc-etl-api fault
 * into a dead server instead of the degraded turn every reason below asks for.
 */

/**
 * The speakable collection set and the confidence floor — `AppConfig["material"]`,
 * passed as a value so this module holds no configuration of its own.
 *
 * Which passages may be spoken is a property of the corpus and how close a hit
 * must be is its calibration (D4, D5). Neither belongs to a persona, and a
 * persona cannot widen either: `collections` is read here and nowhere else.
 */
export interface MaterialPolicy {
  collections: string[];
  scoreFloor: number;
}

/**
 * How many results a material turn's search asks for.
 *
 * One, because the search is a locator on such a turn and not a context source
 * (D1): a hit is wanted for the passage it carries and its own gate fields, and
 * more candidates would only cost the service work no one reads. A reused
 * prefetch is the exception the route cannot control — it was issued for the
 * generating path and holds several — and the gate scans them in order, so the
 * turn is answered from the first eligible one.
 */
export const MATERIAL_LOCATOR_TOP_K = 1;

/**
 * Why a turn was not answered from the material, by the gate.
 *
 * Each names a condition the eligibility requirement states, so a log line built
 * from one says which half of the gate refused: the persona's preference
 * (`generate_mode`), the search (`no_hit`), the corpus (`not_speakable`), the
 * hit's own confidence (`below_floor`), or the passage itself (`no_section`,
 * `section_incomplete`).
 */
export type MaterialSkipReason =
  | "generate_mode" // the persona did not ask for material replies
  | "no_hit" // the search failed, was refused, or located nothing to gate on
  | "not_speakable" // no collection on the hit is in the speakable set
  | "below_floor" // the hit's score is under the floor, or was not reported
  | "no_section" // the search returned no section for this hit to speak
  | "section_incomplete"; // the section returned was shorter than the one the service stated

/** The gate's answer: the hit a turn is to be answered from, or why it is not. */
export type MaterialSelection =
  | { ok: true; hit: KnowledgeChunk }
  | { ok: false; reason: MaterialSkipReason };

/**
 * Why a turn whose hit was eligible still spoke nothing.
 *
 * One reason, and it is about the passage rather than about any request: the
 * section came back whole and holds no words. Kept apart from
 * `MaterialSkipReason` because the gate did not refuse this hit — the reply did.
 */
export type MaterialReplyReason = "text_empty";

/** Every reason a turn was generated instead of read, gate and reply alike. */
export type MaterialFallbackReason = MaterialSkipReason | MaterialReplyReason;

/** The reply a material turn speaks — carrying the hit it came from so the
 * caller can log which source answered — or the reason it generated instead. */
export type MaterialOutcome =
  | { ok: true; text: string; hit: KnowledgeChunk }
  | { ok: false; reason: MaterialFallbackReason };

/**
 * The gate, as a pure decision: which hit — if any — this turn is answered from.
 *
 * Returns the *hit* rather than its text because eligibility is a question about
 * the passage's provenance and completeness, not about its words: the caller
 * joins the section afterwards, and it is the hit that names the source the
 * reply is attributed to (D3, D4).
 *
 * `outcome` is nullable because a material turn whose enabled topics resolve to
 * no collection issues no search at all, and that is a turn with nothing to gate
 * on rather than a turn to refuse.
 *
 * Candidates are scanned in the order the service ranked them, and the first
 * *eligible* one locates the turn. On the locator path there is only ever one
 * (the search asks for a single result), so this matters only for a reused
 * prefetch, which was issued for the generating path and may hold three: a
 * persona whose topics span a speakable collection and an unspeakable one should
 * be answered from the speakable one rather than from whichever the ranking
 * happened to put first. The ranking itself is never re-derived here — the floor
 * is the only judgement this side of the service makes (D4).
 */
export function selectMaterialHit(input: {
  outcome: KnowledgeSearchOutcome | null;
  answerMode: AnswerMode;
  policy: MaterialPolicy;
}): MaterialSelection {
  const { outcome, answerMode, policy } = input;

  // The preference first: it is the cheapest fact to read, it is the one a turn
  // can be refused on alone, and a persona that did not ask for material replies
  // never has its hits gated however eligible they look.
  if (answerMode !== "material") {
    return { ok: false, reason: "generate_mode" };
  }

  if (!outcome || !outcome.ok || outcome.chunks.length === 0) {
    return { ok: false, reason: "no_hit" };
  }

  let firstFailure: MaterialSkipReason | null = null;
  for (const hit of outcome.chunks) {
    const failure = gateReason(hit, policy);
    if (!failure) {
      return { ok: true, hit };
    }
    firstFailure ??= failure;
  }

  // Nothing was eligible, so the first failure is the top-ranked hit's — the one
  // the search itself offered as this turn's answer, and so the honest reason.
  return { ok: false, reason: firstFailure ?? "no_hit" };
}

/** Which half of the gate a hit fails, or `null` when it passes both. */
function gateReason(hit: KnowledgeChunk, policy: MaterialPolicy): MaterialSkipReason | null {
  // An absent `collections` fails here too, which is what degrades a service
  // older than the routing fields to generation rather than to a mistake: it
  // cannot say which collection a hit is in, so this side cannot say it is
  // speakable (D6). An empty speakable set fails identically, and that is the
  // property that makes shipping this safe — a deployment that has not chosen a
  // collection generates every reply, exactly as it does today (D5).
  if (!hit.collections?.some((collection) => policy.collections.includes(collection))) {
    return "not_speakable";
  }

  // An unreported score is not a confident one; there is no number that says so.
  // Both ends are inclusive of the floor: "at or above" is what the requirement
  // states, and a hit sitting exactly on a measured floor is the case the floor
  // was chosen for.
  if (typeof hit.score !== "number" || hit.score < policy.scoreFloor) {
    return "below_floor";
  }

  // The passage, tested last because it is the only condition about the reply
  // rather than about permission to speak it. An absent section is the older
  // service and the unasked-for search alike: neither can say what this hit's
  // passage is, so the turn generates rather than speaking the search's quote as
  // though it were the whole thing.
  const section = hit.section;
  if (!section?.length) {
    return "no_section";
  }

  // A bounded expansion returns fewer chunks than the section holds and says how
  // many it holds in `sectionSize`, so the two agree only when the whole passage
  // came back. An absent size refuses here too — it is not a size, and a reply
  // cannot be known to be complete without one.
  if (section.length !== hit.sectionSize) {
    return "section_incomplete";
  }

  return null;
}

/**
 * The words of a section: the hit's passage, joined in reading order, with its
 * heading spoken once.
 *
 * Every chunk of a section is stored with the section's heading prefixed to its
 * text, so a seventeen-chunk section repeats that heading seventeen times. The
 * heading is recovered rather than looked up, because the service reports no
 * heading field — only the chunks — by testing whether every chunk opens with
 * the same first line. That test deliberately does not ask whether the line *is*
 * a heading: the operation wanted is "collapse a line every chunk repeats at its
 * head", which is right for a heading and harmless for anything else, and it
 * leaves a heading-less section alone because such a section's chunks share no
 * first line.
 *
 * Reading order is applied here rather than inherited. The service returns the
 * section in order, but the reply's ordering is not something to take on trust
 * when each chunk's position is in hand. The input array is not sorted in place:
 * it is the search's, and a caller may still be reading it.
 */
export function sectionToReply(chunks: KnowledgeSectionChunk[]): string {
  if (!chunks.length) return "";

  const ordered = [...chunks].sort((a, b) => a.position - b.position);
  const firstLine = ordered[0].text.split("\n", 1)[0];
  const headed = ordered.every((chunk) => chunk.text.split("\n", 1)[0] === firstLine);

  return ordered
    .map((chunk, index) =>
      // Only the first keeps the heading; the rest give up the line they repeat.
      // Slicing the heading's length rather than matching it leaves the newline
      // that followed it, so one is removed by hand — otherwise every remainder
      // would open with a blank line.
      headed && index > 0 ? chunk.text.slice(firstLine.length).replace(/^\r?\n/, "") : chunk.text
    )
    .join("\n\n");
}

/**
 * A material turn's reply, or why it was generated instead.
 *
 * The one entry point the route calls (D9): the gate, then the passage, then
 * either the text to speak or a reason to log and generate. Nothing here reaches
 * the content service — the passage arrived with the search that located it, so
 * there is no second request whose failure could answer a turn (design.md D1).
 */
export async function resolveMaterialReply(input: {
  outcome: KnowledgeSearchOutcome | null;
  answerMode: AnswerMode;
  policy: MaterialPolicy;
}): Promise<MaterialOutcome> {
  const selection = selectMaterialHit(input);
  if (!selection.ok) {
    return selection;
  }

  // The gate proved a section is there, so the empty array is unreachable; it is
  // what this reads rather than a claim the type system cannot carry.
  const text = sectionToReply(selection.hit.section ?? []);

  // A whole section of blank chunks would otherwise be spoken as a silence under
  // a reply that looked like it succeeded. The text itself is untrimmed: what is
  // spoken is what the index holds.
  if (!text.trim()) {
    console.warn(
      `[Material] the section of ${JSON.stringify(selection.hit.source)} holds no text`
    );
    return { ok: false, reason: "text_empty" };
  }

  return { ok: true, text, hit: selection.hit };
}
