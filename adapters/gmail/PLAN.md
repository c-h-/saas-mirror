# Gmail Adapter — Implementation Plan

> **Status:** Draft  
> **Date:** 2026-02-12  
> **Author:** Doink (OpenClaw)  
> **Target:** `adapters/gmail/src/adapter.ts` implementing `Adapter` from `@saas-mirror/core`

---

## 1. Data Model

### Entities

#### Label
```typescript
interface GmailLabel {
  id: string;              // e.g. "INBOX", "Label_123"
  name: string;            // e.g. "INBOX", "Work/Projects"
  type: "system" | "user";
}
```

#### Message
```typescript
interface GmailMessage {
  id: string;              // Gmail message ID
  threadId: string;        // Gmail thread ID
  labelIds: string[];      // ["INBOX", "UNREAD", "Label_5"]
  historyId: string;       // For incremental sync tracking
  internalDate: number;    // Unix ms timestamp (Gmail's internalDate)
  // Parsed headers:
  from: string;
  to: string;
  cc?: string;
  bcc?: string;
  subject: string;
  date: string;            // RFC 2822 Date header value
  messageId: string;       // RFC 2822 Message-ID header
  inReplyTo?: string;      // For threading
  references?: string;
  // Body:
  bodyPlain?: string;      // text/plain content
  bodyHtml?: string;       // text/html content (fallback)
  snippet: string;         // Gmail's snippet (first ~100 chars)
  // Attachments (metadata only; files stored separately):
  attachments: AttachmentMeta[];
  // Size:
  sizeEstimate: number;    // bytes
}

interface AttachmentMeta {
  attachmentId: string;    // Gmail attachment ID (for fetching)
  filename: string;
  mimeType: string;
  size: number;            // bytes
  contentId?: string;      // For inline images (cid: references)
}
```

#### Thread
Threads are **not stored as a separate entity**. Instead, messages reference `threadId`. Output can be grouped by thread at render time. This avoids duplicating data and matches Gmail's model where a thread is just a collection of messages sharing a `threadId`.

#### Sync State (persisted via `SyncState` from core)
```typescript
// Stored in SyncState.cursors and SyncState.metadata:
interface GmailSyncState {
  cursors: {
    historyId: string;       // Last synced historyId for incremental
  };
  metadata: {
    totalMessages: number;
    lastFullSyncAt?: string; // ISO timestamp
    emailAddress: string;    // Authenticated user
  };
}
```

### Thread vs Message Model Decision

**Message-centric.** Each message is fetched and stored individually. Rationale:
- Gmail's API charges the same quota for `messages.get` (5 units) vs `threads.get` (10 units for the whole thread, but you get all messages). For full hydration, listing messages is simpler (one flat list with pagination). For incremental sync, the History API returns message-level events.
- Threads are reconstructed at output time by grouping on `threadId` and sorting by `internalDate`.
- Exception: for very large threads (100+ messages), `threads.get` would be more efficient than N individual `messages.get` calls. We can optimize this later.

---

## 2. Full Hydration Flow

### Prerequisites
- OAuth2 credentials (client_id, client_secret, refresh_token) with scope `https://www.googleapis.com/auth/gmail.readonly`
- `googleapis` npm package configured with OAuth2 client

### Step-by-step

#### Step 1: Authenticate
```typescript
const auth = new google.auth.OAuth2(clientId, clientSecret);
auth.setCredentials({ refresh_token: refreshToken });
const gmail = google.gmail({ version: "v1", auth });
```
The `googleapis` library handles token refresh automatically when `refresh_token` is set.

#### Step 2: Fetch labels
```
GET /gmail/v1/users/me/labels
```
- **Quota:** 1 unit
- Store label map `id → name` for later use. Cache locally.

#### Step 3: List ALL message IDs
```
GET /gmail/v1/users/me/messages?maxResults=500&includeSpamTrash=false
```
- **Quota:** 5 units per call
- **Pagination:** Returns `{ messages: [{id, threadId}], nextPageToken, resultSizeEstimate }`. Loop with `pageToken` until no `nextPageToken`.
- **Volume:** For 100k messages, this is ~200 pages × 5 units = 1,000 units (trivial).
- Store all IDs in memory (or stream to a work queue file for resumability).
- **Note:** `includeSpamTrash=false` by default. Set to `true` if we want spam/trash.

#### Step 4: Batch-fetch message content
```
GET /gmail/v1/users/me/messages/{id}?format=full
```
- **Quota:** 5 units per message
- **Strategy:** Use Google's HTTP batch API to send up to **100 requests per batch call**. This reduces HTTP overhead dramatically.
  - Batch endpoint: `POST https://www.googleapis.com/batch/gmail/v1`
  - Body: multipart/mixed with individual GET requests
  - Each sub-request still costs 5 units
