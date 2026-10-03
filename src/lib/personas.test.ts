import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { DEFAULT_ANSWER_MODE, toCatalog, toCatalogEntry, type PersonaRow } from "./personas";
import {
  CLIENT_LIST_CAPTURED_AT,
  CLIENT_LIST_COMMIT,
  CLIENT_LIST_REFERENCE,
  type ClientPersonaReference,
} from "./personas.client-list";

/**
 * The seed, and the list it is checked against.
 *
 * The seed is not one file. What a fresh deployment serves is every migration
 * replayed in journal order, and a migration after this one fixes a row by
 * `UPDATE`, so the seed is read as a fold over the journal rather than as the
 * text of `0004_add_personas.sql` — which stopped describing such a deployment
 * the moment anything else touched the table.
 *
 * The list the seed is checked against is recorded in `personas.client-list.ts`
 * rather than read out of the sibling checkout: the invariant has to hold on a
 * machine that has this repository and nothing else, and it has to hold whether
 * or not the client's list moved today. The sibling file is read here only by
 * the drift check, which is what notices the recorded list falling behind — and
 * that check skips, rather than fails, where the checkout is absent.
 */
const MIGRATIONS = resolve(__dirname, "../../migrations");
const JOURNAL = resolve(MIGRATIONS, "meta/_journal.json");
const CLIENT_LIST = resolve(
  __dirname,
  "../../../adaptive-interview/src/app/[locale]/voice-agent/personas.ts"
);

const SKIP_WITHOUT_CLIENT = existsSync(CLIENT_LIST)
  ? false
  : `the sibling client repository is not checked out, so there is nothing to compare the recorded reference against (looked for ${CLIENT_LIST})`;

/** The values of an `ARRAY[...]` literal, in order, with `''` read back as `'`. */
function readSqlArray(literal: string): string[] {
  return literal
    .split(",")
    .map((value) => value.trim())
    .map((value) => value.replace(/^'(.*)'$/, "$1").replace(/''/g, "'"));
}

/** The values of a `[ ... ]` literal as the client writes it. */
function readJsArray(literal: string): string[] {
  return literal
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
    .map((value) => value.replace(/^"(.*)"$/, "$1"));
}

interface SeededRow {
  id: string;
  topics: string[];
  answerMode: string;
}

/**
 * The migrations a fresh database runs, in the order it runs them.
 *
 * Read from the journal rather than from the directory: the journal is what
 * `drizzle-kit migrate` replays, and `idx` is what says in which order, so the
 * array's own order is not relied on.
 */
function migrationTags(): string[] {
  const journal = JSON.parse(readFileSync(JOURNAL, "utf8")) as {
    entries: { idx: number; tag: string }[];
  };

  assert.ok(
    journal.entries.length > 0,
    `read no migrations out of ${JOURNAL} — has the journal changed shape?`
  );

  return [...journal.entries]
    .sort((left, right) => left.idx - right.idx)
    .map((entry) => entry.tag);
}

/** The statements of one migration, in the order the database runs them. */
function migrationStatements(sql: string): string[] {
  return sql
    .replace(/\r\n/g, "\n")
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

/**
 * The rows a multi-row `INSERT` into the table contributes.
 *
 * A row is a line that opens with the two-space indent and the parenthesis the
 * `VALUES` list uses; the identifier is the first column, the topics the only
 * `ARRAY[...]` on the line, and the mode the column before the trailing
 * `sort_order`. Nothing else in such a statement has that shape — the comment
 * above the `INSERT` does not open with `('`, and no column value spans a line.
 */
function readInsert(sql: string, source: string): SeededRow[] {
  const rows = sql
    .split("\n")
    .filter((line) => line.startsWith("  ('"))
    .map((line): SeededRow => {
      const id = /^ {2}\('([^']+)',/.exec(line)?.[1];
      const topics = /ARRAY\[(.*?)\]/.exec(line)?.[1];
      const answerMode = /, '(generate|material)', \d+\)/.exec(line)?.[1];

      assert.ok(
        id !== undefined && topics !== undefined && answerMode !== undefined,
        `could not read an identifier, a topic array and an answer mode out of this seeded row in ${source}: ${line}`
      );

      return { id, topics: readSqlArray(topics), answerMode };
    });

  assert.ok(
    rows.length > 0,
    `read no rows out of the INSERT in ${source} — has the statement changed shape?`
  );

  return rows;
}

