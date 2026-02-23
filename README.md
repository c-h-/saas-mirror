# saas-mirror

Local replication of SaaS data into Markdown files for embedding, RAG, and semantic search.

## Why

AI-powered search and retrieval work best on local, structured data. But your team's knowledge lives in Slack, Notion, Linear, and Gmail — behind APIs with rate limits, pagination, and authentication quirks.

**saas-mirror** solves this by syncing SaaS data into a local directory of Markdown files with YAML frontmatter and JSON sidecars. The output is designed for embedding pipelines, vector databases, and RAG systems. Run it on a schedule and your local corpus stays current.

## Features

- **5 adapters** — Slack, Notion, Linear, Gmail (OAuth2), GOG (Gmail via [`gog` CLI](https://github.com/steipete/gogcli))
- **Full + incremental sync** — first run fetches everything; subsequent runs fetch only changes
- **Crash-resumable** — state checkpointed after each batch; interrupted syncs resume where they left off
- **Markdown output** — every document has YAML frontmatter + JSON sidecar for programmatic access
- **Per-entity error isolation** — one failed page/channel/issue never aborts the entire sync
- **Adaptive rate limiting** — token bucket, tiered, unit-based, and header-driven strategies per API
- **Binary downloads** — attachments, images, and files stored alongside their parent documents
- **Daemon mode** — long-running process with configurable sync interval

## Quick Start

```bash
# Install dependencies (Node.js >= 20, Yarn 4.x via Corepack)
corepack enable
yarn install

# Configure credentials
cp .env.example .env.local
# Edit .env.local with your API keys (see Configuration below)

# Full sync (first run)
yarn sync:full

# Incremental sync (subsequent runs)
yarn sync
```

## Architecture

```
┌──────────────────────────────────────────────────┐
│                   CLI (Commander)                 │
│          sync | status | adapters | daemon        │
├──────────────────────────────────────────────────┤
│                  SyncEngine                       │
│   Orchestrates adapters, manages lifecycle        │
├──────┬──────┬──────┬──────┬──────────────────────┤
│Slack │Notion│Linear│Gmail │ GOG                   │
│  ▼   │  ▼   │  ▼   │  ▼   │  ▼                   │
│ API  │ API  │ GQL  │OAuth2│ CLI                   │
├──────┴──────┴──────┴──────┴──────────────────────┤
│              Core Framework                       │
│  State · RateLimiter · Output · Retry · Logger    │
└──────────────────────────────────────────────────┘
         │
         ▼
    data/<adapter>/
    ├── documents.md      (YAML frontmatter + Markdown)
    ├── _meta.json        (JSON sidecar)
    └── attachments/      (binary files)
```

Each adapter implements a single interface:

```typescript
interface Adapter {
  name: string;
  sync(ctx: SyncContext): Promise<SyncResult>;
}
```

The `SyncContext` provides everything an adapter needs: sync mode, output directory, persistent state with `checkpoint()`, a pre-configured rate limiter, structured logger, and an `AbortSignal` for graceful shutdown.

## Project Structure

```
packages/
  core/             Shared types, sync engine, rate limiter, state manager,
                    output writer, retry, slugify, logger, CLI
adapters/
  slack/            Slack Conversations API
  notion/           Notion Search + Blocks API
  linear/           Linear GraphQL API
  gmail/            Gmail REST API (OAuth2)
  gog/              Gmail via gog CLI (https://github.com/steipete/gogcli)
scheduling/         launchd plist + sync script for automated runs
data/               Local output directory (gitignored)
```

## CLI

```bash
# Sync all configured adapters (incremental)
yarn sync

# Full hydration
yarn sync:full

# Sync a specific adapter
yarn sync -- --adapter slack

# Check sync status
yarn sync -- status

# List available adapters (based on configured env vars)
yarn sync -- adapters

# Daemon mode (continuous sync every N minutes)
yarn daemon
```

## Configuration

Copy `.env.example` to `.env.local` and fill in credentials for the services you want to sync. Only adapters with configured credentials will run.

### Slack

| Variable | Description |
|----------|-------------|
| `SLACK_BOT_TOKEN` | Bot token (`xoxb-...`) or user token (`xoxp-...`) with `channels:history`, `channels:read`, `users:read` scopes |
| `SLACK_SKIP_DMS` | Skip DMs and group DMs (default: `false`) |
| `SLACK_SKIP_FILES` | Skip file downloads (default: `false`) |

### Notion

| Variable | Description |
|----------|-------------|
| `NOTION_TOKEN` | Internal integration token (`ntn_...`) with access to target pages/databases |

### Linear

| Variable | Description |
|----------|-------------|
| `LINEAR_API_KEY` | Personal API key (`lin_api_...`) from Linear Settings > API |
| `LINEAR_TEAM_KEYS` | Comma-separated team keys to sync (e.g., `ENG,PROD`). Omit to sync all. |
| `LINEAR_INCLUDE_ARCHIVED` | Include archived issues (default: `true`) |
| `LINEAR_DOWNLOAD_ATTACHMENTS` | Download file attachments (default: `true`) |

### Gmail (OAuth2)

| Variable | Description |
|----------|-------------|
| `GMAIL_CLIENT_ID` | OAuth2 client ID from Google Cloud Console |
| `GMAIL_CLIENT_SECRET` | OAuth2 client secret |
| `GMAIL_REFRESH_TOKEN` | OAuth2 refresh token |
| `GMAIL_MAX_ATTACHMENT_MB` | Max attachment size in MB (default: `25`) |
| `GMAIL_INCLUDE_SPAM_TRASH` | Include spam/trash (default: `false`) |
| `GMAIL_INCLUDE_DRAFTS` | Include drafts (default: `false`) |
| `GMAIL_BATCH_SIZE` | Messages per page (default: `500`, max: `500`) |
| `GMAIL_CONCURRENCY` | Parallel message fetches (default: `2`) |

### GOG (Gmail via `gog` CLI)

Uses the [`gog` CLI](https://github.com/steipete/gogcli) (an open-source Go CLI by steipete) to access Gmail. OAuth is handled by `gog`'s own keyring — no raw credentials needed.

| Variable | Description |
|----------|-------------|
| `GOG_ACCOUNT` | Gmail account email. Required to enable the adapter. |
| `GOG_PATH` | Path to `gog` binary (default: `gog` on PATH) |

Prerequisites: `gog` must be installed and authenticated (`gog auth login`).
See [`adapters/gog/README.md`](adapters/gog/README.md) for full details and troubleshooting.

## Output Format

Every adapter produces Markdown with YAML frontmatter:

```markdown
---
source: slack
type: message
id: "C01234"
title: "general"
date: "2026-01-15T10:30:00Z"
---

# general

**alice** (10:30 AM):
Hey team, the deploy went well.
```

Each document has a companion JSON sidecar (`_meta.json`) with full structured metadata.

### Directory Layout

```
data/
├── slack/
│   ├── channels/{channel-slug}/messages.md
│   ├── threads/{channel-slug}/{thread-ts}.md
│   └── _meta/{users,channels}.json
├── notion/
│   ├── {page-slug}/index.md
│   └── {db-slug}/rows/{row-slug}.md
├── linear/
│   ├── issues/{team-key}/{TEAM-123}.md
│   └── _meta/{teams,users,labels}.json
├── gmail/
│   ├── messages/{msg-id}.md
│   ├── threads/{thread-id}.md
│   └── attachments/{msg-id}/{filename}
└── gog/
    └── (same structure as gmail)
```

## Sync Modes

### Full (`--full`)

Fetches all accessible data. Use for the first run or to re-baseline.

### Incremental (default)

Fetches only changes since last sync. Each adapter uses the optimal change detection for its API:

| Adapter | Mechanism |
|---------|-----------|
| Slack | Per-channel timestamp watermarks |
| Notion | `last_edited_time` comparison |
| Linear | `updatedAt` GraphQL filter |
| Gmail | History API (`historyId`) |
| GOG | History API via `gog gmail history` |

If state is missing or expired, adapters automatically fall back to full sync.

## Scheduling

saas-mirror is a batch tool — it syncs and exits. Scheduling is handled externally.

### macOS launchd (recommended)

An installer script generates a launchd plist with correct absolute paths for your checkout:

```bash
# Install — generates plist, symlinks to ~/Library/LaunchAgents/, loads the service
scheduling/setup.sh

# Verify
launchctl list | grep saas-mirror

# Run immediately (outside the 30-min schedule)
launchctl start com.saas-mirror.sync

# Uninstall
scheduling/setup.sh uninstall
```

The `sync-and-index.sh` script runs the sync, then optionally indexes the output into a vector store if `RETRIEVAL_SKILL_DIR` is set and an embedding server is running on `:8100`. See `.env.example` for details.

### Cron

```bash
# Incremental every 15 minutes
*/15 * * * * cd /path/to/saas-mirror && yarn sync >> /var/log/saas-mirror.log 2>&1

# Weekly full re-baseline
0 2 * * 0 cd /path/to/saas-mirror && yarn sync:full >> /var/log/saas-mirror.log 2>&1
```

## Adding a New Adapter

1. Create `adapters/<name>/` with `package.json`, `tsconfig.json`, `vitest.config.ts`
2. Implement the `Adapter` interface from `@saas-mirror/core`
3. Register in `packages/core/src/engine.ts`
4. Add env vars to `.env.example`
5. Add build/typecheck entries to root `package.json` scripts

See any existing adapter for the full pattern: API client, types, writer, tests.

## Development

```bash
yarn install          # Install dependencies
yarn build            # Compile TypeScript
yarn typecheck        # Type check all packages
yarn test             # Run all tests
```

## Requirements

- Node.js >= 20
- Yarn 4.x (via Corepack)

## License

[MIT](LICENSE)