- **Rate management:** 15,000 units/min per user → 3,000 messages/min → **50 messages/sec**. With batches of 100, that's 1 batch every 2 seconds.
- **Parallelism:** Run 2-3 concurrent batch requests, sleeping to stay under quota.
- **Resumability:** Track which message IDs have been fetched. Write a `progress.json` with the set of completed IDs. On restart, skip already-fetched messages.

#### Step 5: Parse MIME payload
For each message response, extract headers and body from `payload`:

```typescript
function parseMessage(msg: gmail_v1.Schema$Message): GmailMessage {
  const headers = msg.payload?.headers ?? [];
  const getHeader = (name: string) => 
    headers.find(h => h.name?.toLowerCase() === name.toLowerCase())?.value ?? "";
  
  const { plain, html, attachments } = walkParts(msg.payload);
  
  return {
    id: msg.id!,
    threadId: msg.threadId!,
    labelIds: msg.labelIds ?? [],
    historyId: msg.historyId!,
    internalDate: parseInt(msg.internalDate!, 10),
    from: getHeader("From"),
    to: getHeader("To"),
    cc: getHeader("Cc") || undefined,
    bcc: getHeader("Bcc") || undefined,
    subject: getHeader("Subject"),
    date: getHeader("Date"),
    messageId: getHeader("Message-ID"),
    inReplyTo: getHeader("In-Reply-To") || undefined,
    references: getHeader("References") || undefined,
    bodyPlain: plain,
    bodyHtml: html,
    snippet: msg.snippet ?? "",
    attachments,
    sizeEstimate: msg.sizeEstimate ?? 0,
  };
}
```

MIME walking (recursive):
```typescript
function walkParts(part: gmail_v1.Schema$MessagePart | undefined): {
  plain: string; html: string; attachments: AttachmentMeta[];
} {
  let plain = "", html = "";
  const attachments: AttachmentMeta[] = [];
  
  if (!part) return { plain, html, attachments };
  
  const mime = part.mimeType ?? "";
  
  if (mime === "text/plain" && part.body?.data) {
    plain += Buffer.from(part.body.data, "base64url").toString("utf-8");
  } else if (mime === "text/html" && part.body?.data) {
    html += Buffer.from(part.body.data, "base64url").toString("utf-8");
  } else if (part.filename && part.body?.attachmentId) {
    attachments.push({
      attachmentId: part.body.attachmentId,
      filename: part.filename,
      mimeType: mime,
      size: part.body.size ?? 0,
      contentId: part.headers?.find(h => h.name === "Content-ID")?.value?.replace(/[<>]/g, ""),
    });
  }
  
  if (part.parts) {
    for (const sub of part.parts) {
      const result = walkParts(sub);
      plain += result.plain;
      html += result.html;
      attachments.push(...result.attachments);
    }
  }
  
  return { plain, html, attachments };
}
```

#### Step 6: Download attachments
```
GET /gmail/v1/users/me/messages/{msgId}/attachments/{attachmentId}
```
- **Quota:** 5 units per call
- Returns `{ data: "<base64url-encoded>" }`
- **Strategy:** Only download if attachment size < configured max (default: 25MB). Skip or log larger ones.
- **Storage:** Write to `{outputDir}/attachments/{msgId}/{filename}`
- **Deduplication:** Hash-based dedup (SHA-256 of content). Store hash→path map. If same hash seen, symlink/hardlink instead of duplicating.
- **Timing:** Do attachment downloads as a second pass after all message metadata is saved. This way message text is available even if attachment download fails.

#### Step 7: Record historyId
After all messages are fetched, call:
```
GET /gmail/v1/users/me/profile
```
- Returns `{ emailAddress, messagesTotal, threadsTotal, historyId }`
- **Quota:** 5 units
- Save `historyId` to `SyncState.cursors.historyId` for incremental sync.

---

## 3. Incremental Sync Flow

### History API
```
GET /gmail/v1/users/me/history?startHistoryId={id}&historyTypes=messageAdded,messageDeleted,labelAdded,labelRemoved&maxResults=500
```
- **Quota:** 2 units per call
- **Pagination:** Uses `pageToken` like messages.list
- Returns arrays: `messagesAdded`, `messagesDeleted`, `labelsAdded`, `labelsRemoved`

### Algorithm