/**
 * Applies the one `UPDATE` shape the fold models: the topics of a single row,
 * chosen by identifier.
 *
 * The whole statement has to match, so an `UPDATE` that also sets another column,
 * or that narrows by anything but `"id"`, fails instead of being partly applied —
 * a fold that applied the part it recognised would report topics the database
 * does not hold. An `UPDATE` matching no row fails too: SQL would make it a
 * no-op, so modelling it as a rewrite would disagree with the database about
 * which rows exist.
 */
function applyUpdate(sql: string, rows: SeededRow[], source: string): void {
  const matched =
    /^UPDATE\s+"personas"\s+SET\s+"knowledge_topics"\s*=\s*ARRAY\[(.*?)\]\s+WHERE\s+"id"\s*=\s*'([^']*)';?$/is.exec(
      sql
    );

  if (matched === null) {
    throw new Error(
      `${source} runs an UPDATE on "personas" that this fold does not model, so the row it reads would not be the row the database serves: ${sql}`
    );
  }

  const id = matched[2];
  const row = rows.find((candidate) => candidate.id === id);

  assert.ok(
    row !== undefined,
    `${source} updates "${id}", which no migration before it inserts — this fold would report rows the database does not hold`
  );

  row.topics = readSqlArray(matched[1]);
}

/**
 * A statement with the comment and blank lines that open it removed, so what it
 * does can be read off its first word.
 *
 * Only the lines that open it: a `--` further in is left where it is, because a
 * comment marker inside a string literal is text and not a comment, and a
 * statement the fold then fails to recognise is a better outcome than one it
 * misreads.
 */
function withoutOpeningComments(statement: string): string {
  const lines = statement.split("\n");
  let start = 0;

  while (
    start < lines.length &&
    (lines[start].trim() === "" || lines[start].trim().startsWith("--"))
  ) {
    start += 1;
  }

  return lines.slice(start).join("\n").trim();
}

/**
 * Applies one statement to the rows, or fails when the statement is one the fold
 * does not model.
 *
 * The fold understands the two shapes the migrations use on this table and is
 * deliberately strict about everything else. A statement about the table that it
 * does not recognise fails the read rather than being skipped, because a fold
 * that ignored what it did not understand would under-model the seed in silence
 * and every comparison below would pass without comparing what a database
 * serves — the same failure the empty-read assertion exists to catch.
 *
 * What the statement *is* has to be read off it with the comments above it gone:
 * the seed's own migration explains itself at length before it inserts anything,
 * and a fold that classified statements by their first line would find a
 * paragraph of prose where it expected `INSERT`.
 */
function applyStatement(statement: string, rows: SeededRow[], source: string): void {
  const sql = withoutOpeningComments(statement);
  if (sql.length === 0) return;

  // DDL about the table changes no rows: a fresh database runs it and still
  // holds what the INSERTs put there, and a `DROP` followed by an `INSERT` reads
  // the same either way.
  if (/^(CREATE|ALTER|DROP|COMMENT|GRANT|REVOKE)\b/i.test(sql)) return;

  if (/^INSERT\s+INTO\s+"personas"/i.test(sql)) {
    rows.push(...readInsert(sql, source));
    return;
  }

  if (/^UPDATE\s+"personas"/i.test(sql)) {
    applyUpdate(sql, rows, source);
    return;
  }

  if (!/"personas"/i.test(sql)) return;

  // Any other statement naming the table changes its rows in a way this fold has
  // no model for — a `DELETE`, a `TRUNCATE`, an `INSERT ... ON CONFLICT` — and
  // failing here is the point.
  throw new Error(
    `${source} runs a statement about "personas" that this fold does not model, so the rows it reads would not be the rows the database serves: ${sql}`
  );
}

/**
 * The rows a fresh database serves, by replaying the migrations in journal order.
 */
