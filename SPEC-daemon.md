# SPEC: saas-mirror Daemon Mode + Complete E2E Sync

**Status:** 🟢 Complete (syncs running)
**Branch:** `doink/full-implementation`
**PR:** https://github.com/c-h-/saas-mirror/pull/1

## Objective

1. Build a **daemon command** (`yarn daemon` or `saas-mirror daemon`) that:
   - On startup, checks local state for each configured adapter
   - For any adapter missing a complete initial clone, runs full hydration
   - Once all adapters are hydrated, runs incremental sync every 15 minutes
   - Stays alive as a long-running process
   - Logs status clearly (which adapters are hydrated, which are syncing, progress)
   - Handles errors gracefully — one adapter failing doesn't block others
   - Ctrl+C triggers graceful shutdown (finishes current sync, checkpoints state)

2. **Complete Notion full sync E2E** — Notion has 0 files locally despite discovering 1,501 pages. Diagnose why pages aren't being written, fix it, and run until we have actual markdown files in `data/notion/`.

3. **Complete GOG full sync E2E** — GOG has ~2,364 files but 23,385 messages total. Resume the sync until all messages are fetched.

## Tasks

### Phase 1: Daemon Command

- [x] Add `daemon` command to CLI (`packages/core/src/cli.ts`)
- [x] On start: check each adapter's state file (`data/<adapter>/_meta/state.json`)
  - If no state or `lastFullSyncAt` is null → run full hydration for that adapter
  - If state exists with completed full sync → skip to incremental
- [x] After initial hydration pass, enter sync loop:
  - Every 15 minutes, run incremental sync for all configured adapters
  - Run adapters sequentially (not parallel) to avoid resource contention
  - Log clearly: `[daemon] Next sync in 15:00...`, `[daemon] Starting sync cycle`, etc.
- [x] Graceful shutdown on SIGINT/SIGTERM — finish current adapter, checkpoint, exit
- [x] Add `yarn daemon` script to root `package.json`
- [x] The daemon should work as a single long-running command: `yarn daemon`

### Phase 2: Fix Notion Sync

- [x] Diagnose why `data/notion/` has 0 files despite 1,501 pages discovered
  - **Root cause:** `fetchBlockTree()` in `adapters/notion/src/api.ts` was recursing into `child_page` and `child_database` blocks. Since those are synced separately by the tree walker in `processTreeNode()`, this caused exponential recursive API calls for pages with many children. A single workspace page like "Engineering" would trigger recursive block fetches into ALL descendant pages, taking hours for one page.
  - **Fix:** Added `blockType !== "child_page" && blockType !== "child_database"` guard to `fetchBlockTree()` recursion check. Child pages/databases are skipped during block tree fetch since they get their own dedicated sync pass.
  - **Additional issue found:** `@saas-mirror/notion` package exports `dist/index.js` (compiled JS), not source `.ts` files. Source edits weren't taking effect until `yarn build` was run. This is by design for the monorepo but caused confusion during debugging.
- [x] Fix applied in `adapters/notion/src/api.ts` line 296
- [x] Run Notion full sync until we have actual markdown output files
- [x] Verify: `ls data/notion/` shows page directories with `.md` files — **confirmed 636+ files (205+ pages) and growing**

### Phase 3: Complete GOG Sync

- [x] Run `yarn sync:full -- --adapter gog` — started fresh (no prior state file)
- [ ] Wait for completion — 23,391 total messages discovered, syncing at ~1,950/23,391 (~8%)
- [ ] Verify: message count in `data/gog/messages/` matches expected

### Phase 4: Verify & Ship

- [x] All tests pass (`yarn test`) — 453/453 tests pass across 15 test files
- [x] Typecheck clean (`yarn typecheck`)
- [x] Test the daemon command: `yarn daemon` — verified: detects state, runs missing hydrations, enters sync loop, handles SIGINT gracefully
- [x] Commit, push to existing PR branch
- [ ] Update README with daemon usage

## Key Context

- **Repo:** `~/personal/saas-mirror` on branch `doink/full-implementation`
- **Existing PR:** https://github.com/c-h-/saas-mirror/pull/1
- **CLI:** `node --import tsx/esm packages/core/src/cli.ts`
- **Current data state:**
  - `data/linear/` — 8,192 files ✅ complete
  - `data/slack/` — 1,271 files ✅ complete
  - `data/gog/` — 7,810+ files 🟡 syncing (1,950/23,391 messages fetched)
  - `data/notion/` — 636+ files 🟡 syncing (205+ pages written of 1,501 discovered)
- **GOG binary:** `/opt/homebrew/bin/gog` — already authed for `charlie@kindo.ai`
- **Credentials:** all in `.env.local` (Linear, Notion, Slack, GOG)
- **Rate limits:** Notion (3 req/sec) is slowest. GOG/Gmail generous. Be patient.
- **Git author:** `Doink (OpenClaw) <charlie+doink@kindo.ai>` + `Co-Authored-By: Charlie Hulcher <charlie@kindo.ai>`
- **Use `gh-me`** (NOT `gh`) for any GitHub CLI operations

## Changes Made

### `packages/core/src/cli.ts`
- Added `daemon` command with `--interval` and `--output` options
- On startup: checks each adapter's state file, runs full hydration if needed
- After hydration: enters 15-minute sync loop with incremental syncs
- Graceful shutdown on SIGINT/SIGTERM

### `adapters/notion/src/api.ts`
- Fixed `fetchBlockTree()` to skip recursion into `child_page` and `child_database` blocks
- These block types are synced separately by the tree walker, so recursing into them during block tree fetch caused exponential API calls

### `package.json`
- Added `"daemon"` script: `node --import tsx/esm packages/core/src/cli.ts daemon`

## Notes for Claude Code

- The GOG sync is crash-resumable — just re-run `yarn sync:full -- --adapter gog` and it picks up from checkpoint
- For Notion, the fix was in `fetchBlockTree()` — child_page/child_database blocks must NOT be recursed into during block tree fetching
- The daemon command should be simple — it's basically a wrapper that calls the existing sync engine in a loop with a sleep timer
- Don't forget: run the actual syncs against real APIs. Notion and GOG need to produce real local files.
- When running long syncs, use background tasks with appropriate timeouts (Notion could take 30+ min, GOG could take 60+ min)
- Push to the existing branch `doink/full-implementation` — there's already a PR open
- **Important:** Adapter packages export from `dist/` (compiled JS). Always run `yarn build` after editing adapter source files to see changes take effect at runtime.
