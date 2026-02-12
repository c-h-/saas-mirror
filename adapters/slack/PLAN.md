# Slack Adapter — Implementation Plan

> Generated: 2026-02-12. To be used as the implementation spec for `adapters/slack/src/adapter.ts`.

---

## 1. Data Model

### Entities & Schemas

#### Channel
```typescript
interface SlackChannel {
  id: string;               // C0123456789
  name: string;             // "general"
  type: "public" | "private" | "im" | "mpim";
  topic: string;
  purpose: string;
  memberCount: number;
  isArchived: boolean;
  created: number;          // Unix timestamp
}
```

#### User
```typescript
interface SlackUser {
  id: string;               // U0123456789
  name: string;             // "charlie"
  realName: string;         // "Charlie Hulcher"
  displayName: string;
  email?: string;           // requires users:read.email scope
  isBot: boolean;
  isDeleted: boolean;
  avatar72: string;         // URL
}
```

#### Message
```typescript
interface SlackMessage {
  ts: string;               // "1707000000.000100" — unique ID + timestamp
  channelId: string;
  userId: string;
  text: string;             // mrkdwn-formatted text
  blocks?: any[];           // Block Kit blocks (rich text source of truth)
  threadTs?: string;        // parent thread ts (if this is a reply)
  replyCount?: number;      // >0 means this message is a thread parent
  reactions?: SlackReaction[];
  files?: SlackFile[];
  edited?: { user: string; ts: string };
  subtype?: string;         // "message_deleted", "channel_join", etc.
}
```

#### Thread
Threads are not a separate entity — they are a collection of messages sharing the same `thread_ts`. The parent message (where `ts === thread_ts`) lives in channel history. Replies may or may not appear in channel history depending on `reply_broadcast`.

#### Reaction
```typescript
interface SlackReaction {
  name: string;             // "thumbsup"
  count: number;
  users: string[];          // user IDs
}
```

#### File
```typescript
interface SlackFile {
  id: string;
  name: string;
  mimetype: string;
  size: number;             // bytes
  urlPrivateDownload: string;
  permalink: string;
  createdAt: number;
}
```

---

## 2. Full Hydration Flow

### Prerequisites
- **Token:** Bot token (`xoxb-`) or user token (`xoxp-`) stored in `SLACK_TOKEN` env var.
- **Scopes (bot):** `channels:read`, `channels:history`, `groups:read`, `groups:history`, `im:read`, `im:history`, `mpim:read`, `mpim:history`, `users:read`, `users:read.email`, `files:read`, `reactions:read`.
- Alternatively umbrella scopes: `conversations:read`, `conversations:history`.

### Step-by-step

```
1. AUTH
   - Validate token via `auth.test` → get team_id, user_id, team name.
   - Abort if invalid.

2. USERS
   - GET users.list (paginate with cursor, limit=200)
   - Build userId→User map, write to outputDir/users.json

3. CHANNELS
   - GET conversations.list(types=public_channel,private_channel,im,mpim, limit=200)
   - Paginate via response_metadata.next_cursor
   - For IMs/MPIMs: resolve user IDs to names for display
   - Write channel index to outputDir/channels.json

4. PER-CHANNEL HISTORY
   For each channel:
   a. GET conversations.history(channel=ID, limit=200)
      - Paginate via cursor until has_more=false
      - Collect all messages
   b. For each message with reply_count > 0:
      - GET conversations.replies(channel=ID, ts=thread_ts, limit=200)
      - Paginate if needed
      - Merge replies into message record (or store separately)
   c. For each message with files[]:
      - Download file via GET urlPrivateDownload with Authorization: Bearer token
      - Save to outputDir/files/{file_id}/{filename}
   d. Write channel output (see §4 Output Format)

5. RATE LIMIT STRATEGY
   - Base delay: 1000ms between API calls
   - On 429: read Retry-After header, sleep that many seconds + 1s jitter
   - conversations.history is Tier 3 (~50 req/min)
   - conversations.replies is Tier 3
   - users.list is Tier 2 (~20 req/min)
   - ⚠️ Post-May 2025: unlisted apps may be throttled to 1 req/min on history with limit=15. Mitigation: list app in Slack Marketplace, or use user token.
```

### API Endpoints Reference

| Endpoint | Tier | Max `limit` | Notes |
|---|---|---|---|
| `auth.test` | 4 | — | Validate token |
| `users.list` | 2 | 200 | Cursor-paginated |
| `conversations.list` | 2 | 1000 | Cursor-paginated, use `types` param |
| `conversations.history` | 3 | 1000 (safe: 200) | Cursor + time-based pagination |
| `conversations.replies` | 3 | 1000 (safe: 200) | Cursor-paginated |
| `reactions.get` | 3 | — | Per-message; skip if reactions in history response |
| `files.list` | 3 | 100 | Optional; files already embedded in messages |

