# Notion Adapter — Implementation Plan

> Generated: 2026-02-12. For use in `saas-mirror` project.

---

## 1. Data Model

### Entities to Sync

| Entity | Notion API Object | Notes |
|---|---|---|
| **Workspace pages** | `page` | Top-level and nested. Each page is also a block container. |
| **Databases** | `database` | Schema (properties) + title. Inline and full-page databases. |
| **Database rows** | `page` (with `parent.type === "database_id"`) | Each row is a page with typed properties. |
| **Blocks** | `block` | Recursive tree. ~50 block types (paragraph, heading, list, toggle, code, image, embed, etc.). |
| **Comments** | `comment` | Per-page and per-block (discussion threads). |
| **Users** | `user` | People and bots referenced in edits/comments. |

### Internal Schema (TypeScript types stored in state/sidecar JSON)

```typescript
interface NotionSyncState extends SyncState {
  // cursors.searchCursor — resume point for search pagination
  // metadata.knownPageIds — Set<string> for deletion detection
  // metadata.pageLastEdited — Record<pageId, ISO string>
  metadata: {
    knownPageIds: string[];
    knownDatabaseIds: string[];
    pageLastEdited: Record<string, string>; // pageId → last_edited_time
    dbLastEdited: Record<string, string>;
    userCache: Record<string, { name: string; email?: string; avatarUrl?: string }>;
  };
}

interface PageMeta {
  id: string;
  title: string;
  url: string;
  parentId: string | null;   // parent page or database
  parentType: "workspace" | "page_id" | "database_id";
  createdTime: string;
  lastEditedTime: string;
  archived: boolean;
  icon?: { type: string; emoji?: string; url?: string };
  cover?: { url: string };
  properties?: Record<string, any>; // for database rows
}

interface BlockTree {
  id: string;
  type: string;
  hasChildren: boolean;
  children: BlockTree[];
  content: any; // raw block type-specific content
}
```

### Nested / Recursive Pages

Notion pages can nest arbitrarily. Strategy:
- **Filesystem mirrors the page tree.** Each page becomes a directory containing `index.md` (content) + `_meta.json` (sidecar) + child page dirs.
- Child pages discovered via `child_page` blocks during block traversal.
- Database rows are children of their database; stored in `<db-dir>/rows/`.
- Max recursion depth: configurable, default 20, with cycle detection (track visited IDs).

```
outputDir/
  <page-slug>/
    index.md
    _meta.json
    <child-page-slug>/
      index.md
      _meta.json
    <inline-db-slug>/
      _db_schema.json
      rows/
        <row-title-slug>.md
        <row-title-slug>._meta.json
  _users.json
  _sync_state.json
```

---

## 2. Full Hydration Flow

### Step-by-step

1. **Auth:** Read `NOTION_TOKEN` from env. Initialize `@notionhq/client` with `auth` and `notionVersion: "2022-06-28"`.

2. **Discover all pages & databases** via `POST /v1/search`:
   - No query filter → returns everything shared to integration.
   - `page_size: 100`, paginate with `start_cursor`.
   - Separate results into pages list and databases list.
   - ~1 API call per 100 items.

3. **Build page tree:**
   - From search results, construct parent→children map using `parent` field.
   - This gives the directory structure before fetching content.

4. **Fetch users** via `GET /v1/users` (paginated, `page_size: 100`). Cache in state. ~1-2 calls.

5. **For each page** (BFS/DFS from roots):
   a. `GET /v1/blocks/{page_id}/children` — paginate (`page_size: 100`).
   b. For each block with `has_children: true`, recurse: `GET /v1/blocks/{block_id}/children`.
   c. Collect full block tree.
   d. Render to Markdown (§4).
   e. Write `index.md` + `_meta.json`.
   f. Download any file/image blocks (§6 on expiring URLs).

6. **For each database:**
   a. `GET /v1/databases/{db_id}` — fetch schema/properties.
   b. `POST /v1/databases/{db_id}/query` — paginate all rows.
   c. For each row (page), fetch blocks (step 5) and render.
   d. Write `_db_schema.json` + row files.

7. **Fetch comments** for each page:
   - `GET /v1/comments?block_id={page_id}` — paginated.
   - Append to `_meta.json` or separate `_comments.json`.

