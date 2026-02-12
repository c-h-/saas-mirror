# saas-mirror — Unified Implementation Plan

> Generated: 2026-02-12
> Based on individual adapter plans: [Slack](adapters/slack/PLAN.md), [Notion](adapters/notion/PLAN.md), [Linear](adapters/linear/PLAN.md), [Gmail](adapters/gmail/PLAN.md)

---

## Implementation Status

| Component | Status | Notes |
|-----------|--------|-------|
| Core Framework | **Complete** | types, rate-limiter, state, output, retry, slugify, logger, engine, CLI |
| Linear Adapter | **Complete** | GraphQL client, queries, writer, adapter (full + incremental sync) |
| Slack Adapter | **Complete** | API wrapper, transform (mrkdwn→md), writer, adapter (full + incremental) |
| Gmail Adapter | **Complete** | Client, MIME parser, writer, adapter (full + incremental + differential) |
| Notion Adapter | **Complete** | API, block renderer (all block types), writer, adapter (full + incremental) |
| Core Tests | **Complete** | 42 tests: slugify, retry, state, output, rate-limiter, engine |
| Adapter Tests | **Complete** | Transform, writer, renderer, MIME parser tests for all adapters |
| README | **Complete** | Setup, configuration, usage, cron scheduling, architecture |
| TypeScript | **Passing** | All 5 packages compile cleanly |

---

## Executive Summary

This plan generalizes the four adapter-specific plans into a unified architecture. The goal: a single system where adding a new SaaS adapter means implementing a well-defined interface, with all shared concerns (rate limiting, state management, output rendering, error handling, resumability) handled by the core framework.

**Total estimated effort:** ~65 hours (~8 days)
- Core framework: ~16 hours
- Slack adapter: ~14 hours
- Notion adapter: ~19.5 hours
- Linear adapter: ~16 hours
- Gmail adapter: ~16 hours
- Integration/CLI: ~4 hours

---

## 1. Unified Architecture

### Package Layout

```
packages/
  core/           → Adapter interface, sync engine, state management,
                    rate limiter, output writer, CLI
adapters/
  slack/          → Slack-specific fetcher + transformer
  notion/         → Notion-specific fetcher + transformer
  linear/         → Linear-specific fetcher + transformer
  gmail/          → Gmail-specific fetcher + transformer
```

### Core Abstractions

Every adapter plan independently converged on the same patterns. We extract them into `@saas-mirror/core`:

```typescript
// ─── Adapter Interface ───
interface Adapter {
  name: string;
  sync(ctx: SyncContext): Promise<SyncResult>;
}

// ─── Sync Context (injected by engine) ───
interface SyncContext {
  mode: "full" | "incremental";
  outputDir: string;          // adapter-specific subdir
  state: AdapterState;        // load/save handled by engine
  rateLimiter: RateLimiter;   // configured per-adapter
  logger: Logger;
  signal: AbortSignal;        // for graceful shutdown
}

// ─── Adapter State ───
interface AdapterState {
  lastSyncAt: string | null;
  cursors: Record<string, string>;    // adapter-defined keys
  metadata: Record<string, unknown>;  // adapter-defined
  /** Mark a checkpoint (persisted immediately) */
  checkpoint(): Promise<void>;
}

// ─── Sync Result ───
interface SyncResult {
  adapter: string;
  mode: "full" | "incremental";
  itemsSynced: number;
  itemsFailed: number;
  errors: SyncError[];
  durationMs: number;
}

interface SyncError {
  entity: string;       // e.g. "channel:C123", "page:abc-def", "message:xyz"
  error: string;
  retryable: boolean;
}
```

---

## 2. Shared Components (Core Framework)

### 2a. Rate Limiter

All four services need rate limiting, but with different models:

| Service | Model | Config |
|---------|-------|--------|
| Slack | Tiered per-method (Tier 2: ~20/min, Tier 3: ~50/min) | Per-method tier, fixed delay between calls |
| Notion | Token bucket (~3 req/s) | 3 QPS global |
| Linear | Dual: 5k req/hr + 3M complexity/hr | Tracks both, reads response headers |
| Gmail | Quota units (15k units/min, different cost per endpoint) | Unit-based, per-call cost |

**Generalized rate limiter:**