### Pagination Strategy
All paginated endpoints return `response_metadata.next_cursor`. Loop until cursor is empty string or undefined. Always use cursor-based (not time-based) pagination for full hydration to ensure completeness.

---

## 3. Incremental Sync Flow

### State Schema (persisted in `stateFile`)
```typescript
// Extends core SyncState
interface SlackSyncState extends SyncState {
  cursors: {};  // not used for Slack
  metadata: {
    /** Per-channel: ts of newest message seen */
    channelHighWaterMark: Record<string, string>;  // channelId → latest message ts
    /** Per-thread: ts of latest reply seen */
    threadHighWaterMark: Record<string, string>;    // thread_ts → latest reply ts
    /** Last full channel list refresh */
    lastChannelListAt: string;
    /** Known channel IDs (to detect new/removed channels) */
    knownChannelIds: string[];
    /** User list last refreshed */
    lastUsersRefreshAt: string;
  };
}
```

### Flow

```
1. Load state from stateFile (or run full hydration if null)

2. DETECT NEW CHANNELS
   - Re-fetch conversations.list
   - Compare against knownChannelIds
   - New channels → full-hydrate those channels
   - Removed channels → optionally mark as archived

3. PER-CHANNEL INCREMENTAL
   For each known channel:
   a. GET conversations.history(channel=ID, oldest=highWaterMark, limit=200)
      - oldest= is exclusive, so we get messages newer than our last seen
   b. Process new messages:
      - If message has reply_count > 0 AND thread_ts > threadHighWaterMark:
        fetch conversations.replies(ts=thread_ts, oldest=threadHighWaterMark)
      - If message has subtype "message_deleted": mark stored message as deleted
      - If message has edited.ts: update stored message text
   c. Update highWaterMark to max ts seen
   d. Append new messages to channel output file

4. THREAD UPDATES (threads may get new replies without new channel messages)
   - For known active threads (reply_count changed or thread_ts in last N days):
     Re-fetch conversations.replies to catch new replies
   - Heuristic: only re-check threads with activity in last 7 days to bound API calls

5. USERS (refresh weekly or on unknown user ID encountered)
   - If lastUsersRefreshAt > 7 days ago: re-fetch users.list
   - Or: on encountering unknown userId in a message, fetch users.info(user=ID)

6. Save updated state
```

### Change Detection Summary

| Change Type | Detection Method |
|---|---|
| New messages | `oldest` param on conversations.history |
| New threads | `reply_count > 0` on new messages |
| New thread replies | conversations.replies with `oldest` |
| Edited messages | `edited` field on message object; re-fetch time window |
| Deleted messages | `subtype: "message_deleted"` in history |
| New channels | Compare conversations.list with known IDs |
| New users | Lazy fetch on unknown user ID |

---

## 4. Output Format

### Directory Structure
```
outputDir/
├── _meta/
│   ├── users.json                    # Full user map
│   ├── channels.json                 # Channel index
│   └── sync-state.json              # (or wherever stateFile points)
├── channels/
│   ├── general/
│   │   ├── messages.md               # Human-readable conversation log
│   │   ├── messages.jsonl            # Machine-readable, one message per line
│   │   └── _meta.json               # Channel metadata sidecar
│   ├── engineering/
│   │   ├── messages.md
│   │   ├── messages.jsonl
│   │   └── _meta.json
│   └── dm--charlie--brandon/
│       ├── messages.md
│       ├── messages.jsonl
│       └── _meta.json
├── threads/
│   └── {channelName}/
│       └── {thread_ts}.md            # Full thread as standalone doc (for RAG chunking)
└── files/
    └── {file_id}/
        └── {original_filename}
```

### File Naming Convention
- Channel dirs: slugified channel name (`general`, `eng-standup`). DMs: `dm--{user1}--{user2}` (sorted). MPIMs: `mpim--{user1}--{user2}--{user3}`.
- Thread files: `{thread_ts}.md` (e.g. `1707000000.000100.md`)
- Files: `{file_id}/{original_filename}` to avoid collisions

### Markdown Format (messages.md)
```markdown
---
channel: general
channel_id: C0123456789
type: public
exported_at: 2026-02-12T08:58:00-08:00
---

## 2026-02-11

**charlie** (09:15 AM):
Hey team, the deploy went well.

> **brandon** (09:17 AM) [thread]:
> Nice! Any issues with the migration?

> **charlie** (09:18 AM) [thread]:
> Nope, clean run.

**nick** (10:30 AM):
Working on the API docs today.

---

## 2026-02-12

**teja** (08:00 AM):
Sprint planning in 30 min.
```