```
1. Load SyncState, get lastHistoryId
2. If no lastHistoryId → fall back to full hydration
3. Call history.list(startHistoryId=lastHistoryId)
4. Paginate through all history records
5. Collect:
   - newMessageIds: from messagesAdded events
   - deletedMessageIds: from messagesDeleted events
   - labelChanges: from labelsAdded/labelsRemoved events
6. Batch-fetch new messages (same as full hydration step 4-5)
7. Delete local files for deletedMessageIds
8. Update label metadata for labelChanges
9. Update historyId to the one returned in the history response
10. Save SyncState
```

### Stale History Fallback

The History API returns HTTP **404** (or `historyId` not found error) if the stored historyId is too old (Google purges history records after ~some weeks). When this happens:

```
1. Log warning: "History expired, performing catch-up sync"
2. List all current message IDs via messages.list
3. Compare against locally stored message IDs
4. Fetch any new IDs not in local store
5. Remove any local IDs not in remote list (deleted)
6. Get fresh historyId from profile and save
```

This is essentially a **differential full sync** — more expensive but correct.

### State to Persist
```json
{
  "lastSyncAt": "2026-02-12T08:00:00Z",
  "cursors": {
    "historyId": "123456789"
  },
  "metadata": {
    "totalMessages": 85432,
    "lastFullSyncAt": "2026-02-10T03:00:00Z",
    "emailAddress": "charlie@kindo.ai"
  }
}
```

---

## 4. Output Format

### Directory Structure
```
{outputDir}/
├── gmail/
│   ├── _state.json              # SyncState
│   ├── _labels.json             # Label id→name mapping
│   ├── messages/
│   │   ├── {msgId}.md           # Message content (markdown)
│   │   └── {msgId}.meta.json    # Message metadata sidecar
│   ├── threads/
│   │   └── {threadId}.md        # Thread view (all messages concatenated) — generated on demand or post-sync
│   └── attachments/
│       └── {msgId}/
│           └── {filename}       # Binary attachment files
```

### Message Markdown Format (`{msgId}.md`)
```markdown
---
id: 18d5a3b2c1e4f567
thread_id: 18d5a3b2c1e4f567
date: 2026-02-11T14:30:00-08:00
from: Alice Smith <alice@example.com>
to: charlie@kindo.ai
cc: bob@example.com
subject: Re: Q1 Planning
labels: [INBOX, IMPORTANT, Work/Projects]
---

Hey Charlie,

Here are the Q1 metrics we discussed. See the attached spreadsheet.

Best,
Alice

📎 Attachments:
- [q1-metrics.xlsx](../attachments/18d5a3b2c1e4f567/q1-metrics.xlsx) (45.2 KB)
```

**Body selection logic:**
1. Use `bodyPlain` if available
2. If only `bodyHtml`, convert to markdown using `turndown` (html-to-markdown)
3. If neither, use `snippet`

### Metadata Sidecar (`{msgId}.meta.json`)
```json
{
  "id": "18d5a3b2c1e4f567",
  "threadId": "18d5a3b2c1e4f567",
  "historyId": "987654",
  "internalDate": 1707681000000,
  "from": "Alice Smith <alice@example.com>",
  "to": "charlie@kindo.ai",
  "cc": "bob@example.com",
  "subject": "Re: Q1 Planning",
  "messageId": "<abc123@mail.example.com>",
  "inReplyTo": "<def456@mail.example.com>",
  "labelIds": ["INBOX", "IMPORTANT", "Label_5"],
  "labels": ["INBOX", "IMPORTANT", "Work/Projects"],
  "sizeEstimate": 52340,
  "attachments": [
    { "filename": "q1-metrics.xlsx", "mimeType": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "size": 46284 }
  ],
  "syncedAt": "2026-02-12T08:15:00Z"
}
```

### Thread View (`threads/{threadId}.md`) — Optional post-processing
Concatenates all messages in a thread, sorted by date. Useful for RAG context:

```markdown
# Thread: Q1 Planning

## Charlie Hulcher <charlie@kindo.ai> — 2026-02-10 09:00
Let's discuss Q1 metrics...

---

## Alice Smith <alice@example.com> — 2026-02-11 14:30
Hey Charlie, here are the Q1 metrics...
```

### File Naming
- Message IDs are Gmail's opaque hex strings (URL-safe, no special chars) — safe as filenames directly.
- Attachment filenames are sanitized: replace `/\:*?"<>|` with `_`, truncate to 200 chars, append counter if duplicate within same message.

---

## 5. Error Handling

### Quota Management (15,000 units/min per user)