```typescript
interface RateLimiterConfig {
  /** Requests per window */
  maxRequests?: number;
  /** Window duration in ms */
  windowMs?: number;
  /** Minimum delay between requests (ms) */
  minDelayMs?: number;
  /** Unit-based budget (like Gmail) */
  maxUnitsPerWindow?: number;
}

class RateLimiter {
  /** Acquire permission to make a call. Blocks if over limit. */
  async acquire(cost?: number): Promise<void>;
  /** Report a 429. Pauses all calls for retryAfterMs. */
  backoff(retryAfterMs: number): void;
  /** Update remaining budget from response headers. */
  updateFromHeaders(headers: Record<string, string>): void;
}
```

Each adapter configures its own limiter, but the implementation is shared. The `acquire(cost)` pattern covers both simple request counting (cost=1) and unit-based systems (Gmail: cost=5 for a message fetch).

### 2b. State Manager

All adapters need:
- Persist state between runs (cursors, timestamps, known IDs)
- Checkpoint mid-sync for crash resumability
- Atomic writes (write to temp file, rename)

```typescript
class StateManager {
  constructor(stateFilePath: string);
  async load(): Promise<AdapterState>;
  async save(state: AdapterState): Promise<void>;
  /** Save immediately (called mid-sync for resumability) */
  async checkpoint(state: AdapterState): Promise<void>;
}
```

State file format: JSON. Each adapter defines its own `cursors` and `metadata` shape.

### 2c. Output Writer

All four plans converged on the same output pattern:
- **Markdown file** with YAML frontmatter (for RAG/search)
- **JSON metadata sidecar** (for structured queries)
- **Binary files** (attachments/images) in a parallel directory

```typescript
interface OutputWriter {
  /** Write a markdown document with optional YAML frontmatter */
  writeDocument(relativePath: string, frontmatter: Record<string, unknown>, body: string): Promise<void>;
  /** Write a JSON metadata sidecar */
  writeMeta(relativePath: string, data: Record<string, unknown>): Promise<void>;
  /** Write a binary file (attachment, image) */
  writeBinary(relativePath: string, data: Buffer): Promise<void>;
  /** Delete a file (for handling deletions) */
  remove(relativePath: string): Promise<void>;
}
```

The writer handles:
- Creating directories on demand
- YAML frontmatter serialization (using `yaml` package)
- Atomic writes (temp + rename)
- Path sanitization / slug generation

### 2d. Slug Generator

All adapters need to turn titles/names into filesystem-safe paths:

```typescript
function slugify(text: string, maxLength?: number): string;
function uniqueSlug(text: string, id: string): string; // append short ID on collision
```

### 2e. Retry Helper

Shared exponential backoff with jitter:

```typescript
async function withRetry<T>(
  fn: () => Promise<T>,
  opts: { maxRetries: number; baseDelayMs: number; retryOn?: (err: any) => boolean }
): Promise<T>;
```

All adapters use this for transient errors (5xx, ECONNRESET, etc). 429s are handled by the rate limiter's `backoff()`.

### 2f. Logger

Structured logging with adapter context:

```typescript
interface Logger {
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
  progress(current: number, total: number, label: string): void;
}
```

---

## 3. Unified Output Format

### Directory Structure

```
data/
├── slack/
│   ├── _meta/
│   │   ├── users.json
│   │   ├── channels.json
│   │   └── state.json
│   ├── channels/
│   │   └── {channel-slug}/
│   │       ├── messages.md
│   │       ├── messages.jsonl
│   │       └── _meta.json
│   ├── threads/
│   │   └── {channel-slug}/
│   │       └── {thread-ts}.md
│   └── files/
│       └── {file-id}/
│           └── {filename}
├── notion/
│   ├── _meta/
│   │   ├── users.json
│   │   └── state.json
│   ├── pages/
│   │   └── {page-slug}/
│   │       ├── index.md
│   │       ├── _meta.json
│   │       └── {child-slug}/...
│   ├── databases/
│   │   └── {db-slug}/
│   │       ├── _schema.json
│   │       └── rows/
│   │           └── {row-slug}.md
│   └── assets/
│       └── {block-id}.{ext}
├── linear/
│   ├── _meta/
│   │   ├── teams.json
│   │   ├── users.json
│   │   ├── labels.json
│   │   ├── workflow-states.json
│   │   ├── cycles.json
│   │   └── state.json
│   ├── issues/
│   │   └── {team-key}/
│   │       └── {identifier}.md
│   ├── projects/
│   │   └── {slug}.md
│   └── attachments/
│       └── {identifier}/
│           └── {filename}
└── gmail/
    ├── _meta/
        ├── labels.json
    │   └── state.json
    ├── messages/
    │   └── {msg-id}.md
    ├── threads/
    │   └── {thread-id}.md
    └── attachments/
        └── {msg-id}/
            └── {filename}
```

