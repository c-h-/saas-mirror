# Linear Adapter — Implementation Plan

> Written 2026-02-12. To be used as the spec for implementing `adapters/linear/src/adapter.ts`.

---

## 1. Data Model

### Entities to Sync

| Entity | Linear GraphQL Type | Local File | Notes |
|---|---|---|---|
| **Teams** | `Team` | `_meta/teams.json` | Top-level org unit; used to scope issue queries |
| **Users** | `User` | `_meta/users.json` | Assignees, creators, commenters |
| **Workflow States** | `WorkflowState` | `_meta/workflow-states.json` | Per-team states (Backlog, Todo, In Progress, Done, Cancelled) |
| **Labels** | `IssueLabel` | `_meta/labels.json` | Org-wide + team-scoped |
| **Projects** | `Project` | `projects/{slug}.md` | Container for cross-team work |
| **Cycles** | `Cycle` | `_meta/cycles.json` | Per-team sprints |
| **Issues** | `Issue` | `issues/{team-key}/{identifier}.md` | Primary entity |
| **Comments** | `Comment` | Inline in issue markdown | Threaded under issues |
| **Attachments** | `Attachment` | `attachments/{issue-identifier}/{filename}` | External URLs + downloaded binaries |
| **Issue Relations** | `IssueRelation` | Metadata in issue frontmatter | blocks/blocked-by, duplicate, related |

### Schema per Entity

```typescript
// Persisted in _meta/teams.json
interface TeamRecord {
  id: string;
  key: string;        // e.g. "ENG"
  name: string;
}

// Persisted in _meta/users.json
interface UserRecord {
  id: string;
  name: string;
  email: string;
  displayName: string;
  avatarUrl?: string;
  active: boolean;
}

// Persisted in _meta/workflow-states.json
interface WorkflowStateRecord {
  id: string;
  name: string;       // e.g. "In Progress"
  type: string;       // backlog | unstarted | started | completed | cancelled
  teamId: string;
  color: string;
  position: number;
}

// Persisted in _meta/labels.json
interface LabelRecord {
  id: string;
  name: string;
  color: string;
  parentId?: string;  // nested labels
}

// Persisted in _meta/cycles.json
interface CycleRecord {
  id: string;
  number: number;
  name?: string;
  teamId: string;
  startsAt: string;
  endsAt: string;
  completedAt?: string;
}

// Projects → individual markdown files
interface ProjectRecord {
  id: string;
  name: string;
  slug: string;
  description?: string;
  state: string;       // planned | started | paused | completed | cancelled
  startDate?: string;
  targetDate?: string;
  teamIds: string[];
  leadId?: string;
}

// Issues → individual markdown files with YAML frontmatter
interface IssueRecord {
  id: string;
  identifier: string; // e.g. "ENG-123"
  title: string;
  description?: string; // markdown
  state: string;
  priority: number;    // 0=none, 1=urgent, 4=low
  assigneeId?: string;
  creatorId?: string;
  teamId: string;
  projectId?: string;
  cycleId?: string;
  labelIds: string[];
  parentId?: string;   // sub-issue
  estimate?: number;
  dueDate?: string;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
  completedAt?: string;
  cancelledAt?: string;
  relations: { type: string; relatedIssueId: string; }[];
  comments: CommentRecord[];
  attachments: AttachmentRecord[];
}

interface CommentRecord {
  id: string;
  body: string;        // markdown
  userId: string;
  createdAt: string;
  updatedAt: string;
}

interface AttachmentRecord {
  id: string;
  title: string;
  url: string;
  sourceType?: string;
  createdAt: string;
}
```

---

## 2. Full Hydration Flow

### Step-by-step

```
1. Auth          → Validate API key via `viewer` query
2. Fetch org     → teams, users, labels (org-wide)
3. Per team      → workflow states, cycles
4. Fetch projects → all projects (paginated)
5. Fetch issues  → all issues per team (paginated, 50/page)
   └─ Include inline: state, assignee, labels, project, cycle, parent, creator
6. Fetch comments → per issue (nested in issue query or separate pass)
7. Fetch relations → per issue (nested or separate)
8. Fetch attachments → per issue (nested or separate)
9. Download attachment binaries → HTTP GET on URLs
10. Write output  → markdown files + metadata JSON
```

### GraphQL Queries

**Viewer (auth check):**
```graphql
query { viewer { id name email } }
```

**Teams:**
```graphql
query Teams($after: String) {
  teams(first: 50, after: $after) {
    nodes { id key name }
    pageInfo { hasNextPage endCursor }
  }
}
```

**Users:**
```graphql
query Users($after: String) {
  users(first: 50, after: $after) {
    nodes { id name email displayName avatarUrl active }
    pageInfo { hasNextPage endCursor }
  }
}
```

