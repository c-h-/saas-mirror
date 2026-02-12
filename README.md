# saas-mirror

Local replication of SaaS data (Slack, Notion, Linear, Gmail) into Markdown files for embedding, RAG, and semantic search.

## Features

- **5 adapters**: Slack, Notion, Linear, Gmail (raw OAuth2), GOG (Gmail via `gog` CLI)
- **Full hydration + incremental sync**: first run fetches everything; subsequent runs fetch only changes
- **Crash-resumable**: state checkpointed after each entity batch — interrupted syncs resume where they left off
- **Markdown + YAML frontmatter output**: every document is RAG-ready, with structured metadata in frontmatter and JSON sidecars
- **Per-entity error isolation**: one failed page/channel/issue/email never aborts the entire sync
- **Rate limiting**: adapts to each API's model (token bucket, tiered, unit-based, header-driven)
- **Binary asset downloads**: attachments, images, and files stored alongside their parent documents

## Quick Start

```bash
# 1. Install dependencies
yarn install

# 2. Configure credentials
cp .env.example .env.local
# Edit .env.local with your API keys (see Configuration below)

# 3. Full hydration (first run)
yarn sync:full

# 4. Incremental sync (subsequent runs / cron)
yarn sync
```

## Project Structure

```
packages/
  core/             Shared types, sync engine, rate limiter, state manager,
                    output writer, retry, slugify, logger, CLI
adapters/
  slack/            Slack Conversations API adapter
  notion/           Notion Search + Blocks API adapter
  linear/           Linear GraphQL API adapter
  gmail/            Gmail REST API adapter (raw OAuth2 credentials)
  gog/              Gmail via `gog` CLI adapter (OAuth handled by keyring)
data/               Local output directory (gitignored)
```

## CLI Usage

```bash
# Sync all configured adapters (incremental by default)
yarn sync

# Full hydration of all adapters
yarn sync:full

# Sync a specific adapter
yarn sync -- --adapter slack
yarn sync:full -- --adapter linear

# Check sync status (last sync time, item counts)
yarn sync -- status

# List available adapters
yarn sync -- adapters
```

Or run the CLI directly:

```bash
node --import tsx/esm packages/core/src/cli.ts sync --adapter notion --full
node --import tsx/esm packages/core/src/cli.ts status
node --import tsx/esm packages/core/src/cli.ts adapters
```

## Configuration

### Environment Variables

Copy `.env.example` to `.env.local` and fill in your credentials:

#### Slack

| Variable | Description |
|----------|-------------|
| `SLACK_BOT_TOKEN` | Bot token (`xoxb-...`) or user token (`xoxp-...`) with `channels:history`, `channels:read`, `users:read` scopes |
| `SLACK_SKIP_DMS` | Set to `true` to skip DMs and group DMs (default: `false`) |
| `SLACK_SKIP_FILES` | Set to `true` to skip file downloads (default: `false`) |

#### Notion

| Variable | Description |
|----------|-------------|
| `NOTION_TOKEN` | Internal integration token (`ntn_...`) — must have access to target pages/databases |

#### Linear

| Variable | Description |
|----------|-------------|
| `LINEAR_API_KEY` | Personal API key (`lin_api_...`) from Linear Settings > API |
| `LINEAR_TEAM_KEYS` | Comma-separated team keys to sync (e.g., `ENG,PROD`). Omit to sync all teams. |
| `LINEAR_INCLUDE_ARCHIVED` | Include archived issues (default: `true`) |
| `LINEAR_DOWNLOAD_ATTACHMENTS` | Download file attachments (default: `true`) |

#### Gmail

| Variable | Description |
|----------|-------------|
| `GMAIL_CLIENT_ID` | OAuth2 client ID from Google Cloud Console |
| `GMAIL_CLIENT_SECRET` | OAuth2 client secret |
| `GMAIL_REFRESH_TOKEN` | OAuth2 refresh token (obtain via OAuth flow) |
| `GMAIL_MAX_ATTACHMENT_MB` | Max attachment size to download in MB (default: `25`) |
| `GMAIL_INCLUDE_SPAM_TRASH` | Include spam/trash messages (default: `false`) |
| `GMAIL_INCLUDE_DRAFTS` | Include draft messages (default: `false`) |
| `GMAIL_BATCH_SIZE` | Messages per page when listing (default: `500`, max: `500`) |
| `GMAIL_CONCURRENCY` | Parallel message fetches (default: `2`) |

#### GOG (Gmail via `gog` CLI)