```typescript
class QuotaTracker {
  private units: number[] = []; // timestamps of unit consumption
  private readonly windowMs = 60_000;
  private readonly maxUnits = 14_000; // leave 1k buffer

  async consume(units: number): Promise<void> {
    const now = Date.now();
    this.units = this.units.filter(t => now - t < this.windowMs);
    const currentUsage = this.units.length;
    if (currentUsage + units > this.maxUnits) {
      const oldestInWindow = this.units[0];
      const waitMs = this.windowMs - (now - oldestInWindow) + 100;
      await sleep(waitMs);
    }
    for (let i = 0; i < units; i++) this.units.push(Date.now());
  }
}
```

On HTTP 429:
- Parse `Retry-After` header
- Exponential backoff: 1s → 2s → 4s → 8s → max 60s
- Max 5 retries per request, then log error and skip message

### OAuth Token Refresh
- `googleapis` handles this automatically when `refresh_token` is set
- If refresh fails (revoked token), throw a fatal error — user must re-authorize
- Log token refresh events for debugging

### MIME Parsing Failures
- Wrap `walkParts` in try/catch per message
- On failure: save raw payload JSON to `{msgId}.raw.json`, log warning, increment error counter
- Continue syncing remaining messages

### Large Attachments
- Default max attachment size: 25MB (configurable via env var)
- Skip attachments over limit; record skip in metadata sidecar (`"skippedAttachments": [{"filename": "big.zip", "size": 104857600, "reason": "exceeds_max_size"}]`)

### Partial Sync Resumability
- **Full hydration:** Write `progress.json` with `{ fetchedIds: Set<string>, phase: "listing" | "fetching" | "attachments" }`
- On restart, load progress and skip completed work
- After successful completion, delete `progress.json`
- **Incremental:** Atomic — process all history events, write output, then update historyId. If interrupted mid-sync, the next run re-processes from the same historyId (idempotent since we overwrite files).

---

## 6. Edge Cases

### Multipart MIME
- `multipart/alternative`: contains `text/plain` AND `text/html`. Prefer `text/plain`; fall back to `text/html` → markdown conversion.
- `multipart/mixed`: top-level container with body + attachments as siblings.
- `multipart/related`: body + inline images. The `text/html` references images via `cid:` URIs.
- `multipart/signed` / `multipart/encrypted`: S/MIME. Extract the signed content part; skip signature blocks.
- Deeply nested (e.g. `mixed > alternative > related > html`): recursive walker handles this.

### Inline Images
- Detected by `Content-Disposition: inline` or presence of `Content-ID` header on image parts.
- Download like regular attachments.
- In markdown output, replace `cid:` references with relative paths: `![inline](../attachments/{msgId}/{filename})`
- If only HTML body available, rewrite `<img src="cid:xyz">` → markdown image link after turndown conversion.

### Spam/Trash Handling
- **Default:** Exclude spam and trash (`includeSpamTrash=false`).
- **Configurable:** Env var `GMAIL_INCLUDE_SPAM_TRASH=true` to include.
- If included, add `[SPAM]` or `[TRASH]` prefix to output filename or store in separate subdirectories.

### Label Mapping
- System labels: `INBOX`, `SENT`, `DRAFT`, `SPAM`, `TRASH`, `UNREAD`, `STARRED`, `IMPORTANT`, `CATEGORY_*`
- User labels: `Label_*` IDs → human-readable names from labels.list
- Nested labels use `/` separator (e.g. `Work/Projects`)
- Store both `labelIds` (stable) and resolved `labels` (human-readable) in metadata

### Very Large Mailboxes (100k+ messages)
- **Listing phase:** ~200 API calls, ~1,000 units. Trivial.
- **Fetch phase:** 100k messages × 5 units = 500k units. At 15k units/min → ~33 minutes minimum. With batching (100/batch), ~1,000 batch requests. Realistic time: **~45-60 minutes** for full hydration.
- **Disk space:** Average message ~10KB metadata + body → ~1GB for 100k messages. Attachments add significantly.
- **Memory:** Don't hold all messages in memory. Stream: list IDs → fetch in batches → write to disk immediately.
- **Progress tracking** is essential (see resumability above).

### Encoding/Charset Issues
- Gmail API returns body data as base64url. Decode to bytes.
- Check `Content-Type` charset parameter (e.g. `text/plain; charset=iso-8859-1`).
- Use `iconv-lite` or Node's `TextDecoder` to convert non-UTF-8 charsets to UTF-8.
- Common charsets: UTF-8, ISO-8859-1, Windows-1252, GB2312, Shift_JIS.
- Default to UTF-8 if charset is missing or unrecognized.

### Draft Messages
- Drafts have label `DRAFT` and appear in `messages.list`.
- **Default:** Exclude drafts (filter out `labelIds.includes("DRAFT")`).
- **Configurable:** `GMAIL_INCLUDE_DRAFTS=true` to include.
- Drafts may have incomplete headers (no `To:`, etc.). Handle gracefully.