**Labels (org-wide):**
```graphql
query Labels($after: String) {
  issueLabels(first: 50, after: $after) {
    nodes { id name color parent { id } }
    pageInfo { hasNextPage endCursor }
  }
}
```

**Workflow states (per team):**
```graphql
query WorkflowStates($teamId: String!, $after: String) {
  team(id: $teamId) {
    states(first: 50, after: $after) {
      nodes { id name type color position }
      pageInfo { hasNextPage endCursor }
    }
  }
}
```

**Cycles (per team):**
```graphql
query Cycles($teamId: String!, $after: String) {
  team(id: $teamId) {
    cycles(first: 50, after: $after) {
      nodes { id number name startsAt endsAt completedAt }
      pageInfo { hasNextPage endCursor }
    }
  }
}
```

**Projects:**
```graphql
query Projects($after: String) {
  projects(first: 50, after: $after) {
    nodes {
      id name slugId description state startDate targetDate
      lead { id }
      teams { nodes { id } }
    }
    pageInfo { hasNextPage endCursor }
  }
}
```

**Issues (the big one — per team for manageability):**
```graphql
query TeamIssues($teamId: String!, $after: String) {
  team(id: $teamId) {
    issues(first: 50, after: $after, orderBy: updatedAt) {
      nodes {
        id identifier title description priority estimate dueDate
        createdAt updatedAt archivedAt completedAt cancelledAt
        state { id name type }
        assignee { id }
        creator { id }
        project { id }
        cycle { id }
        parent { id }
        labels { nodes { id } }
        comments(first: 100) {
          nodes { id body createdAt updatedAt user { id } }
          pageInfo { hasNextPage endCursor }
        }
        relations {
          nodes { type relatedIssue { id identifier } }
        }
        attachments {
          nodes { id title url sourceType createdAt }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
}
```

> **Complexity note:** Including `comments(first:100)` inline keeps it to 1 query per 50 issues. If any issue has >100 comments, we detect via `hasNextPage` and fetch remaining comments in a separate query (see edge cases).

### Pagination Strategy