The GOG adapter uses the [`gog` CLI](https://github.com/c-h-/gog) to access Gmail. The `gog` CLI handles OAuth via its own keyring, so no raw OAuth2 credentials are needed.

| Variable | Description |
|----------|-------------|
| `GOG_ACCOUNT` | Gmail account email (e.g., `charlie@kindo.ai`). Required to enable the adapter. |
| `GOG_PATH` | Path to `gog` binary (default: `gog` on PATH, or `/opt/homebrew/bin/gog`) |

Prerequisites: `gog` must be installed and authenticated (`gog auth login`).

### Output Directory

All output is written to `./data/<adapter-name>/`. The `data/` directory is gitignored.

## Output Format

Every adapter produces the same consistent output structure:

### Markdown Documents

```markdown
---
source: slack
type: message
id: "C01234"
title: "Channel Name"
date: "2026-01-15T10:30:00Z"
# ... adapter-specific fields
---

# Channel Name

(Content body in Markdown)
```

### JSON Metadata Sidecars

Each markdown document has a companion `_meta.json` or `.meta.json` file with full structured metadata for programmatic access.

### Directory Layout

```
data/
├── slack/
│   ├── channels/{channel-slug}/messages.md
│   ├── channels/{channel-slug}/messages.jsonl
│   ├── channels/{channel-slug}/_meta.json
│   ├── threads/{channel-slug}/{thread-ts}.md
│   ├── files/{file-id}/{filename}
│   └── _meta/{users,channels}.json
├── notion/
│   ├── {page-slug}/index.md
│   ├── {page-slug}/_meta.json
│   ├── {page-slug}/{child-page-slug}/...
│   ├── {db-slug}/_db_schema.json
│   ├── {db-slug}/rows/{row-slug}.md
│   └── _users.json
├── linear/
│   ├── issues/{team-key}/{TEAM-123}.md
│   ├── projects/{slug}.md
│   ├── attachments/{TEAM-123}/{filename}
│   └── _meta/{teams,users,labels,workflow-states,cycles}.json
├── gmail/
│   ├── messages/{msg-id}.md
│   ├── messages/{msg-id}.meta.json
│   ├── threads/{thread-id}.md
│   ├── attachments/{msg-id}/{filename}
│   └── _labels.json
└── gog/
    ├── messages/{msg-id}.md
    ├── messages/{msg-id}.meta.json
    ├── threads/{thread-id}.md
    ├── attachments/{msg-id}/{filename}
    └── _meta/labels.json
```

## Sync Modes

### Full Hydration (`--full`)

Fetches all accessible data from the API. Use for the first run or to re-baseline.

### Incremental Sync (default)

Fetches only changes since the last sync. Each adapter uses the optimal change detection mechanism for its API:

| Adapter | Mechanism | State Key |
|---------|-----------|-----------|
| Slack | Per-channel timestamp watermarks | `channelHighWaterMark` |
| Notion | `last_edited_time` comparison | `pageLastEdited` |
| Linear | `updatedAt` GraphQL filter | `lastSyncAt` |
| Gmail | History API with `historyId` | `cursors.historyId` |
| GOG | History API via `gog gmail history` | `metadata.historyId` |

If state is missing or stale, adapters automatically fall back to full sync.

## Scheduling with Cron

Set up a cron job for regular incremental syncs:

```bash
# Every 15 minutes
*/15 * * * * cd /path/to/saas-mirror && yarn sync >> /var/log/saas-mirror.log 2>&1

# Every hour
0 * * * * cd /path/to/saas-mirror && yarn sync >> /var/log/saas-mirror.log 2>&1

# Nightly full sync (re-baseline weekly)
0 2 * * 0 cd /path/to/saas-mirror && yarn sync:full >> /var/log/saas-mirror.log 2>&1
```

Or use `launchd` on macOS:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.saas-mirror.sync</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/local/bin/yarn</string>
        <string>sync</string>
    </array>
    <key>WorkingDirectory</key>
    <string>/path/to/saas-mirror</string>
    <key>StartInterval</key>
    <integer>900</integer>
    <key>StandardOutPath</key>
    <string>/var/log/saas-mirror.log</string>
    <key>StandardErrorPath</key>
    <string>/var/log/saas-mirror-error.log</string>
</dict>
</plist>
```

## Development

```bash
# Install dependencies
yarn install

# Run all tests
yarn test

# Type check
yarn typecheck

# Build (compile TypeScript)
yarn build
```

### Architecture

Each adapter implements the `Adapter` interface from `@saas-mirror/core`:

```typescript
interface Adapter {
  name: string;
  sync(ctx: SyncContext): Promise<SyncResult>;
}
```

The `SyncContext` provides:
- `mode` — `"full"` or `"incremental"`
- `outputDir` — adapter-specific output directory
- `state` — persistent state with `checkpoint()` for crash resumability
- `rateLimiter` — pre-configured rate limiter for the adapter's API
- `logger` — structured logger
- `signal` — `AbortSignal` for graceful shutdown (Ctrl+C)

### Error Handling

- **Per-entity isolation**: one entity failure never aborts the sync
- **Automatic retry**: transient errors (5xx, ECONNRESET, timeouts) retried with exponential backoff
- **Rate limit handling**: 429 responses trigger backoff via the rate limiter
- **Checkpoint resumability**: state persisted after each batch; interrupted syncs resume from last checkpoint

## Requirements

- Node.js >= 20
- Yarn 4.x (Corepack)