function readSeed(): SeededRow[] {
  const rows: SeededRow[] = [];

  for (const tag of migrationTags()) {
    const source = `${tag}.sql`;

    for (const statement of migrationStatements(readFileSync(resolve(MIGRATIONS, source), "utf8"))) {
      applyStatement(statement, rows, source);
    }
  }

  // An empty read would make every comparison below pass without comparing
  // anything, which is the one way this test could fail silently.
  assert.ok(
    rows.length > 0,
    `replaying the migrations in ${MIGRATIONS} read no rows for "personas" — has the seed moved?`
  );

  return rows;
}

/**
 * Asserts that the rows serve every persona the reference declares, with the
 * topics it declares for it.
 *
 * This is the requirement's reading: the reference is a floor, not a ceiling, so
 * an identifier served here and not declared there is no failure — the seeded
 * personas the built-in list does not hold are served on purpose, and the client
 * is written to offer one. What fails is a reference identifier going unserved,
 * or being served with other topics.
 *
 * The two are reported apart because they send the reader to different places: an
 * unserved identifier has no topics to compare, and reporting it as a mismatch
 * would point at the row that is there instead of the one that is missing.
 */
function assertServesReference(rows: SeededRow[], reference: ClientPersonaReference[]): void {
  const served = new Map(rows.map((row) => [row.id, row]));

  for (const persona of reference) {
    const row = served.get(persona.id);

    assert.ok(
      row !== undefined,
      `the seed serves no "${persona.id}", which the client's built-in list holds and the reference records as of ${CLIENT_LIST_COMMIT} — a deployment with an empty database would have nothing to offer for it`
    );

    assert.deepEqual(
      row.topics,
      persona.topics,
      `the seed serves "${persona.id}" with ${JSON.stringify(row.topics)} where the client's built-in list declares ${JSON.stringify(persona.topics)} — the order is part of the topics`
    );
  }
}

/**
 * The client's built-in list as the sibling checkout declares it right now.
 *
 * Read as text rather than imported: what is compared is two lists of strings,
 * and importing would make this depend on that repository's module resolution
 * and on this process loading a `.ts` file from outside our root.
 *
 * Each identifier anchors a slice of the source that runs to the next one, and
 * the topics are read from within it — so a persona that declares none is
 * reported as having none rather than shifting the topics of the persona after
 * it. `knowledgeTopics` is optional on the client's interface.
 */
function readClientList(): ClientPersonaReference[] {
  const source = readFileSync(CLIENT_LIST, "utf8").replace(/\r\n/g, "\n");
  const identifiers = [...source.matchAll(/^ {4}id: "([^"]+)",/gm)];

  assert.ok(
    identifiers.length > 0,
    `read no personas out of ${CLIENT_LIST} — has the list changed shape?`
  );

  return identifiers.map((match, index) => {
    const start = match.index ?? 0;
    const end =
      index + 1 < identifiers.length
        ? (identifiers[index + 1].index ?? source.length)
        : source.length;

    const topics = /knowledgeTopics: \[([^\]]*)\]/.exec(source.slice(start, end))?.[1];

    return { id: match[1], topics: topics === undefined ? [] : readJsArray(topics) };
  });
}

/**
 * The one message the drift check reports, or `undefined` when the client's list
 * still says what the reference records.
 *
 * A difference is not a failure of the seed: the reference is a snapshot taken at
 * a commit, and the client is free to move past it. What the message therefore
 * has to carry is provenance and an action — which snapshot has fallen behind,
 * and that re-taking it is the fix — because nothing else in this repository
 * notices. That is what the earlier live read got wrong: it reported drift as a
 * broken invariant, with a message that named neither.
 */