### JSONL Format (messages.jsonl)
One JSON object per line, sorted by ts ascending:
```json
{"ts":"1707000000.000100","user":"U123","userName":"charlie","text":"Hey team, the deploy went well.","threadTs":null,"reactions":[{"name":"thumbsup","count":2}],"files":[],"edited":null,"date":"2026-02-11T09:15:00-08:00"}
```

### Metadata Sidecar (_meta.json)
```json
{
  "channelId": "C0123456789",
  "channelName": "general",
  "type": "public",
  "topic": "General discussion",
  "purpose": "Company-wide chat",
  "memberCount": 42,
  "messageCount": 12543,
  "oldestMessage": "2024-01-15T...",
  "newestMessage": "2026-02-12T...",
  "lastSyncAt": "2026-02-12T08:58:00-08:00"
}
```

### RAG Optimization
- Thread files in `threads/` are self-contained documents ideal for chunking — they include full context (channel, participants, topic).
- Markdown files use date headers as natural chunk boundaries.
- JSONL enables structured retrieval with metadata filtering.

---

## 5. Error Handling

### Rate Limits (429)
```typescript
async function rateLimitedCall<T>(fn: () => Promise<T>, methodTier: number): Promise<T> {
  try {
    const result = await fn();
    await sleep(tierDelay(methodTier)); // 1200ms for T2, 600ms for T3, 200ms for T4
    return result;
  } catch (err) {
    if (err.status === 429) {
      const retryAfter = parseInt(err.headers?.['retry-after'] ?? '30', 10);
      console.warn(`Rate limited. Retrying in ${retryAfter}s`);
      await sleep((retryAfter + 1) * 1000);
      return rateLimitedCall(fn, methodTier); // retry
    }
    throw err;
  }
}
```

### Token Issues
- `invalid_auth` / `token_revoked` → abort sync, surface error in SyncResult.errors.
- Bot tokens (`xoxb-`) don't expire. User tokens from OAuth may need refresh — use `oauth.v2.access` with refresh token if applicable.

### Partial Failures
- Per-channel error isolation: if one channel fails, log error, continue with next.
- Track failed channels in state so they retry on next run.
- SyncResult.errors accumulates all per-channel errors.

### Resumability
- State is saved after each channel completes (not just at end of sync).
- On crash/restart: channels with updated highWaterMark are skipped; channels without are retried.
- For full hydration: save a `hydratedChannels: string[]` list in state to skip already-completed channels.

```typescript
interface SlackSyncState {
  metadata: {
    // ... previous fields ...
    /** Channels fully hydrated (for resuming interrupted full sync) */
    hydratedChannels?: string[];
    /** Channels that failed last run (retry these) */
    failedChannels?: string[];
  };
}
```

---

## 6. Edge Cases

### Thread Replies Not in Channel History
- `conversations.history` returns thread **parent** messages but NOT replies (unless `reply_broadcast=true`).
- Must call `conversations.replies` for every message with `reply_count > 0`.
- This is the single largest source of API calls. For a workspace with 10K threads, that's 10K+ additional calls.
- Optimization: batch thread fetches per channel, skip threads with `reply_count === 0`.

### Message Edits & Deletes
- **Edits:** The `edited` field appears on the message object with `edited.ts`. The `text` field reflects the current (edited) version. Previous versions are NOT available via API.
- **Deletes:** A `message_deleted` subtype event appears in history with `deleted_ts` pointing to the removed message's ts. Handle by marking the stored message as deleted (or removing it).
- For incremental sync: re-fetching a time window catches both edits and deletes.

### File URL Expiration
- `url_private_download` requires the bot token as Bearer auth.
- URLs do NOT expire as long as the token is valid and the file exists.
- But files on Free plan older than 90 days become inaccessible.
- **Strategy:** Download files eagerly during sync, store locally. Never rely on URLs for later access.

### Rich Text / Blocks → Plaintext Conversion
```typescript
function blocksToText(blocks: any[]): string {
  // Handle block types: rich_text, section, header, context, divider, image
  // For rich_text blocks: iterate elements → extract text, apply mrkdwn
  // For section blocks: extract text field
  // For image blocks: emit "[Image: alt_text]"
  // For code blocks: wrap in backticks
  // Fallback: use message.text (Slack always provides a text fallback)
}
```
- Slack messages always have a `text` field as plaintext fallback even when blocks are present.
- For RAG purposes, `text` field is usually sufficient. Use blocks only for richer rendering.
- User/channel mentions in text: `<@U123>` and `<#C456|general>`. Replace with resolved names using user/channel maps.

