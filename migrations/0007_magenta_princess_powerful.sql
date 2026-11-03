ALTER TABLE "interview_sessions" ALTER COLUMN "tts_provider" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "interview_sessions" ALTER COLUMN "tts_provider" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "interview_sessions" ADD COLUMN "tts_profile_id" text;