### Consistent Document Format

Every markdown document across all adapters follows the same pattern:

```markdown
---
# YAML frontmatter: structured metadata
source: slack|notion|linear|gmail
type: message|page|issue|email
id: "unique-id"
title: "Human-readable title"
date: "ISO-8601"
# ... adapter-specific fields
---

# Document Title

(Content body — plaintext/markdown)
```

This consistency means a downstream RAG pipeline can:
1. Glob `data/**/*.md`
2. Parse frontmatter for metadata filtering
3. Use body text for embedding/search
4. Source field tells which adapter produced it

---

## 4. Sync Engine

The top-level orchestrator that runs adapters:

```typescript
class SyncEngine {
  constructor(config: SyncEngineConfig);

  /** Run sync for all configured adapters */
  async syncAll(mode: "full" | "incremental"): Promise<SyncResult[]>;

  /** Run sync for a specific adapter */
  async syncOne(adapterName: string, mode: "full" | "incremental"): Promise<SyncResult>;
}

interface SyncEngineConfig {
  outputDir: string;         // e.g. "./data"
  stateDir: string;          // e.g. "./data" (state.json per adapter)
  adapters: AdapterConfig[]; // which adapters to run
  concurrency: number;       // run adapters in parallel? (default: 1 = sequential)
}

interface AdapterConfig {
  name: string;
  enabled: boolean;
  env: Record<string, string>;  // adapter-specific env vars
  options?: Record<string, unknown>;
}
```

The engine:
1. Instantiates each adapter
2. Creates its `SyncContext` (state, limiter, logger, output writer)
3. Calls `adapter.sync(ctx)`
4. Collects results
5. Prints summary

---

## 5. Incremental Sync — Generalized Approach

Each service has a different change detection mechanism, but the adapter contract is the same:

| Service | Change Detection | State Key |
|---------|-----------------|-----------|
| Slack | `oldest` timestamp per channel | `cursors.channelHighWaterMark` |
| Notion | `last_edited_time` sort on search | `metadata.pageLastEdited` |
| Linear | `updatedAt` GraphQL filter | `cursors.lastSyncAt` |
| Gmail | History API `startHistoryId` | `cursors.historyId` |

The core framework doesn't need to know *how* each adapter detects changes — it just provides the `AdapterState` bag for storing whatever cursors/timestamps/IDs each adapter needs. The contract:

- `mode: "full"` → ignore state, fetch everything
- `mode: "incremental"` → use state to fetch only changes
- If state is empty/missing → fall back to full automatically

### Deletion Handling

| Service | How deletions are detected |
|---------|---------------------------|
| Slack | `subtype: "message_deleted"` events in history |
| Notion | Page disappears from search (diff known IDs) |
| Linear | Issues archived (`archivedAt` set); rarely deleted |
| Gmail | `messagesDeleted` events in History API |

Each adapter handles deletion in its own `sync()`. The `OutputWriter.remove()` method is available for all.

---

## 6. Error Handling — Generalized

### Isolation Principle

All adapters independently converged on **per-entity isolation**: if one channel/page/issue/message fails, log the error and continue. Never let one entity's failure abort the entire sync.

### Resumability Pattern

```
1. Sync starts
2. For each entity batch:
   a. Fetch from API
   b. Write to disk
   c. state.checkpoint()     ← persists progress
3. On crash/restart:
   - State reflects last checkpoint
   - Adapter resumes from there
4. On success:
   - Final state.save() with updated lastSyncAt
```

### Common Error Categories

| Error | Handling | All Adapters? |
|-------|----------|---------------|
| HTTP 429 (rate limit) | Rate limiter backoff + retry | ✅ |
| HTTP 5xx (server error) | Exponential backoff, max 3 retries | ✅ |
| HTTP 4xx (client error, not 429) | Log, skip entity, continue | ✅ |
| Network error (ECONNRESET, timeout) | Retry with backoff | ✅ |
| Auth failure (401/403) | Abort sync, surface error | ✅ |
| Parse failure (bad MIME, unexpected block) | Log warning, write raw/fallback, continue | ✅ |

---

## 7. CLI Design

