# Ollama Integration

## Overview

The backend communicates with Ollama via HTTP API calls. Both local and remote Ollama instances are supported.

## Configuration

Environment variables:

| Variable | Default | Description |
|---|---|---|
| `OLLAMA_BASE_URL` | `http://localhost:11434` | Ollama server endpoint |
| `OLLAMA_MODEL` | `llama3.1` | Chat model for interview questions |
| `OLLAMA_EMBED_MODEL` | `mxbai-embed-large` | Embedding model for vector search |

Runtime config in `src/lib/config/` provides defaults and timeout values.

## Client Module

All Ollama integration lives in `src/lib/ollama.ts`.

### `embedText(text: string): Promise<number[]>`

Generates a vector embedding for semantic similarity search.

- **Endpoint:** `POST /api/embeddings`
- **Model:** `mxbai-embed-large` (1024 dimensions)
- **Timeout:** Configurable via `config.ollama.embedTimeoutMs`

### `generateChatResponse(options): Promise<string>`

Blocking chat generation. Used for evaluation (post-interview scoring) where we need the full response before proceeding.

- **Endpoint:** `POST /api/chat`
- **Default model:** `OLLAMA_MODEL` or `llama3.1`
- **Temperature:** 0.7 (default)
- **Timeout:** Configurable via `config.ollama.chatTimeoutMs`

### `generateChatResponseStream(options): GenerateStreamResult`

Streaming chat generation. Used during the live interview for real-time token delivery.

- **Endpoint:** `POST /api/chat` with `stream: true`
- **Returns:** `{ stream: ReadableStream<string>, getFullText: () => string }`
- **Timeout:** Configurable via `config.ollama.chatTimeoutMs`

## Streaming Protocol

Ollama returns NDJSON (Newline-Delimited JSON):

```
{"message": {"content": "What"}, "done": false}
{"message": {"content": " is"}, "done": false}
{"message": {"content": " your"}, "done": false}
...
{"message": {"content": "?"}, "done": true}
```

Each line is parsed independently. Malformed lines are skipped gracefully.

## Prompt Construction

`src/lib/prompts.ts` builds the interview context:

```
You are an experienced technical interviewer conducting a structured interview.

Position: Senior Full Stack Engineer (Senior)
Requirements: React, Node.js, PostgreSQL, System Design

Candidate: Jane Doe
Skills: React, Node.js, Python, AWS
Experience: 5 years
Candidate CV summary:
[first 800 chars of CV]

Topics already covered: React hooks, REST APIs
Remaining topics to explore: PostgreSQL, System Design

Generate the next interview question. One concise question only, no preamble, no explanation.
Use Markdown formatting. If you include code examples, specify the language after the opening backticks.
Prioritize technical, role-relevant questions early in the interview. Behavioral questions should be natural follow-ups or come after the core technical requirements are covered.
```

**Important:** The system prompt is sent as a `user` message (not `system` role) because some cloud/proxy Ollama models don't accept `system` role messages.

When `session.language` is set to `vietnamese`, the system prompt instructs the model to conduct the interview in Vietnamese only.

## Conversation History

Past messages are appended to the context with role mapping:

| Our DB | Ollama Role |
|---|---|
| `interviewer` | `assistant` |
| `candidate` | `user` |

This ensures the model understands the conversation flow.

## Error Handling

Custom `OllamaError` class extends `Error` with an HTTP status code:

| Error | Status | Cause |
|---|---|---|
| Connection refused | 500 | Ollama not running |
| Timeout | 504 | Model is slow or unresponsive |
| Invalid JSON | 502 | Ollama returned malformed response |
| Empty content | 502 | Model returned empty message |

All errors bubble up to API route handlers, which return appropriate HTTP status codes to the client.

## Model Recommendations

| Model | Best For | Notes |
|---|---|---|
| `llama3.1` | General interviews | Fast, reliable, good reasoning |
| `qwen2.5-coder` | Coding-heavy roles | Strong code understanding |
| `mistral` | Speed | Very fast responses |

## Performance Tips

1. **Keep embeddings model loaded:** Run `ollama pull mxbai-embed-large` once
2. **Pre-load chat model:** `ollama run llama3.1` in a separate terminal to keep it warm
3. **Use local Ollama for development:** Cloud endpoints have latency and cold-start issues
4. **Monitor token throughput:** Streaming should feel responsive within 500ms of the first token
