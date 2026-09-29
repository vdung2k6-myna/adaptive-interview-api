/**
 * Record migrations the database has already had applied but drizzle has no
 * record of. Run it with `--apply` to write; without it, it only reports.
 *
 *   node scripts/db-baseline.mjs          # verify, change nothing
 *   node scripts/db-baseline.mjs --apply  # record what is verified as present
 *
 * Why this exists: `drizzle-kit migrate` decides what to apply from
 * `drizzle.__drizzle_migrations` alone — it takes the newest row's `created_at`
 * and applies every journal entry whose `when` is greater (drizzle-orm,
 * `pg-core/dialect.js`). A database whose schema was built some other way —
 * `drizzle-kit push`, or the SQL run by hand — has the tables and an empty
 * bookkeeping table, so every `migrate` replays `0000_initial` and dies on the
 * first `CREATE TABLE` that already exists. drizzle-kit's progress renderer
 * swallows that error, so the command just exits 1 with no message.
 *
 * The repair is to record what is already true, not to re-run anything. Each
 * migration is checked against the database first, and a migration whose
 * objects are not present **stops the run** rather than being recorded: a
 * baseline that marked unapplied work as applied would be worse than the empty
 * table it replaced.
 *
 * Idempotent: a migration already recorded (same `created_at`) is left alone.
 */
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import pg from "pg";

const REPO = new URL("..", import.meta.url);
const APPLY = process.argv.includes("--apply");

const DATABASE_URL = readFileSync(new URL("../.env", import.meta.url), "utf8")
  .split(/\r?\n/)
  .find((line) => line.startsWith("DATABASE_URL="))
  .slice("DATABASE_URL=".length)
  .trim();

const journal = JSON.parse(readFileSync(new URL("migrations/meta/_journal.json", REPO), "utf8"));

const client = new pg.Client({ connectionString: DATABASE_URL });
await client.connect();
const all = async (sql, params) => (await client.query(sql, params)).rows;
const one = async (sql, params) => (await all(sql, params))[0];

const tableExists = async (name) =>
  !!(await one("select 1 from information_schema.tables where table_schema='public' and table_name=$1", [name]));
const columnExists = async (table, column) =>
  !!(await one(
    "select 1 from information_schema.columns where table_schema='public' and table_name=$1 and column_name=$2",
    [table, column]
  ));
const constraintExists = async (name) =>
  !!(await one("select 1 from pg_constraint where conname=$1", [name]));
const indexExists = async (name) => !!(await one("select 1 from pg_indexes where indexname=$1", [name]));

/**
 * What each migration leaves behind, as something checkable. Written out per
 * migration rather than parsed out of the SQL: the point of the check is to be
 * a second opinion on "is this applied", and a parser would inherit whatever
 * the SQL got wrong.
 */