### DMs vs Channels
- DMs (`im`) and group DMs (`mpim`) use the same conversations.* API.
- DMs have no `name`; use participant user names for directory naming.
- DMs require `im:history` / `im:read` scopes (or umbrella equivalents).
- Privacy consideration: DMs may contain sensitive content. Consider optional `--skip-dms` flag.

### Free vs Enterprise Differences
| Feature | Free | Pro | Business+ | Enterprise Grid |
|---|---|---|---|---|
| Message history | 90 days / 10K msgs | Full | Full | Full |
| File retention | 90 days | Full | Full | Full |
| Private channel export (admin) | ❌ | ❌ | ✅ | ✅ |
| API rate limits | Standard | Standard | Standard | Standard (higher for Discovery API) |
| `is_limited` flag on history | May appear | No | No | No |

- When `conversations.history` returns `is_limited: true`, log a warning: older messages are inaccessible.
- Free plan users should be warned that sync is inherently incomplete.

### Other Edge Cases
- **Shared channels (Slack Connect):** May have limited API access. `is_shared` flag on channel. Bot must be in the channel.
- **Deactivated users:** Still appear in `users.list` with `deleted: true`. Keep in user map for resolving old messages.
- **Bot messages:** Messages from integrations/bots have `bot_id` instead of `user`. Resolve via `bots.info` or display as bot name.
- **Message subtypes:** `channel_join`, `channel_leave`, `channel_topic`, `pinned_item`, etc. Filter these out or render them as system messages.
- **Unicode/emoji:** Slack uses `:emoji_name:` syntax. Optionally convert to Unicode via emoji mapping.
- **Very large channels (#general with 100K+ messages):** Full hydration may take hours. Progress logging essential.

---

## 7. Dependencies

### NPM Packages
```json
{
  "@slack/web-api": "^7.0.0",      // Official Slack SDK (handles auth, pagination helpers, types)
  "@saas-mirror/core": "workspace:*" // Core adapter interface
}
```

No other packages required. The `@slack/web-api` SDK handles:
- Auth, HTTP, retries (built-in rate limit handling with `rejectRateLimitedCalls: false`)
- Cursor pagination helpers
- TypeScript types for all API responses

Optional (if we want richer text conversion):
```json
{
  "slack-block-to-markdown": "^0.1.0"  // Or write our own (likely <100 LOC)
}
```

### Environment Variables
```
SLACK_TOKEN          # xoxb-... or xoxp-... (required)
SLACK_SKIP_DMS       # "true" to skip DMs (optional, default false)
SLACK_SKIP_FILES     # "true" to skip file downloads (optional, default false)
SLACK_MAX_CHANNELS   # number, for testing (optional)
```

### Config (in SyncOptions)
- `outputDir`: Where to write markdown/jsonl/files
- `stateFile`: Where to persist sync state JSON
- `mode`: "full" | "incremental"

---

## 8. Estimated Complexity

### Lines of Code
| Component | Est. LOC |
|---|---|
| `adapter.ts` (main sync orchestrator) | 250 |
| `api.ts` (rate-limited API wrapper) | 100 |
| `transform.ts` (blocks→text, mention resolution, markdown rendering) | 150 |
| `state.ts` (sync state management) | 50 |
| `types.ts` (Slack-specific type definitions) | 80 |
| `output.ts` (file writing: md, jsonl, meta) | 120 |
| Tests | 200 |
| **Total** | **~950 LOC** |

### Time Estimate
| Phase | Time |
|---|---|
| API wrapper + rate limiting | 2 hours |
| Full hydration flow | 3 hours |
| Incremental sync flow | 2 hours |
| Text conversion (blocks→md, mention resolution) | 2 hours |
| Output format (md, jsonl, meta files) | 1.5 hours |
| Error handling + resumability | 1.5 hours |
| Testing + edge cases | 2 hours |
| **Total** | **~14 hours** |

### Risk Factors
- **Post-May 2025 rate limit changes** for unlisted apps could make full hydration extremely slow (1 req/min on history). Mitigation: use user token or list app.
- **Thread explosion**: workspaces with heavy threading could have 10x the API calls. Mitigation: concurrent thread fetches with rate limiter.
- **Large file downloads**: could dominate sync time. Mitigation: `--skip-files` flag, parallel downloads.

---

## Appendix: Implementation Order

1. `types.ts` — Define interfaces
2. `api.ts` — Rate-limited Slack API wrapper using `@slack/web-api`
3. `state.ts` — State load/save
4. `transform.ts` — Message text conversion
5. `output.ts` — File writers (md, jsonl, meta)
6. `adapter.ts` — Wire it all together: full hydration + incremental
7. Tests
8. README + CLI integration