8. **Save sync state** with all known IDs, last_edited_times, and timestamp.

### API Calls Estimate (workspace with N pages, avg D blocks/page)

| Operation | Calls |
|---|---|
| Search (discover) | ceil(N / 100) |
| Users | 1–2 |
| Block children per page | ceil(D / 100) × N (+ nested) |
| Database queries | ceil(rows / 100) per DB |
| Comments | 1 per page (if few comments) |

### Rate Limit Handling

- Notion allows ~3 requests/second (~180/min).
- Use a **token bucket** limiter: `p-throttle` or custom, set to 3 req/s.
- On 429: read `Retry-After` header, sleep, retry (max 5 retries with exponential backoff).
- Concurrent requests: max 3 in-flight (matches QPS limit with ~1s round-trip).

### Pagination

All paginated endpoints use `{ has_more: boolean, next_cursor: string | null }`. Loop pattern:

```typescript
async function* paginate<T>(fn: (cursor?: string) => Promise<{ results: T[]; has_more: boolean; next_cursor: string | null }>) {
  let cursor: string | undefined;
  do {
    const res = await fn(cursor);
    yield* res.results;
    cursor = res.has_more ? res.next_cursor! : undefined;
  } while (cursor);
}
```

---

## 3. Incremental Sync Flow

### Change Detection Strategy

Notion has no webhooks or change feed. Strategy:

1. **Search sorted by `last_edited_time` descending:**
   ```typescript
   notion.search({ sort: { direction: "descending", timestamp: "last_edited_time" }, page_size: 100 })
   ```
   Iterate pages until `last_edited_time < lastSyncAt`. This gives all changed pages since last sync.

2. **Compare with known state:**
   - If `pageId` exists in state but `last_edited_time` is newer → re-fetch blocks, re-render.
   - If `pageId` is new (not in `knownPageIds`) → new page shared to integration. Full fetch.
   - If `pageId` in state but not in search results → **possibly deleted or unshared**. Mark as deleted (move output to `_archived/` or delete).

3. **Deletion detection:**
   - On incremental: after processing changed pages, do a full search scan (can be expensive) OR keep a "full scan" counter and do full scan every Nth incremental run.
   - Simpler: every incremental run, scan full search. For workspaces < 10K pages, this is ~100 API calls (manageable at 3/s = ~33s).
   - `archived: true` pages → move to archived output dir.

4. **Persist state:**
   ```typescript
   {
     lastSyncAt: "2026-02-12T09:00:00Z",
     cursors: {},
     metadata: {
       knownPageIds: ["id1", "id2", ...],
       knownDatabaseIds: ["db1", ...],
       pageLastEdited: { "id1": "2026-02-11T...", ... },
       dbLastEdited: { "db1": "2026-02-10T...", ... },
       userCache: { ... }
     }
   }
   ```

