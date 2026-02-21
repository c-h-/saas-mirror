# AGENTS.md

Developer guide for contributing to saas-mirror.

## Quick Start

```bash
corepack enable
yarn install
yarn build
yarn test
```

## Monorepo Structure

Yarn workspaces with TypeScript project references. No turbo — build order is explicit in root `package.json`.

```
packages/core/       Framework: types, engine, CLI, state, rate-limiter, output, retry, logger, slugify
adapters/slack/      Slack Conversations API adapter
adapters/notion/     Notion Search + Blocks API adapter
adapters/linear/     Linear GraphQL API adapter
adapters/gmail/      Gmail REST API adapter (OAuth2)
adapters/gog/        Gmail via gog CLI adapter
scheduling/          launchd plist + sync-and-index script
```

## How Adapters Work

Every adapter implements a single interface:

```typescript
interface Adapter {
  name: string;
  sync(ctx: SyncContext): Promise<SyncResult>;
}
```

`SyncContext` provides:
- `mode` — `"full"` or `"incremental"`
- `outputDir` — where to write files
- `state` — persistent state with `checkpoint()`, `lastSyncAt`, `cursors`, `metadata`
- `rateLimiter` — pre-configured for the adapter's API limits
- `logger` — structured logging
- `signal` — `AbortSignal` for graceful shutdown

Typical adapter structure:
```
adapters/<name>/
  src/
    adapter.ts      Main sync logic (implements Adapter)
    api.ts          API client wrapper with rate limiting
    types.ts        API response types
    writer.ts       Markdown output formatting
    __tests__/      Unit tests
  package.json      Declares @saas-mirror/core as workspace dependency
  tsconfig.json     Extends root config
  vitest.config.ts  Test configuration
```

### Adapter patterns

- **Config from env vars** — each adapter reads its own env vars, validates required ones, throws early if missing
- **Full vs incremental branching** — adapters check `mode` and `state.lastSyncAt` to decide strategy
- **Batch processing with checkpoints** — fetch in pages/batches, call `state.checkpoint()` after each batch for crash resumability
- **Per-entity error isolation** — wrap each entity in try/catch, collect errors in `SyncError[]`, never abort the whole sync
- **Rate limiter integration** — use `ctx.rateLimiter.acquire()` before API calls; call `rateLimiter.backoff(ms)` on 429s
- **Output via writer** — use `createOutputWriter(outputDir)` for consistent markdown + JSON output

## Commands

```bash
yarn build          # Compile all packages (explicit order)
yarn typecheck      # Type check all packages (uses tsc -b)
yarn test           # Run all tests via vitest
yarn lint           # Check formatting and lint rules (Biome)
yarn lint:fix       # Auto-fix lint and formatting issues
yarn test:integration  # Run integration tests (requires API credentials)
yarn sync           # Incremental sync
yarn sync:full      # Full hydration
yarn daemon         # Long-running daemon mode
```

## Technical Conventions

- **TypeScript strict mode** throughout, targeting ES2022
- **ESM-only** (`"type": "module"` in all package.json files)
- **vitest** for testing with workspace configuration
- **Yarn 4.x** with Corepack for package management
- **Biome** for linting and formatting (`biome.json` at root)

## Key Decisions

- **Sequential adapter execution** — adapters run one at a time to simplify rate limiting and error handling
- **No ORM/database** — all state is JSON files in `data/<adapter>/_meta/`
- **Atomic file writes** — write to tmp file, then rename, to prevent corruption on crash
- **Adaptive rate limiting** — each API gets its own strategy (token bucket, unit-based, tiered)
- **YAML frontmatter** — chosen over pure JSON for human readability; JSON sidecars for programmatic access
- **Scheduling externalized** — saas-mirror syncs and exits. OS scheduler (cron/launchd) handles timing.