```bash
# Sync everything (incremental by default)
saas-mirror sync

# Full hydration
saas-mirror sync --full

# Sync specific adapter
saas-mirror sync --adapter slack
saas-mirror sync --adapter notion --full

# Check status
saas-mirror status

# List configured adapters
saas-mirror adapters
```

Implementation: thin CLI wrapper using `commander` or `yargs` that instantiates `SyncEngine` and runs it.

---

## 8. Configuration

```yaml
# saas-mirror.config.yaml (or .json, or env vars)
outputDir: ./data
adapters:
  slack:
    enabled: true
    # env: SLACK_TOKEN
  notion:
    enabled: true
    # env: NOTION_TOKEN
  linear:
    enabled: true
    # env: LINEAR_API_KEY
  gmail:
    enabled: true
    # env: GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN
```

Adapters read their credentials from environment variables. Config file controls which adapters are enabled and any adapter-specific options (e.g., `skipDms`, `includeArchived`).

---

## 9. Dependencies (Shared)

### Core Package

| Package | Purpose |
|---------|---------|
| `yaml` | YAML frontmatter serialization |
| `p-queue` | Concurrency control |
| `p-retry` | Retry with backoff |
| `slugify` | Filesystem-safe naming |
| `commander` | CLI framework |
| `dotenv` | Env var loading |

### Per-Adapter

| Adapter | Key Dependency |
|---------|---------------|
| Slack | `@slack/web-api` |
| Notion | `@notionhq/client`, `p-throttle`, `mime-types` |
| Linear | `graphql-request` |
| Gmail | `googleapis`, `turndown`, `iconv-lite` |

---

## 10. Implementation Order

### Phase 1: Core Framework (~16 hours)
1. `packages/core/src/types.ts` — Expanded interfaces (SyncContext, AdapterState, etc.)
2. `packages/core/src/rate-limiter.ts` — Generalized rate limiter
3. `packages/core/src/state.ts` — State manager with checkpointing
4. `packages/core/src/output.ts` — Output writer (markdown + frontmatter + meta + binary)
5. `packages/core/src/retry.ts` — Retry helper
6. `packages/core/src/slugify.ts` — Slug generator
7. `packages/core/src/engine.ts` — Sync engine orchestrator
8. `packages/core/src/cli.ts` — CLI entry point
9. Tests for core components

### Phase 2: Adapters (parallel, ~50 hours total)

**Recommended order** (easiest → hardest, to validate core framework early):

1. **Linear** (~16 hrs) — Simplest API (clean GraphQL, good filtering, issues already markdown). Best for validating the core framework.
2. **Slack** (~14 hrs) — Straightforward REST, but thread explosion adds complexity.
3. **Gmail** (~16 hrs) — MIME parsing is gnarly but isolated. History API for incremental is elegant.
4. **Notion** (~19.5 hrs) — Most complex: recursive block tree, 50+ block type renderer, expiring URLs.

### Phase 3: Integration (~4 hours)
1. End-to-end test: `saas-mirror sync --full` with all adapters
2. Cron setup documentation
3. README updates
4. Performance tuning (concurrent adapters, batch sizes)

---

## 11. Risk Register

| Risk | Impact | Mitigation |
|------|--------|------------|
| Slack rate limits for unlisted apps | Full hydration takes hours | Use user token or list app; enterprise account gets Tier 3 |
| Notion block renderer complexity (50+ types) | Largest LOC component | Start with common types, add long-tail iteratively |
| Gmail MIME edge cases | Garbled output for unusual emails | Comprehensive test suite with real email samples |
| Expiring URLs (Notion, Linear CDN) | Missing assets if not downloaded immediately | Download-on-encounter, never defer |
| Large data volumes (100k emails, 10k Slack channels) | Long sync times, memory pressure | Streaming writes, progress checkpointing, batch processing |
| API breaking changes | Sync stops working | Pin API versions, monitor changelogs |
| OAuth token expiry (Gmail) | Sync fails silently | Auto-refresh + clear error on revocation |

---

## 12. Future Considerations

- **Embedding pipeline**: Post-sync step that chunks markdown and generates embeddings (e.g., via local model or OpenAI API). Store in vector DB (SQLite-vec, Qdrant, etc.).
- **Webhook listeners**: For Slack and Linear, real-time sync via webhooks instead of polling.
- **Deduplication**: Cross-adapter dedup (e.g., Linear issue linked in Slack message → single reference).
- **Search CLI**: `saas-mirror search "query"` using local embeddings.
- **Selective sync**: Sync only specific channels/pages/labels based on config filters.
