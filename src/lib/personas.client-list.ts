/**
 * The client's built-in persona list, recorded here rather than read from the
 * sibling checkout.
 *
 * `personas.test.ts` asserts that the seeded catalog serves every persona this
 * list holds, with the topics it declares for it. That comparison used to read
 * `adaptive-interview`'s `src/app/[locale]/voice-agent/personas.ts` by path, and
 * both consequences were real: the assertion held only where that repository was
 * checked out, so a run without it reported the check skipped and stayed green,
 * and an edit over there — the client trimming `custom-2` and adding `thinking`
 * to `friendly-tutor` in `32afcae` — reddened this repository's suite with
 * nothing here having changed.
 *
 * So the list is a snapshot, and the guard is written against it. A separate
 * drift check in `personas.test.ts` still reads the sibling file, when it is
 * present, and fails when the client has moved away from what is recorded here;
 * that failure names this snapshot's commit and date and the action to take.
 * Nothing else notices this file going stale, which is why the two travel with
 * it.
 *
 * The built-in list is the floor the catalog has to reach, not a ceiling it has
 * to stop at: a catalog serving personas this list does not hold satisfies the
 * requirement, and it already does — see `interview/persona-catalog`, "The
 * client reads the catalog, and survives its absence".
 */

/** One persona as the client's built-in list declares it. */
export interface ClientPersonaReference {
  id: string;
  /** `knowledgeTopics` as declared, in the order the list declares them. */
  topics: string[];
}

/** The `adaptive-interview` commit the snapshot below was read from. */
export const CLIENT_LIST_COMMIT = "32afcae";

/** The day it was read from that commit. */
export const CLIENT_LIST_CAPTURED_AT = "2026-09-29";

/**
 * The identifiers and topics themselves, in the order the client declares them.
 *
 * The topics' order is part of the data: they are compared with `deepEqual`, and
 * the client renders its checkbox group in this order. The identifiers' order is
 * not compared — the catalog sorts by `sort_order` — but it is kept as the
 * client declares it, so re-snapshotting is a transcription rather than a sort.
 */
export const CLIENT_LIST_REFERENCE: ClientPersonaReference[] = [
  { id: "friendly-partner", topics: ["Story teller", "Behavioral Questions", "Truyện cười"] },
  { id: "friendly-tutor", topics: ["thinking", "Truyện cười"] },
  {
    id: "interview-coach",
    topics: ["STAR Method", "Behavioral Questions", "Technical Interview", "Truyện cười"],
  },
  { id: "language-partner", topics: ["Truyện cười"] },
  { id: "coding-assistant", topics: ["C# 12", "System Design", "Algorithms", "Truyện cười"] },
  { id: "debate-partner", topics: ["Truyện cười"] },
  { id: "custom", topics: ["Truyện cười"] },
];
