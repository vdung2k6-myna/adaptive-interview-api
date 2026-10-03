# Database Documentation

## Overview

The Adaptive Interview Engine uses **PostgreSQL 15+** with the **pgvector** extension. All database access lives in this backend repository (`adaptive-interview-api`). The Next.js frontend never connects to the database directly; it calls this backend's REST API.

## Technology

| Layer | Technology |
|---|---|
| Database | PostgreSQL 15+ |
| Vector extension | pgvector |
| ORM | Drizzle ORM |
| Driver | node-postgres (`pg`) |
| Connection pooling | `pg.Pool` via Drizzle |

## Schema

Schema definitions are in `src/lib/schema.ts`. Migrations are in `migrations/`.

### Tables

| Table | Purpose |
|---|---|
| `positions` | Job positions |
| `candidates` | Interview candidates |
| `interview_sessions` | Interview sessions linking candidates to positions |
| `messages` | Chat messages within a session |
| `embeddings` | Vector embeddings for semantic topic tracking |
| `campaigns` | Recruiting campaigns |
| `campaign_positions` | Many-to-many campaign ↔ position junction |
| `evaluation_versions` | Post-interview AI evaluations + human calibration |
| `evaluation_jobs` | Async evaluation job queue |
| `personas` | Voice-agent persona catalog (id, label, emoji, prompt, topics, answer mode) |

### `positions`

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` | Primary key, default random |
| `title` | `text` | Not null |
| `level` | `text` | Not null (Junior, Mid, Senior, Lead, Principal) |
| `job_description` | `text` | Optional long-form JD |
| `requirements` | `text[]` | Not null array |
| `created_at` | `timestamptz` | Default `now()` |

### `candidates`

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` | Primary key |
| `name` | `text` | Not null |
| `email` | `text` | Not null |
| `skills` | `text[]` | Not null array |
| `experience_years` | `integer` | Optional |
| `cv` | `text` | Optional full CV text |
| `created_at` | `timestamptz` | Default `now()` |

### `interview_sessions`

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` | Primary key |
| `position_id` | `uuid` | FK → `positions.id` |
| `candidate_id` | `uuid` | FK → `candidates.id` |
| `status` | `text` | `created`, `in_progress`, `completed` |
| `mode` | `text` | `text` (default) or `voice` |
| `tts_provider` | `text` | `kokoro` (default), `piper`, or `supertonic` |
| `language` | `text` | `english` (default) or `vietnamese` |
| `max_turns` | `integer` | Default `8` |
| `current_turn` | `integer` | Default `0` |
| `created_at` | `timestamptz` | Default `now()` |
| `completed_at` | `timestamptz` | Nullable |

### `messages`

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` | Primary key |
| `session_id` | `uuid` | FK → `interview_sessions.id` |
| `role` | `text` | `interviewer` or `candidate` |
| `content` | `text` | Not null |
| `audio_url` | `text` | Optional voice audio path |
| `audio_duration_seconds` | `integer` | Optional |
| `audio_format` | `text` | Optional |
| `stt_confidence` | `integer` | Optional STT confidence score |
| `created_at` | `timestamptz` | Default `now()` |

### `embeddings`

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` | Primary key |
| `source_type` | `text` | `requirement` or `message` |
| `source_id` | `uuid` | ID of the source row |
| `session_id` | `uuid` | Set for `message` sources |
| `content` | `text` | Text that was embedded |
| `embedding` | `text` | JSON string of float array (1024 dims) |
| `created_at` | `timestamptz` | Default `now()` |

Indexes: `embeddings_source_idx`, `embeddings_session_idx`.

### `evaluations` (legacy)

Legacy single-version evaluations. New evaluations are stored in `evaluation_versions`. This table remains for historical compatibility.

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` | Primary key |
| `session_id` | `uuid` | FK → `interview_sessions.id`, cascade delete |
| `model` | `text` | Model name |
| `raw_response` | `text` | Full LLM response |
| `technical_depth` | `integer` | 1-5 |
| `communication_clarity` | `integer` | 1-5 |
| `problem_solving` | `integer` | 1-5 |
| `relevance_to_role` | `integer` | 1-5 |
| `strengths` | `text[]` | Default `[]` |
| `weaknesses` | `text[]` | Default `[]` |
| `recommendation` | `text` | `strong_yes`, `yes`, `maybe`, `no`, `strong_no` |
| `confidence` | `integer` | 0-100 |
| `recruiter_notes` | `text` | Optional |
| `created_at` | `timestamptz` | Default `now()` |

### `evaluation_versions`

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` | Primary key |
| `session_id` | `uuid` | FK → `interview_sessions.id`, cascade delete |
| `model` | `text` | Model name |
| `raw_response` | `text` | Full LLM response |
| `ai_technical_depth` | `integer` | AI score 1-5 |
| `ai_communication_clarity` | `integer` | AI score 1-5 |
| `ai_problem_solving` | `integer` | AI score 1-5 |
| `ai_relevance_to_role` | `integer` | AI score 1-5 |
| `ai_recommendation` | `text` | AI recommendation |
| `ai_confidence` | `integer` | AI confidence 0-100 |
| `human_technical_depth` | `integer` | Human override 1-5 |
| `human_communication_clarity` | `integer` | Human override 1-5 |
| `human_problem_solving` | `integer` | Human override 1-5 |
| `human_relevance_to_role` | `integer` | Human override 1-5 |
| `human_recommendation` | `text` | Human recommendation |
| `strengths` | `text[]` | Default `[]` |
| `weaknesses` | `text[]` | Default `[]` |
| `recruiter_notes` | `text` | Optional |
| `human_calibrated` | `boolean` | Default `false` |
| `created_at` | `timestamptz` | Default `now()` |

Indexes: `evaluation_versions_session_idx`, `evaluation_versions_created_idx`.

### `evaluation_jobs`

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` | Primary key |
| `session_id` | `uuid` | FK → `interview_sessions.id`, cascade delete |
| `status` | `text` | `processing`, `completed`, `failed` |
| `error` | `text` | Optional failure message |
| `result_id` | `uuid` | FK → `evaluation_versions.id`, set null on delete |
| `model` | `text` | Optional model override |
| `created_at` | `timestamptz` | Default `now()` |
| `updated_at` | `timestamptz` | Default `now()` |

