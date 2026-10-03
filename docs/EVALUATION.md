# AI Evaluation System

## Overview

After an interview completes, the backend generates a structured evaluation using an Ollama LLM. Each evaluation creates a **new version** — existing evaluations are never overwritten, enabling:

- **Model comparison:** Run evaluations with different models and compare results
- **Human calibration:** Recruiters can override AI scores to build trust and alignment
- **Audit trail:** Full history of all evaluations for a session

## Evaluation Versions

Evaluations are stored in `evaluation_versions`. Each row represents one evaluation run:

| Field | Source | Description |
|---|---|---|
| `aiTechnicalDepth` | AI | 1-5 score |
| `aiCommunicationClarity` | AI | 1-5 score |
| `aiProblemSolving` | AI | 1-5 score |
| `aiRelevanceToRole` | AI | 1-5 score |
| `aiRecommendation` | AI | `strong_yes`, `yes`, `maybe`, `no`, `strong_no` |
| `aiConfidence` | AI | 0-100 confidence score |
| `humanTechnicalDepth` | Human | Recruiter override (1-5) |
| `humanCommunicationClarity` | Human | Recruiter override (1-5) |
| `humanProblemSolving` | Human | Recruiter override (1-5) |
| `humanRelevanceToRole` | Human | Recruiter override (1-5) |
| `humanRecommendation` | Human | Recruiter override recommendation |
| `humanCalibrated` | System | `true` when any human score/recommendation was saved |
| `model` | System | Which model generated this evaluation |
| `rawResponse` | System | Full LLM response (for debugging parse failures) |

## Evaluation Trigger

Evaluations are generated on-demand by the **Express backend** via an **async job queue** in `src/lib/evaluation.ts`:

### Flow

```
1. Client: POST /api/sessions/:id/evaluate
   └──► Backend returns 202 { jobId, status: "processing" }

2. Client: GET /api/evaluations/jobs/:jobId  (every 2 seconds)
   ├──► status: "processing" → keep polling
   ├──► status: "completed"  → fetch evaluation + display result
   └──► status: "failed"     → display error + allow retry
```

### API

- **Start:** `POST /api/sessions/:id/evaluate` (optional `{ model: "llama3.2" }` in body)
  - Returns `202 Accepted` with `{ jobId, status }`
  - If a job for this session is already `processing`, the same `jobId` is returned instead of starting a second run
- **Poll:** `GET /api/evaluations/jobs/:jobId`
  - Returns `{ id, sessionId, status, createdAt, updatedAt }`, plus `resultId` and `result` when completed, or `error` when failed
  - `result` is a reduced form: `{ id, aiScores, aiRecommendation, confidence, strengths, weaknesses, createdAt }`. Use `resultId` with `GET /api/evaluations/versions/:versionId` for the full row

### Condition

Session status must be `"completed"`.

Each trigger creates a **new version**. The latest version is always returned by `GET /api/evaluations/:sessionId`.

## Scoring Dimensions

All scores are integers on a 1-5 scale:

| Dimension | Description |
|---|---|
| **Technical Depth** | Depth of technical knowledge demonstrated |
| **Communication Clarity** | How clearly they explained their reasoning |
| **Problem Solving** | Ability to think through problems systematically |
| **Relevance to Role** | How well their experience matches the position |

## Evaluation Prompt

`src/lib/evaluation.ts` builds a detailed evaluation prompt. The system prompt asks the evaluator to write strengths, weaknesses, and other feedback in the interview's configured language when `session.language` is set.

