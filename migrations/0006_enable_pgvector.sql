-- The embeddings column stores a JSON array as text and is cast to
-- vector(1024) at query time, so the extension must exist before the first
-- position query — not before the table was created. Idempotent, so a database
-- that already has it (or a re-run) is unaffected.
CREATE EXTENSION IF NOT EXISTS vector;