- All collections use **cursor-based** pagination (`first`/`after`/`pageInfo.endCursor`).
- Default page size: **50** (Linear's max per page).
- Loop pattern:
  ```typescript
  let cursor: string | undefined;
  do {
    const result = await gql(QUERY, { after: cursor, ...vars });
    process(result.nodes);
    cursor = result.pageInfo.hasNextPage ? result.pageInfo.endCursor : undefined;
  } while (cursor);
  ```

### Rate Limit Handling

Linear enforces two limits:

| Limit | Budget | Header |
|---|---|---|
| Request count | 5,000/hr (API key) | `X-RateLimit-Requests-Remaining` |
| Query complexity | 3,000,000/hr (API key) | `X-RateLimit-Complexity-Remaining` |

**Strategy:**
1. Read `X-RateLimit-Requests-Remaining` and `X-RateLimit-Complexity-Remaining` from every response.
2. If requests remaining < 200, sleep until reset (`X-RateLimit-Requests-Reset`).
3. If complexity remaining < 50,000, sleep until reset.
4. On HTTP 429: read `Retry-After` header, sleep that duration, retry.
5. Between requests: minimum 50ms delay (soft throttle to ~72 req/min = ~1200/hr, well under 5000).

---

## 3. Incremental Sync Flow

### Change Detection

Linear supports `updatedAt` filter on issue queries:

```graphql
query UpdatedIssues($teamId: String!, $since: DateTime!, $after: String) {
  team(id: $teamId) {
    issues(
      first: 50
      after: $after
      filter: { updatedAt: { gt: $since } }
      orderBy: updatedAt
    ) {
      nodes { ... same fields ... }
      pageInfo { hasNextPage endCursor }
    }
  }
}
```

### Archived Issues

Issues that get archived after last sync will have `archivedAt` set and `updatedAt` bumped. They'll appear in the incremental query. We write them with `archived: true` in frontmatter.

### Persisted State

Stored in `stateFile` (the `SyncState` from core):

```typescript
interface LinearSyncState extends SyncState {
  lastSyncAt: string;           // ISO timestamp of last successful sync
  cursors: {};                  // not used for incremental (we use timestamp filter)
  metadata: {
    issueCount: number;         // total issues synced
    lastFullSyncAt: string;     // when last full hydration ran
  };
}
```

### Incremental Flow

```
1. Load state → get lastSyncAt
2. Fetch updated metadata (teams, users, labels, states, cycles, projects)
   → Always re-fetch these (small, <100 items each, <10 queries)
3. Per team: query issues with updatedAt > lastSyncAt
4. For each returned issue: overwrite its markdown file
5. Save state with new lastSyncAt = now
```

### Handling Deletions

Linear issues are rarely deleted (mostly archived). We handle:
- **Archived:** Detected via `archivedAt` field. File kept but frontmatter `archived: true`.
- **Actually deleted (rare):** Not detectable via incremental filter. On periodic full re-sync (e.g. weekly), compare known issue IDs vs fetched set; mark missing as deleted.

---

## 4. Output Format

### Directory Structure

```
{outputDir}/
├── _meta/
│   ├── teams.json
│   ├── users.json
│   ├── labels.json
│   ├── workflow-states.json
│   └── cycles.json
├── projects/
│   └── {slug}.md
├── issues/
│   └── {team-key}/            # e.g. ENG/
│       ├── ENG-001.md
│       ├── ENG-002.md
│       └── ...
└── attachments/
    └── {identifier}/          # e.g. ENG-001/
        └── {filename}
```

### Issue Markdown Format

```markdown
---
id: "abc123"
identifier: "ENG-123"
title: "Implement user auth"
state: "In Progress"
stateType: "started"
priority: 2
priorityLabel: "High"
assignee: "Charlie Hulcher"
creator: "Nick R"
team: "Engineering"
project: "Auth Overhaul"
cycle: "Sprint 14"
labels: ["backend", "security"]
parent: "ENG-100"
estimate: 3
dueDate: "2026-02-28"
createdAt: "2026-01-15T10:00:00.000Z"
updatedAt: "2026-02-10T14:30:00.000Z"
archived: false
relations:
  - type: "blocks"
    issue: "ENG-124"
  - type: "related"
    issue: "ENG-050"
attachments:
  - title: "screenshot.png"
    url: "https://..."
---

# ENG-123: Implement user auth

Implement OAuth2 + PKCE flow for the web app...

(original description markdown here, preserved as-is)

---

## Comments

### Charlie Hulcher — 2026-01-16T09:00:00.000Z

Looking good, let's add refresh token rotation.

### Nick R — 2026-01-16T11:00:00.000Z

Done, pushed to the branch.
```

### File Naming

- Issues: `{team-key}/{identifier}.md` → `ENG/ENG-123.md`
- Projects: `{slug}.md` → `auth-overhaul.md`
- Attachments: `{identifier}/{filename}` → `ENG-123/screenshot.png`

### Priority Mapping

| Value | Label |
|---|---|
| 0 | None |
| 1 | Urgent |
| 2 | High |
| 3 | Medium |
| 4 | Low |

### Metadata Sidecars

The `_meta/*.json` files serve as lookup tables. They are always fully re-written on each sync. Structure: JSON array of records (see schemas above).

---

## 5. Error Handling

### Rate Limits

- **Request limit (5k/hr):** Monitor header, pre-emptive pause at <200 remaining. On 429: exponential backoff starting at `Retry-After` value (or 60s default).
- **Complexity limit (3M/hr):** Monitor header. If approaching limit, reduce query depth (drop inline comments, fetch separately). Pre-emptive pause at <50k remaining.
- **Query complexity cap (~10k per query):** If a single query is too complex, Linear returns an error. Mitigation: keep `first: 50` and limit nested `comments(first: 100)`. If still too complex, split: fetch issues without comments, then fetch comments per-issue.

### Query Complexity Management

Estimated complexity per query pattern:

| Query | Est. Complexity |
|---|---|
| Teams (50) | ~100 |
| Users (50) | ~100 |
| Issues (50) with inline comments(100) + relations + attachments | ~5,000–8,000 |
| Issues (50) without nested objects | ~500 |
| Comments for 1 issue (100) | ~200 |

Strategy: Start with the full inline query. If it returns a complexity error, fall back to split mode (issues-only + per-issue comment fetches).

### Partial Failures

- **Per-team isolation:** If one team fails, continue with others. Log error, include in `SyncResult.errors[]`.
- **Per-issue isolation:** If comment pagination fails for one issue, write the issue with partial comments and log the error.
- **Resumability:** On crash, state is only saved on successful completion. Re-running picks up from last successful sync timestamp. For full hydration, we could checkpoint per-team (save cursor in state), but initial implementation: just re-run from scratch.

### Network Errors

- Retry transient errors (5xx, ECONNRESET, ETIMEDOUT) with exponential backoff, max 3 retries.
- Non-retryable errors (4xx except 429): log and skip.

---

## 6. Edge Cases

### Merged Issues

When issues are merged in Linear, the "source" issue gets archived and a reference is added. The merged issue's `updatedAt` changes, so incremental sync picks it up. The source issue appears with `archivedAt` set. No special handling needed beyond normal archive detection.

### Archived vs Deleted

- **Archived:** `archivedAt` is set. Issue still returned by API (with `includeArchived: true` filter if needed). We include archived issues with `archived: true` in frontmatter.
- **Deleted:** Issue disappears from API entirely. Only detectable by full re-sync ID comparison. Rare in practice. On detection, we could either delete the local file or add a `deleted: true` frontmatter entry.

**Important:** By default, Linear's `issues` query may exclude archived issues. We must pass `includeArchived: true` (or `filter: { includeArchived: true }`) — verify exact API syntax via schema introspection.

### Issue Relations

Linear supports: `blocks`, `blocked-by`, `duplicate`, `duplicate-of`, `related`. We store these in frontmatter as an array. The `relations` field on an issue gives outgoing relations; `inverseRelations` gives incoming. We query both:

```graphql
relations { nodes { type relatedIssue { id identifier } } }
inverseRelations { nodes { type issue { id identifier } } }
```

### Attachment Downloads

- Attachments have a `url` field (external link, e.g. Figma, GitHub PR, or uploaded file).
- For uploaded files: URL points to Linear's CDN (signed URL, may expire). Download immediately during sync.
- For external links (Figma, GitHub, Sentry): store URL only, don't download.
- Detection: check `sourceType` field. `null` or `upload` → download. Others (`figma`, `github`, `sentry`, etc.) → link only.
- On download failure: log warning, continue. Store URL in frontmatter regardless.

### Rich Markdown in Descriptions

Linear descriptions are already markdown. Preserve as-is. Known quirks:
- Image references may use Linear CDN URLs (signed, expiring). Consider downloading and rewriting to local paths.
- Mentions like `@user` may appear as raw text or Linear-specific syntax. Leave as-is for now.
- LaTeX/code blocks: pass through unchanged.

### Large Comment Threads

If an issue has >100 comments:
1. Initial `comments(first: 100)` returns first 100 + `hasNextPage: true`.
2. Detect this and issue a follow-up query:
   ```graphql
   query IssueComments($issueId: String!, $after: String) {
     issue(id: $issueId) {
       comments(first: 100, after: $after) {
         nodes { id body createdAt updatedAt user { id } }
         pageInfo { hasNextPage endCursor }
       }
     }
   }
   ```
3. Loop until all fetched.

### Sub-issues

Issues can have a `parent` field. We record `parent: "ENG-100"` in frontmatter. Sub-issues are their own files (not nested under parent file). The parent-child relationship is navigable via frontmatter.

### Unicode / Special Characters in Titles

File names use the issue identifier (e.g. `ENG-123.md`), which is always safe ASCII. Title is in frontmatter only.

---

## 7. Dependencies

### NPM Packages

| Package | Purpose | Version |
|---|---|---|
| `graphql-request` | Lightweight GraphQL client | ^7.x |
| `yaml` | YAML frontmatter serialization | ^2.x |
| `p-queue` | Concurrency-limited promise queue | ^8.x |
| `p-retry` | Retry with backoff | ^6.x |

> **Not using `@linear/sdk`:** The SDK abstracts too much and makes it harder to control pagination, query shape, and rate limit headers. Raw `graphql-request` gives us full control over queries and response headers.

### Config / Environment Variables

| Var | Description | Required |
|---|---|---|
| `LINEAR_API_KEY` | Personal API key or OAuth token | Yes |
| `LINEAR_TEAM_KEYS` | Comma-separated team keys to sync (default: all) | No |
| `LINEAR_INCLUDE_ARCHIVED` | Include archived issues (default: true) | No |
| `LINEAR_DOWNLOAD_ATTACHMENTS` | Download uploaded attachments (default: true) | No |

These are read from env or from a config object passed to the adapter.

---

## 8. Estimated Complexity

### Lines of Code

| Module | Est. LOC |
|---|---|
| `adapter.ts` (main orchestrator) | 150 |
| `graphql.ts` (client, rate limiting, retries) | 120 |
| `queries.ts` (all GraphQL query strings) | 100 |
| `writer.ts` (markdown + JSON output) | 120 |
| `types.ts` (TypeScript interfaces) | 80 |
| **Total** | **~570 LOC** |

### Time Estimate

| Phase | Time |
|---|---|
| GraphQL client + rate limiter | 2 hrs |
| Query definitions + pagination | 2 hrs |
| Full hydration flow | 3 hrs |
| Incremental sync flow | 1.5 hrs |
| Markdown writer + frontmatter | 2 hrs |
| Attachment downloads | 1 hr |
| Error handling + edge cases | 2 hrs |
| Testing + debugging | 2.5 hrs |
| **Total** | **~16 hrs** |

---

## Implementation Order

1. `types.ts` — interfaces
2. `graphql.ts` — client with rate limit handling + retry
3. `queries.ts` — all query strings as constants
4. `writer.ts` — markdown rendering + JSON metadata output
5. `adapter.ts` — orchestrate full + incremental flows
6. Integration test with real API key against a test workspace
