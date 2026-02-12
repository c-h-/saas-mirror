# saas-mirror

Local replication of SaaS data (Slack, Notion, Linear, Gmail) for embedding and semantic search.

## Structure

```
adapters/
  slack/      — Slack Conversations API adapter
  notion/     — Notion Search + Blocks API adapter
  linear/     — Linear GraphQL API adapter
  gmail/      — Gmail REST API adapter
packages/
  core/       — Shared types, interfaces, sync state management
data/         — Local output (gitignored)
```

## Setup

```bash
yarn install
cp .env.example .env.local  # fill in credentials
```

## Usage

```bash
# Full hydration (first run)
yarn sync:full

# Incremental sync (cron)
yarn sync
```

## Architecture

Each adapter implements the `Adapter` interface from `@saas-mirror/core`:

- **`sync({ mode: "full" })`** — Initial hydration: fetches all accessible data
- **`sync({ mode: "incremental" })`** — Delta sync using per-adapter cursors/timestamps

Output is written as Markdown/plaintext files (RAG-friendly) with JSON metadata sidecars. Sync state (cursors, timestamps, history IDs) is persisted between runs.