5. **Optimization:** Only re-fetch blocks for pages where `last_edited_time` changed. Comments can be re-fetched selectively (though Notion doesn't expose comment edit times — always re-fetch for changed pages).

### New Shares

When someone shares a new top-level page to the integration after initial sync, it appears in search results as a new ID. The incremental flow handles this naturally.

---

## 4. Output Format

### Markdown Rendering

Each Notion block type maps to Markdown:

| Block Type | Markdown Output |
|---|---|
| `paragraph` | Plain text line + `\n\n` |
| `heading_1/2/3` | `# / ## / ###` + text |
| `bulleted_list_item` | `- ` + text (nested with indentation) |
| `numbered_list_item` | `1. ` + text (counter tracked per consecutive run) |
| `to_do` | `- [x]` or `- [ ]` + text |
| `toggle` | `<details><summary>text</summary>\n\nchildren\n</details>` |
| `code` | ` ```language\ncode\n``` ` |
| `quote` | `> ` + text |
| `callout` | `> emoji **text** (callout)` or custom block |
| `divider` | `---` |
| `image` | `![caption](url)` — download file, use local relative path |
| `file` / `pdf` | `[filename](url)` — download, local path |
| `video` | `[Video](url)` |
| `embed` | `[Embed](url)` |
| `bookmark` | `[Bookmark: caption](url)` |
| `table` | Markdown table (`| col | col |`) |
| `table_row` | Row in table |
| `column_list` / `column` | Render columns sequentially (Markdown has no columns) |
| `child_page` | `[Page Title](./child-slug/)` link |
| `child_database` | `[Database Title](./db-slug/)` link |
| `synced_block` | Render original content if accessible; note source |
| `equation` | `$equation$` (LaTeX) |
| `link_to_page` | `[→ Page Title](../path/)` |
| `table_of_contents` | Skip (auto-generated) |
| `breadcrumb` | Skip |
| `link_preview` | `[url](url)` |
| Unknown type | `<!-- unsupported block: {type} -->` + log warning |

### Rich Text Rendering

Notion `rich_text` arrays contain segments with annotations:

```typescript
function renderRichText(segments: RichTextItem[]): string {
  return segments.map(seg => {
    let text = seg.plain_text;
    if (seg.annotations.bold) text = `**${text}**`;
    if (seg.annotations.italic) text = `*${text}*`;
    if (seg.annotations.strikethrough) text = `~~${text}~~`;
    if (seg.annotations.code) text = `\`${text}\``;
    if (seg.href) text = `[${text}](${seg.href})`;
    // underline: no standard MD — skip or use <u> tag
    // color: skip for plain MD
    return text;
  }).join('');
}
```

### File Naming

- Page slug: `slugify(title)` — lowercase, alphanumeric + hyphens, max 80 chars. Append short ID suffix if collision: `my-page-a1b2c3d4`.
- Database row slug: `slugify(primary property value)` + short ID.
- Files/images: `assets/<original-filename-or-block-id>.<ext>`.

### Database Rows as Structured Markdown

```markdown
---
# YAML frontmatter with all properties
id: "abc-123"
Status: "In Progress"
Priority: "High"
Assignee: "Alice"
Due Date: "2026-03-01"
Tags: ["engineering", "backend"]
URL: "https://notion.so/..."
---

# Row Title