function drift(
  observed: ClientPersonaReference[],
  reference: ClientPersonaReference[]
): string | undefined {
  const differences: string[] = [];
  const observedById = new Map(observed.map((persona) => [persona.id, persona]));

  for (const persona of reference) {
    const current = observedById.get(persona.id);

    if (current === undefined) {
      differences.push(`"${persona.id}" is recorded here but the list no longer declares it`);
    } else if (!isDeepStrictEqual(current.topics, persona.topics)) {
      differences.push(
        `"${persona.id}" declares ${JSON.stringify(current.topics)} where ${JSON.stringify(persona.topics)} is recorded`
      );
    }
  }

  const recorded = new Set(reference.map((persona) => persona.id));

  for (const persona of observed) {
    if (!recorded.has(persona.id)) {
      differences.push(`"${persona.id}" is declared by the list but nothing is recorded for it`);
    }
  }

  if (differences.length === 0) return undefined;

  return (
    `the client's built-in list no longer matches the reference in src/lib/personas.client-list.ts, ` +
    `recorded from adaptive-interview ${CLIENT_LIST_COMMIT} on ${CLIENT_LIST_CAPTURED_AT}: ` +
    `${differences.join("; ")}. Re-snapshot that file from the client's ` +
    `src/app/[locale]/voice-agent/personas.ts, commit and date included.`
  );
}

describe("the seeded persona catalog", () => {
  it("serves every persona the client's built-in list holds, with its topics", () => {
    assertServesReference(readSeed(), CLIENT_LIST_REFERENCE);
  });

  it("serves each identifier once", () => {
    const ids = readSeed().map((row) => row.id);

    assert.equal(
      new Set(ids).size,
      ids.length,
      "the seed inserts the same identifier twice, so a persona would be shadowed rather than served"
    );
  });

  /**
   * The fold's strictness, which is what keeps it from reading fewer rows than a
   * database would hold. Each statement below changes the table in a way the fold
   * has no model for, so the read has to fail and name the statement rather than
   * carry on comparing a seed it has under-modelled.
   */
  it("fails on a statement about the table that it does not model", () => {
    const unmodelled = [
      `DELETE FROM "personas" WHERE "id" = 'custom';`,
      `UPDATE "personas" SET "sort_order" = 5 WHERE "id" = 'custom';`,
      `TRUNCATE "personas";`,
    ];

    for (const statement of unmodelled) {
      assert.throws(
        () => applyStatement(statement, [], "0006_unmodelled.sql"),
        (error: Error) =>
          error.message.includes(statement) && error.message.includes("0006_unmodelled.sql"),
        `this statement changes the table and the fold accepted it rather than failing the read: ${statement}`
      );
    }
  });

  /**
   * What the coverage assertion reports when it fails. The reference is data
   * passed in, not a file, so a case can hand it something the rows do not serve
   * — which is also the only way to reach these messages, since the recorded
   * reference is expected to hold.
   */
  it("reports an unserved identifier apart from a topics mismatch", () => {
    const rows = readSeed();

    assert.throws(
      () => assertServesReference(rows, [{ id: "nobody", topics: ["Truyện cười"] }]),
      /serves no "nobody"/,
      "an identifier the seed does not serve was not reported as unserved"
    );

    assert.throws(
      () => assertServesReference(rows, [{ id: "friendly-tutor", topics: ["nonsense"] }]),
      /topics/,
      "a persona served with other topics than the list declares was accepted"
    );

    assert.throws(
      () =>
        assertServesReference(rows, [
          {
            id: "friendly-partner",
            topics: ["Behavioral Questions", "Story teller", "Truyện cười"],
          },
        ]),
      /topics/,
      "topics in a different order were accepted as the same topics, which the client's checkbox group renders in the order it declares"
    );
  });

  /**
   * The drift check, which is the only thing here that looks at the sibling
   * checkout — so it is the only thing that skips without it. Both tests below
   * read the file by path, so both are skipped together.
   */
  it("finds no drift between the client's built-in list and the recorded reference", { skip: SKIP_WITHOUT_CLIENT }, () => {
    assert.equal(
      drift(readClientList(), CLIENT_LIST_REFERENCE),
      undefined,
      "the client's list differs from the reference recorded here; the failure below says how"
    );
  });

  /**
   * Drift is reported once, with what is needed to act on it: the commit and date
   * the snapshot was taken at, what moved, and the instruction to re-snapshot.
   */
  it("reports drift as a stale reference, naming the commit, the date and the action", () => {
    const message = drift(
      [{ id: "friendly-tutor", topics: ["Truyện cười"] }],
      CLIENT_LIST_REFERENCE
    );

    assert.ok(
      message !== undefined,
      "a list that no longer declares what is recorded was reported as no drift at all"
    );

    for (const expected of [
      CLIENT_LIST_COMMIT,
      CLIENT_LIST_CAPTURED_AT,
      '"friendly-tutor"',
      '"custom"',
      "Re-snapshot",
    ]) {
      assert.ok(
        message.includes(expected),
        `the drift message does not say ${expected}, so it does not carry what to do about it: ${message}`
      );
    }
  });

  /**
   * The seed is what every row falls back to, and the change that introduces
   * material replies deliberately ships with no persona asking for one. A row
   * that later needs `material` belongs in its own migration: this file has been
   * applied, and editing it would leave every database that already ran it
   * disagreeing with every one that has not.
   */
  it("declares generate for every seeded row", () => {
    for (const row of readSeed()) {
      assert.equal(
        row.answerMode,
        "generate",
        `"${row.id}" is seeded in ${row.answerMode} mode; a persona that should speak material replies needs a new migration, not an edit to the one that inserted it`
      );
    }
  });
});

