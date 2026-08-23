-- Drop the old FK constraint on evaluation_jobs.result_id
ALTER TABLE "evaluation_jobs"
  DROP CONSTRAINT IF EXISTS "evaluation_jobs_result_id_evaluation_versions_id_fk";

-- Recreate it with ON DELETE SET NULL
ALTER TABLE "evaluation_jobs"
  ADD CONSTRAINT "evaluation_jobs_result_id_evaluation_versions_id_fk"
  FOREIGN KEY ("result_id") REFERENCES "public"."evaluation_versions"("id")
  ON DELETE set null ON UPDATE no action;