```
You are an experienced technical hiring manager reviewing an interview transcript.

Position: Senior Full Stack Engineer (Senior)
Requirements: React, Node.js, PostgreSQL, System Design
Candidate: Jane Doe
Skills: React, Node.js, Python, AWS
Experience: 5 years

Interview transcript:
Interviewer: ...
Candidate: ...
...

Evaluate on these dimensions (1-5 scale):
- technical_depth
- communication_clarity
- problem_solving
- relevance_to_role

Also provide:
- strengths: array of 2-5 specific strengths
- weaknesses: array of 2-5 specific weaknesses
- recommendation: one of [strong_yes, yes, maybe, no, strong_no]
- confidence: 0-100 (how confident you are in this assessment)

Respond ONLY with valid JSON in this exact format:
{
  "technical_depth": 4,
  "communication_clarity": 3,
  "problem_solving": 4,
  "relevance_to_role": 5,
  "strengths": ["...", "..."],
  "weaknesses": ["...", "..."],
  "recommendation": "yes",
  "confidence": 78
}
```

## Parsing Strategy

The evaluation response is parsed with a **3-attempt retry strategy** in `src/lib/evaluation.ts`:

1. **Attempt 1:** Standard prompt + temperature 0.3
2. **Attempt 2:** Same prompt + `"CRITICAL: Respond ONLY with valid JSON. No markdown formatting, no extra text."`
3. **Attempt 3:** Same as attempt 2

If every attempt returns unparsable output, the raw response is stored with empty `strengths`/`weaknesses` and null scores so it can be reviewed later.

An `OllamaError` is **not** retried: it aborts the run immediately and fails the job, rather than being stored as an empty evaluation. Only parse failures consume the three attempts.

### Validation Rules

```typescript
// Required fields
typeof technical_depth === "number"
typeof communication_clarity === "number"
typeof problem_solving === "number"
typeof relevance_to_role === "number"
Array.isArray(strengths)
Array.isArray(weaknesses)
typeof recommendation === "string"
typeof confidence === "number"

// Range checks
scores.every(s => s >= 1 && s <= 5 && Number.isInteger(s))
confidence >= 0 && confidence <= 100 && Number.isInteger(confidence)
VALID_RECOMMENDATIONS.includes(recommendation)
```

## Human Calibration

The frontend transcript page supports human-in-the-loop calibration:

1. AI generates evaluation → scores appear as read-only star ratings
2. Recruiter clicks stars in "Human Override" section to set their scores
3. Recruiter selects recommendation from dropdown
4. Recruiter adds notes in "Recruiter Notes" textarea
5. Click "Save Calibration & Notes" → `PATCH /api/evaluations/:sessionId`
6. `humanCalibrated` is set to `true`, version is marked in history

### Deleting Versions

Non-latest versions can be deleted via `DELETE /api/evaluations/versions/:versionId`. The latest version cannot be deleted (ensures every session has at least one evaluation if any exist).

## Recommendation Scale

| Value | Meaning | Badge Color |
|---|---|---|
| `strong_yes` | Definitely hire | Green |
| `yes` | Hire | Emerald |
| `maybe` | On the fence | Yellow |
| `no` | Don't hire | Orange |
| `strong_no` | Definitely don't hire | Red |

## Model Selection

When generating or re-evaluating, clients can select a specific Ollama model:

| Model | Description |
|---|---|
| Default | Uses `OLLAMA_MODEL` env var (falls back to `llama3.1`) |
| Llama 3.1 | General purpose, good reasoning |
| Llama 3.2 | Faster, slightly lower quality |
| Qwen 2.5 | Strong technical evaluation |
| Mistral | Balanced performance |
| Gemma 2 | Lightweight, fast |

The selected model is stored in the evaluation version for auditability.

## Known Limitations

1. **Non-determinism:** Same candidate can get slightly different scores on re-evaluation (temperature 0.3 reduces but doesn't eliminate variance)
2. **Model bias:** Different models score differently — use versioning to compare and pick a consistent model per position
3. **Parse failures:** Some models return markdown-wrapped JSON or prose — the retry strategy handles most cases
4. **Single-human calibration:** Only one human score set per version (no multi-reviewer support yet)

## Future Improvements

- [ ] Score calibration against historical hires
- [ ] Multi-reviewer consensus (average scores from multiple recruiters)
- [ ] Custom evaluation rubrics per position
- [ ] Confidence threshold alerts (flag low-confidence evaluations)