/** A complete row, so each test below states only the field it is about. */
function personaRow(overrides: Partial<PersonaRow> = {}): PersonaRow {
  return {
    id: "friendly-tutor",
    label: "Friendly Tutor",
    emoji: "🎓",
    defaultPrompt: "You are a friendly tutor.",
    knowledgeTopics: ["Truyện cười"],
    answerMode: DEFAULT_ANSWER_MODE,
    sortOrder: 20,
    ...overrides,
  };
}

describe("the catalog's read model", () => {
  it("reports every field a persona declares, and nothing the table keeps to itself", () => {
    const entry = toCatalogEntry(personaRow());

    assert.deepEqual(entry, {
      id: "friendly-tutor",
      label: "Friendly Tutor",
      emoji: "🎓",
      defaultPrompt: "You are a friendly tutor.",
      knowledgeTopics: ["Truyện cười"],
      answerMode: "generate",
    });
    assert.deepEqual(
      Object.keys(entry).sort(),
      ["answerMode", "defaultPrompt", "emoji", "id", "knowledgeTopics", "label"],
      "the catalog reports the fields it declares and no others — a timestamp or a sort order reaching the wire is a field the client did not ask for"
    );
  });

  it("reports a persona that asks for material replies as material", () => {
    assert.equal(toCatalogEntry(personaRow({ answerMode: "material" })).answerMode, "material");
  });

  it("reports a persona whose stored mode is not a mode as generating", () => {
    for (const stored of [null, "", "material ", "Material", "generated"]) {
      assert.equal(
        toCatalogEntry(personaRow({ answerMode: stored })).answerMode,
        DEFAULT_ANSWER_MODE,
        `a stored mode of ${JSON.stringify(stored)} was reported as something other than generating, which is not what such a persona does`
      );
    }
  });

  it("reports a persona with no topics as having none rather than dropping it", () => {
    const entry = toCatalogEntry(personaRow({ id: "bare", knowledgeTopics: [] }));

    assert.deepEqual(entry.knowledgeTopics, []);
    assert.equal(entry.id, "bare");
  });
});

describe("the catalog's order", () => {
  it("follows sort order rather than the order the rows arrive in", () => {
    const catalog = toCatalog([
      personaRow({ id: "third", sortOrder: 30 }),
      personaRow({ id: "first", sortOrder: 10 }),
      personaRow({ id: "second", sortOrder: 20 }),
    ]);

    assert.deepEqual(
      catalog.map((entry) => entry.id),
      ["first", "second", "third"]
    );
  });

  it("breaks a shared sort order by identifier, so the order is total", () => {
    const catalog = toCatalog([
      personaRow({ id: "b", sortOrder: 10 }),
      personaRow({ id: "a", sortOrder: 10 }),
    ]);

    assert.deepEqual(
      catalog.map((entry) => entry.id),
      ["a", "b"]
    );
  });

  it("leaves the rows it was given as they were", () => {
    const rows = [
      personaRow({ id: "third", sortOrder: 30 }),
      personaRow({ id: "first", sortOrder: 10 }),
    ];

    toCatalog(rows);

    assert.deepEqual(
      rows.map((row) => row.id),
      ["third", "first"],
      "sorting the caller's array in place would reorder whatever else holds it"
    );
  });
});
