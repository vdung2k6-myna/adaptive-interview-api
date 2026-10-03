# Performance Guide

## Known Bottlenecks

### 1. Streaming Markdown Parsing (Frontend)

**Problem:** During Ollama streaming, `MarkdownRenderer` re-parses the full accumulated text on every React re-render. For 1000-character responses, this means `marked.parse()` + `highlight.js` + `DOMPurify.sanitize()` runs 10-20 times per second.

**Impact:** CPU usage spikes during streaming, especially on slower devices.

**Mitigation (applied in frontend):**
- Batch React state updates to ~50ms intervals (reduces re-renders from ~100/sec to ~20/sec)
- `React.memo` on `MarkdownRenderer` — completed messages skip re-parsing

`MessageBubble` (in the interview page) is **not** memoized: it is a plain function component, and the React Compiler is disabled in that repo, so nothing memoizes it automatically. Completed bubbles are re-rendered along with the streaming one. The 50ms batching is what keeps that affordable; memoizing `MessageBubble` remains an open item.

> This document describes the **frontend** repository (`adaptive-interview`), not this backend. The bottlenecks and metrics below are recorded here for reference because the two are deployed together.

### 2. Embedding on Critical Path (Backend)

**Problem:** `POST /api/messages` embeds the candidate's answer before calling Ollama. On slow hardware, embedding can take 1-3 seconds, blocking the first token.

**Impact:** User sees a long delay between submitting an answer and seeing the first interviewer token.

**Current status:** Acknowledged but not optimized. Embedding is required for topic tracking.

**Future fix:** Move embedding to a background job or fire-and-forget after sending the response.

### 3. Database Queries on Each Message (Backend)

**Problem:** The backend's message handler queries positions, candidates, messages, and embeddings for every turn.

**Impact:** N+1 query pattern for message history.

**Current status:** Acceptable for MVP with small datasets. Not a bottleneck unless interviews have 50+ turns.

## Optimizations Applied

### Streaming Batch Updates (Frontend)

```typescript
// Before: setData() on every chunk (~100/sec)
// After: setData() every ~50ms (~20/sec)

const BATCH_MS = 50;
let lastUpdate = 0;

if (performance.now() - lastUpdate >= BATCH_MS) {
  flushUpdate();
}
```

**Result:** ~5-10× fewer React re-renders during streaming.

### Memoized Components (Frontend)

| Component | Wrap | Benefit |
|---|---|---|
| `MarkdownRenderer` | `React.memo` | Skips re-parse when `content` unchanged |
| `MessageBubble` | *(none)* | Not memoized — see the note above |

**Result:** `MarkdownRenderer` is skipped for every message whose `content` is unchanged, so the per-chunk `marked.parse()` cost does not scale with conversation length.

### Tree-Shaken Highlight.js (Frontend)

Only 9 languages are registered instead of the full `highlight.js` bundle:

```typescript
import javascript from "highlight.js/lib/languages/javascript";
// ... 8 more languages
// Total: ~30KB instead of ~300KB
```

## Performance Metrics

### Streaming Throughput

| Scenario | Before Optimization | After Optimization |
|---|---|---|
| React re-renders/sec | ~50-100 | ~10-20 |
| Markdown parses/sec | ~50-100 | ~10-20 |
| Messages in render | All | Only streaming |
| Perceived smoothness | Choppy | Smooth |

### Bundle Size (Frontend)

| Dependency | Size | Notes |
|---|---|---|
| `marked` | ~30KB | Already installed |
| `highlight.js` (tree-shaken) | ~30KB | 9 languages only |
| `dompurify` | ~20KB | HTML sanitizer |
| **Total added** | **~80KB** | Gzipped |

## Monitoring

### Browser DevTools (Frontend)

Use React DevTools Profiler to measure:
- Component render times
- Re-render frequency
- Memoization effectiveness

Look for:
- `MarkdownRenderer` re-renders — should only re-render for the streaming message
- `MessageBubble` re-renders — currently re-renders for every message on each batch; memoizing it is the next win

### Server-Side (Backend)

Monitor API response times:

```bash
# PostgreSQL slow query log
psql ai_interview -c "SHOW log_min_duration_statement;"

# Ollama response times
curl -w "@curl-format.txt" http://localhost:11434/api/chat
```

## Future Optimizations

| Optimization | Impact | Effort |
|---|---|---|
| Move embeddings off critical path | High | Medium |
| Virtualize message list (react-window) | Medium | Low |
| CDN for static assets | Low | Low |
| Server-side rendering for dashboard | Medium | Medium |
| Connection pooling tuning | Low | Low |
| Model caching (Redis) | Medium | High |

## Profiling Tips

1. **Chrome DevTools Performance tab:** Record during streaming to see frame drops
2. **React DevTools Profiler:** Check "Highlight updates when components render"
3. **Lighthouse:** Run performance audit on `/interview/{id}`
4. **Web Vitals:** Monitor LCP, FID, CLS in production