### Other Edge Cases
- **Forwarded messages:** May contain `message/rfc822` parts (email-within-email). Extract recursively or store as `.eml` attachment.
- **Calendar invites:** `text/calendar` parts. Store as `.ics` attachment.
- **Empty messages:** Some messages have no body (just subject/headers). Output the headers only.
- **Duplicate messages:** Same `Message-ID` header in multiple messages (rare). Dedupe by Gmail message ID (always unique).
- **Unicode in filenames:** Attachment filenames may have unicode. Sanitize for filesystem but preserve in metadata.

---

## 7. Dependencies

### NPM Packages

| Package | Purpose | Version |
|---------|---------|---------|
| `googleapis` | Google API client (OAuth2 + Gmail API) | `^144.0.0` |
| `turndown` | HTML → Markdown conversion | `^7.2.0` |
| `iconv-lite` | Charset conversion for non-UTF-8 content | `^0.6.3` |
| `p-limit` | Concurrency limiter for batch requests | `^6.0.0` |
| `@saas-mirror/core` | Core adapter interface (workspace package) | `workspace:*` |

**Dev dependencies:**
| Package | Purpose |
|---------|---------|
| `@types/turndown` | TypeScript types |
| `vitest` | Testing |

### Config / Environment Variables

| Variable | Required | Description | Default |
|----------|----------|-------------|---------|
| `GMAIL_CLIENT_ID` | Yes | OAuth2 client ID | — |
| `GMAIL_CLIENT_SECRET` | Yes | OAuth2 client secret | — |
| `GMAIL_REFRESH_TOKEN` | Yes | OAuth2 refresh token | — |
| `GMAIL_MAX_ATTACHMENT_MB` | No | Max attachment size to download | `25` |
| `GMAIL_INCLUDE_SPAM_TRASH` | No | Include spam/trash messages | `false` |
| `GMAIL_INCLUDE_DRAFTS` | No | Include draft messages | `false` |
| `GMAIL_BATCH_SIZE` | No | Messages per batch request | `100` |
| `GMAIL_CONCURRENCY` | No | Concurrent batch requests | `2` |

### OAuth2 Setup (one-time)
1. Create Google Cloud project
2. Enable Gmail API
3. Create OAuth2 credentials (Desktop app type)
4. Run one-time auth flow to get refresh_token:
   ```bash
   npx ts-node scripts/gmail-auth.ts
   ```
   This opens browser, user grants `gmail.readonly`, script saves refresh_token to `.env`.

---

## 8. Estimated Complexity

### Lines of Code

| Module | Estimated LOC | Description |
|--------|--------------|-------------|
| `adapter.ts` | ~150 | Main `sync()` orchestration (full + incremental) |
| `client.ts` | ~120 | Gmail API wrapper (list, get, batch, history, attachments) |
| `mime.ts` | ~100 | MIME parsing, body extraction, charset handling |
| `output.ts` | ~80 | Markdown rendering, file writing, sanitization |
| `quota.ts` | ~50 | Quota tracking and rate limiting |
| `auth.ts` | ~40 | OAuth2 setup helper |
| `types.ts` | ~60 | TypeScript interfaces |
| **Total** | **~600** | |

### Test Code
~300 LOC of tests (MIME parsing edge cases, output formatting, quota tracking).

### Time Estimate

| Phase | Estimate |
|-------|----------|
| OAuth2 setup + basic client | 2 hours |
| Full hydration (list + batch fetch + MIME parse) | 4 hours |
| Output formatting (markdown + metadata + attachments) | 2 hours |
| Incremental sync (History API) | 2 hours |
| Error handling + resumability | 2 hours |
| Edge cases (charset, inline images, drafts) | 2 hours |
| Testing | 2 hours |
| **Total** | **~16 hours** (~2 days) |

### Risk Factors
- MIME parsing is the gnarliest part. Real-world emails are wildly inconsistent. Budget extra time for edge cases discovered during testing with real mailbox data.
- Google's batch API has quirks (multipart/mixed request format). May need debugging.
- Very large mailboxes may surface memory or timeout issues not apparent in small tests.

---

## Implementation Order

1. **`types.ts`** — Interfaces
2. **`auth.ts`** — OAuth2 helper + one-time token script
3. **`client.ts`** — Gmail API wrapper (list, get, batch)
4. **`mime.ts`** — MIME parser
5. **`quota.ts`** — Rate limiter
6. **`output.ts`** — File writer
7. **`adapter.ts`** — Wire it all together
8. **Tests** — Focus on MIME parsing and incremental sync logic
