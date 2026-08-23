import { pgTable, uuid, text, integer, timestamp, boolean, index } from "drizzle-orm/pg-core";

export const positions = pgTable("positions", {
  id: uuid("id").primaryKey().defaultRandom(),
  title: text("title").notNull(),
  level: text("level").notNull(),
  jobDescription: text("job_description"),
  requirements: text("requirements").array().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const candidates = pgTable("candidates", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  email: text("email").notNull(),
  skills: text("skills").array().notNull(),
  experienceYears: integer("experience_years"),
  cv: text("cv"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const interviewSessions = pgTable("interview_sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  positionId: uuid("position_id").references(() => positions.id).notNull(),
  candidateId: uuid("candidate_id").references(() => candidates.id).notNull(),
  status: text("status").notNull().default("created"),
  mode: text("mode").notNull().default("text"),
  ttsProvider: text("tts_provider").notNull().default("kokoro"),
  maxTurns: integer("max_turns").notNull().default(8),
  currentTurn: integer("current_turn").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
});

export const messages = pgTable("messages", {
  id: uuid("id").primaryKey().defaultRandom(),
  sessionId: uuid("session_id").references(() => interviewSessions.id).notNull(),
  role: text("role").notNull(),
  content: text("content").notNull(),
  audioUrl: text("audio_url"),
  audioDurationSeconds: integer("audio_duration_seconds"),
  audioFormat: text("audio_format"),
  sttConfidence: integer("stt_confidence"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const embeddings = pgTable("embeddings", {
  id: uuid("id").primaryKey().defaultRandom(),
  sourceType: text("source_type").notNull(), // "requirement" | "message"
  sourceId: uuid("source_id").notNull(),
  sessionId: uuid("session_id"), // null for requirements, set for messages
  content: text("content").notNull(),
  embedding: text("embedding").notNull(), // JSON string of float array
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
},
(table) => [
  index("embeddings_source_idx").on(table.sourceType, table.sourceId),
  index("embeddings_session_idx").on(table.sessionId),
]);

export const evaluations = pgTable("evaluations", {
  id: uuid("id").primaryKey().defaultRandom(),
  sessionId: uuid("session_id")
    .references(() => interviewSessions.id, { onDelete: "cascade" })
    .notNull(),
  model: text("model").notNull(),
  rawResponse: text("raw_response").notNull(),
  technicalDepth: integer("technical_depth"),
  communicationClarity: integer("communication_clarity"),
  problemSolving: integer("problem_solving"),
  relevanceToRole: integer("relevance_to_role"),
  strengths: text("strengths").array().notNull().default([]),
  weaknesses: text("weaknesses").array().notNull().default([]),
  recommendation: text("recommendation"),
  confidence: integer("confidence"),
  recruiterNotes: text("recruiter_notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const evaluationVersions = pgTable(
  "evaluation_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sessionId: uuid("session_id")
      .references(() => interviewSessions.id, { onDelete: "cascade" })
      .notNull(),
    model: text("model").notNull(),
    rawResponse: text("raw_response").notNull(),

    aiTechnicalDepth: integer("ai_technical_depth"),
    aiCommunicationClarity: integer("ai_communication_clarity"),
    aiProblemSolving: integer("ai_problem_solving"),
    aiRelevanceToRole: integer("ai_relevance_to_role"),
    aiRecommendation: text("ai_recommendation"),
    aiConfidence: integer("ai_confidence"),

    humanTechnicalDepth: integer("human_technical_depth"),
    humanCommunicationClarity: integer("human_communication_clarity"),
    humanProblemSolving: integer("human_problem_solving"),
    humanRelevanceToRole: integer("human_relevance_to_role"),
    humanRecommendation: text("human_recommendation"),

    strengths: text("strengths").array().notNull().default([]),
    weaknesses: text("weaknesses").array().notNull().default([]),

    recruiterNotes: text("recruiter_notes"),
    humanCalibrated: boolean("human_calibrated").default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("evaluation_versions_session_idx").on(table.sessionId),
    index("evaluation_versions_created_idx").on(table.createdAt),
  ]
);

export const evaluationJobs = pgTable(
  "evaluation_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sessionId: uuid("session_id")
      .references(() => interviewSessions.id, { onDelete: "cascade" })
      .notNull(),
    status: text("status").notNull().default("processing"),
    error: text("error"),
    resultId: uuid("result_id").references(() => evaluationVersions.id, { onDelete: "set null" }),
    model: text("model"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("evaluation_jobs_session_idx").on(table.sessionId),
    index("evaluation_jobs_status_idx").on(table.status),
  ]
);

export const campaigns = pgTable("campaigns", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  description: text("description"),
  startDate: timestamp("start_date", { withTimezone: true }),
  endDate: timestamp("end_date", { withTimezone: true }),
  tags: text("tags").array().notNull().default([]),
  status: text("status").notNull().default("draft"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const campaignPositions = pgTable(
  "campaign_positions",
  {
    campaignId: uuid("campaign_id")
      .references(() => campaigns.id, { onDelete: "cascade" })
      .notNull(),
    positionId: uuid("position_id")
      .references(() => positions.id, { onDelete: "cascade" })
      .notNull(),
    addedAt: timestamp("added_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("campaign_positions_campaign_idx").on(table.campaignId),
    index("campaign_positions_position_idx").on(table.positionId),
  ]
);