Indexes: `evaluation_jobs_session_idx`, `evaluation_jobs_status_idx`.

### `campaigns`

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` | Primary key |
| `name` | `text` | Not null |
| `description` | `text` | Optional |
| `start_date` | `timestamptz` | Optional |
| `end_date` | `timestamptz` | Optional |
| `tags` | `text[]` | Default `[]` |
| `status` | `text` | Default `draft` |
| `created_at` | `timestamptz` | Default `now()` |

### `campaign_positions`

| Column | Type | Notes |
|---|---|---|
| `campaign_id` | `uuid` | FK → `campaigns.id`, cascade delete |
| `position_id` | `uuid` | FK → `positions.id`, cascade delete |
| `added_at` | `timestamptz` | Default `now()` |

Indexes: `campaign_positions_campaign_idx`, `campaign_positions_position_idx`.

### `personas`

The voice agent's persona catalog. Unlike the other tables the primary key is a
**text slug**, not a UUID — `friendly-tutor` and so on — because the ids are
chosen by the client's own persona list rather than generated here.

| Column | Type | Notes |
|---|---|---|
| `id` | `text` | Primary key, a slug (`friendly-tutor`) |
| `label` | `text` | Not null, display name |
| `emoji` | `text` | Not null |
| `default_prompt` | `text` | Not null, the persona's system prompt |
| `knowledge_topics` | `text[]` | Default `[]`, collections this persona may draw on |
| `answer_mode` | `text` | Default `generate`; `material` speaks a retrieved passage instead |
| `sort_order` | `integer` | Default `0` |
| `created_at` | `timestamptz` | Default `now()` |
| `updated_at` | `timestamptz` | Default `now()` |

## Migrations

Migrations live in `migrations/` and are applied with Drizzle Kit:

```bash
npx drizzle-kit migrate
```

Drizzle records what it has applied in `drizzle.__drizzle_migrations`, and
decides what to apply from that table alone — it is not compared against the
schema. A database whose tables were created some other way (SQL run by hand,
`drizzle-kit push`) has an empty bookkeeping table, so `migrate` replays
`0000_initial` and fails on the first table that already exists; drizzle-kit
prints nothing when it does. See
[docs/SETUP.md § 4](SETUP.md#4-run-database-migrations) for the baseline repair
(`node scripts/db-baseline.mjs --apply`).

### Migration history

| File | Description |
|---|---|
| `migrations/0000_initial.sql` | Creates all core tables: positions, candidates, interview_sessions, messages, embeddings, evaluations, evaluation_versions, campaigns, campaign_positions |
| `migrations/0001_add_evaluation_jobs.sql` | Adds `evaluation_jobs` table |
| `migrations/0002_set_null_fk.sql` | Changes `evaluation_jobs.result_id` FK to `ON DELETE SET NULL` |
| `migrations/0003_certain_multiple_man.sql` | Adds `language` column to `interview_sessions` |
| `migrations/0004_add_personas.sql` | Creates `personas` and seeds it with the voice agent's personas, every one in `generate` answer mode |
| `migrations/0005_fix_friendly_tutor_topics.sql` | Corrects `friendly-tutor`'s `knowledge_topics` to `{thinking, Truyện cười}` — `0004` copied the client's list short |


## Vector Search

Semantic similarity queries over the `embeddings` table are implemented in `src/lib/embeddings.ts`. Embeddings are stored as JSON text because Drizzle does not natively support pgvector's `vector` type.

Cosine similarity is computed in raw SQL:

```sql
SELECT ...
FROM embeddings
WHERE source_type = ${sourceType}
ORDER BY (embedding::vector <=> ${targetVector}::vector)
LIMIT ${limit}
```

The default similarity threshold is controlled by `EMBEDDING_SIMILARITY_THRESHOLD` (default `0.75`).

## Seeding

**There is no seed script in this repository.** Earlier versions of this
document pointed at `npx tsx src/lib/seed.ts`; that file does not exist and
never has in this repository's history, and there is no `db:seed` npm script.
The only data a migration itself seeds is the `personas` catalog
(`0004_add_personas.sql`, corrected by `0005`).

To create a sample position and candidate for local development, either insert
them through the REST API — `POST /api/positions` and `POST /api/candidates` —
or write the rows directly with `psql`.

## Backup & Restore

Standard PostgreSQL tools:

```bash
# Backup
pg_dump $DATABASE_URL > backup.sql

# Restore
psql $DATABASE_URL < backup.sql
```

## Data Access Rules

- Only `src/lib/db.ts` creates the Drizzle instance; everything else imports that instance.
- Route handlers **do** import `db` and Drizzle operators directly. The intended layering is route handler → business logic, but `src/routes/*.ts` queries the database inline for its own reads and writes, and that is the prevailing pattern in practice.
- Drizzle's type-safe query builder is the default.
- Raw `sql` is used where the builder cannot express the query: vector similarity in `src/lib/embeddings.ts`, and the `IN (...)` list expansions in `src/routes/campaigns.ts` and the MCP tools.