const PRESENT = {
  "0000_initial": async () => {
    const sql = readFileSync(new URL("migrations/0000_initial.sql", REPO), "utf8");
    const created = [...sql.matchAll(/CREATE TABLE "(\w+)"/g)].map((m) => m[1]);
    const missing = [];
    for (const table of created) if (!(await tableExists(table))) missing.push(`table ${table}`);
    return missing;
  },
  "0001_add_evaluation_jobs": async () => {
    const missing = [];
    if (!(await tableExists("evaluation_jobs"))) missing.push("table evaluation_jobs");
    for (const index of ["evaluation_jobs_session_idx", "evaluation_jobs_status_idx"]) {
      if (!(await indexExists(index))) missing.push(`index ${index}`);
    }
    for (const fk of [
      "evaluation_jobs_session_id_interview_sessions_id_fk",
      "evaluation_jobs_result_id_evaluation_versions_id_fk",
    ]) {
      if (!(await constraintExists(fk))) missing.push(`constraint ${fk}`);
    }
    return missing;
  },
  "0002_set_null_fk": async () => {
    // The migration's whole effect is that this FK deletes as SET NULL. Checking
    // only that it exists would pass on the 0001-shaped constraint it replaced.
    const fk = await one("select confdeltype from pg_constraint where conname=$1", [
      "evaluation_jobs_result_id_evaluation_versions_id_fk",
    ]);
    if (!fk) return ["constraint evaluation_jobs_result_id_evaluation_versions_id_fk"];
    if (fk.confdeltype !== "n") return [`constraint deletes as '${fk.confdeltype}', not SET NULL ('n')`];
    return [];
  },
  "0003_certain_multiple_man": async () =>
    (await columnExists("interview_sessions", "language")) ? [] : ["column interview_sessions.language"],
  "0004_add_personas": async () => {
    const missing = [];
    if (!(await tableExists("personas"))) missing.push("table personas");
    if (!(await columnExists("personas", "answer_mode"))) missing.push("column personas.answer_mode");
    return missing;
  },
  "0005_fix_friendly_tutor_topics": async () => {
    // This migration's whole effect is one row's topics, so the check is that row:
    // a table or column check would pass on the state `0004` already left behind,
    // which is exactly the state this migration exists to change.
    const row = await one("select knowledge_topics from personas where id=$1", ["friendly-tutor"]);
    if (!row) return ["row personas.friendly-tutor"];
    if (!row.knowledge_topics.includes("thinking")) {
      return [`personas.friendly-tutor topics are ${JSON.stringify(row.knowledge_topics)}, without 'thinking'`];
    }
    return [];
  },
};

const recorded = await all("select id, hash, created_at from drizzle.__drizzle_migrations order by created_at");
const recordedAt = new Set(recorded.map((row) => String(row.created_at)));
console.log(`drizzle.__drizzle_migrations holds ${recorded.length} row(s)`);

const toRecord = [];
let stopped = false;

for (const entry of journal.entries) {
  const sql = readFileSync(new URL(`migrations/${entry.tag}.sql`, REPO));
  const hash = createHash("sha256").update(sql.toString()).digest("hex");
  const check = PRESENT[entry.tag];

  if (!check) {
    console.log(`${entry.tag.padEnd(28)} no check defined — refusing to baseline it`);
    stopped = true;
    break;
  }

  const missing = await check();
  if (missing.length) {
    console.log(`${entry.tag.padEnd(28)} NOT PRESENT: ${missing.join(", ")}`);
    stopped = true;
    break;
  }

  if (recordedAt.has(String(entry.when))) {
    console.log(`${entry.tag.padEnd(28)} present, already recorded`);
    continue;
  }

  console.log(`${entry.tag.padEnd(28)} present, unrecorded → would record when=${entry.when}`);
  toRecord.push({ tag: entry.tag, hash, when: entry.when });
}

if (stopped) {
  console.log("\nStopping: the database does not hold every migration up to this point.");
  console.log("A baseline may only record what is already there. Nothing was written.");
  await client.end();
  process.exit(1);
}

if (!toRecord.length) {
  console.log("\nNothing to record — the bookkeeping already matches the migrations.");
  await client.end();
  process.exit(0);
}

if (!APPLY) {
  console.log(`\n${toRecord.length} migration(s) would be recorded. Re-run with --apply to write them.`);
  await client.end();
  process.exit(0);
}

await client.query("begin");
try {
  for (const { hash, when } of toRecord) {
    await client.query('insert into drizzle.__drizzle_migrations ("hash", "created_at") values ($1, $2)', [
      hash,
      when,
    ]);
  }
  await client.query("commit");
} catch (err) {
  await client.query("rollback");
  throw err;
}

const after = await all("select hash, created_at from drizzle.__drizzle_migrations order by created_at");
console.log(`\nRecorded ${toRecord.length} migration(s); the table now holds ${after.length}.`);
console.log(`newest row: created_at=${after[after.length - 1].created_at}`);

await client.end();