(block content rendered as normal markdown)
```

### Metadata Sidecar (`_meta.json`)

```json
{
  "id": "page-uuid",
  "title": "Page Title",
  "url": "https://notion.so/...",
  "createdTime": "2026-01-15T...",
  "lastEditedTime": "2026-02-10T...",
  "parentId": "parent-uuid",
  "parentType": "page_id",
  "archived": false,
  "icon": { "type": "emoji", "emoji": "📋" },
  "createdBy": "user-uuid",
  "lastEditedBy": "user-uuid",
  "comments": [
    { "id": "...", "author": "...", "text": "...", "createdTime": "..." }
  ]
}
```

---

## 5. Error Handling

### Rate Limits

```typescript
class RateLimiter {
  private queue: Array<() => void> = [];
  private tokens = 3;
  // Refill 3 tokens/sec
  // On 429: pause all, wait Retry-After, resume
}
```

- Wrap every API call in rate limiter.
- On HTTP 429: extract `Retry-After` (seconds), sleep, retry. Max 5 retries.
- On HTTP 502/503: retry with exponential backoff (1s, 2s, 4s, 8s, 16s).

### Pagination Failures

- If a cursor becomes invalid mid-sync (rare), log error, restart that page's block fetch from scratch.
- Save progress per-page so a crash doesn't lose the entire sync.

### Missing Permissions

- `GET /v1/blocks/{id}/children` returns 404 or 403 for unshared pages.
- Log as warning, skip page, continue. Report in `SyncResult.errors`.

### Partial Sync Resumability

- After each page is fully written, update state file with that page's `lastEditedTime`.
- On crash/restart, state file tells us which pages are already current.
- Search-based discovery is idempotent — safe to re-run.

---

## 6. Edge Cases

### Pages Not Shared to Integration
- They simply don't appear in search. No action needed.
- `child_page` blocks may reference unshared pages → 404 on block fetch. Render as `[Page Title (not accessible)]()`.

### Deeply Nested Pages
- Recursion depth limit (default 20). Log warning if exceeded.
- Cycle detection via visited set (should never happen in Notion, but be safe).

### Relation Properties
- Database `relation` properties contain an array of page IDs.
- Resolve to page titles via a lookup map (built during search phase).
- Render as: `Related: [Page A](../page-a/), [Page B](../page-b/)` in frontmatter.

### Embedded Files with Expiring URLs
- Notion-hosted files (`type: "file"`) have **signed S3 URLs that expire in ~1 hour**.
- **Must download immediately** when encountered during block traversal.
- Save to `assets/` dir with content-addressed or block-ID-based filename.
- Rewrite Markdown to use local relative path.
- External URLs (`type: "external"`) — keep as-is (they don't expire).

### Inline Databases
- `child_database` blocks within a page.
- Treated same as full-page databases but nested in the parent page's output directory.

### Synced Blocks
- `synced_block` type. Two variants:
  - **Original**: has `children` — render normally.
  - **Reference** (`synced_from` field): points to original block. Fetch original's children via `GET /v1/blocks/{original_id}/children`.
  - If original not accessible (different page, unshared): log warning, render placeholder.

### Large Pages (> 100 blocks)
- Pagination handles this naturally (100 blocks per call).
- Pages with 1000+ blocks: multiple API calls. Rate limiter ensures we don't burst.
- Very large pages (10K+ blocks) may take minutes. Log progress.

### Duplicate Titles
- Multiple pages can have the same title. Slug collision resolved by appending short page ID.

### Empty Pages
- Pages with no blocks: write `index.md` with just frontmatter/title. Still write `_meta.json`.

### Archived Pages
- Appear in search with `archived: true`.
- Sync them but flag in metadata. Optionally write to `_archived/` subdirectory.

---

## 7. Dependencies

### NPM Packages

| Package | Purpose |
|---|---|
| `@notionhq/client` | Official Notion API SDK |
| `p-throttle` | Rate limiting (3 req/s) |
| `p-queue` | Concurrency control for parallel page fetching |
| `slugify` | File/dir name generation |
| `mime-types` | Determine file extensions for downloaded assets |
| `node-fetch` (or native) | Download files from expiring URLs |

### Config / Environment Variables

| Variable | Required | Description |
|---|---|---|
| `NOTION_TOKEN` | Yes | Internal integration token (secret_xxx) |
| `NOTION_VERSION` | No | API version header (default: `2022-06-28`) |

No other secrets needed. The integration token must have:
- **Read content** capability
- **Read comments** capability (optional)
- **Read user information including email** (optional)

---

## 8. Estimated Complexity

### Lines of Code

| Module | Est. LOC |
|---|---|
| `adapter.ts` (main sync orchestration) | 250 |
| `api.ts` (Notion API wrapper with rate limiting, pagination) | 200 |
| `renderer.ts` (block → Markdown conversion) | 350 |
| `tree.ts` (page tree building, directory layout) | 100 |
| `files.ts` (asset downloading, URL rewriting) | 80 |
| `state.ts` (sync state management, deletion detection) | 80 |
| `types.ts` (TypeScript interfaces) | 60 |
| Tests | 300 |
| **Total** | **~1,420** |

### Time Estimate

| Phase | Time |
|---|---|
| API wrapper + rate limiting + pagination | 3 hours |
| Block → Markdown renderer (all 50 block types) | 5 hours |
| Sync orchestration (full + incremental) | 3 hours |
| File downloading + URL rewriting | 1.5 hours |
| State management + deletion detection | 1.5 hours |
| Directory layout + slug generation | 1 hour |
| Database row rendering (frontmatter) | 1 hour |
| Comments fetching | 0.5 hours |
| Testing + edge case handling | 3 hours |
| **Total** | **~19.5 hours** |

### Risk Factors

- **Markdown renderer** is the most complex piece — 50+ block types, each with quirks. Rich text annotations, nested lists, tables.
- **Expiring URLs** require download-on-encounter, making the sync stateful mid-page.
- **Large workspaces** (1000+ pages) may take 30+ minutes for full hydration at 3 QPS. Resumability is important.

---

## Appendix: Key API Endpoints Reference

| Endpoint | Method | Purpose |
|---|---|---|
| `/v1/search` | POST | Discover all pages/databases |
| `/v1/pages/{id}` | GET | Page metadata |
| `/v1/blocks/{id}/children` | GET | Block children (paginated) |
| `/v1/blocks/{id}` | GET | Single block detail |
| `/v1/databases/{id}` | GET | Database schema |
| `/v1/databases/{id}/query` | POST | Query database rows |
| `/v1/comments` | GET | Comments on a block/page |
| `/v1/users` | GET | List all users |
| `/v1/users/{id}` | GET | Single user detail |
