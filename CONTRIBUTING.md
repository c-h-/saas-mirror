# Contributing to saas-mirror

Thanks for your interest in contributing! This guide covers everything you need to get started.

## Prerequisites

- **Node.js >= 20**
- **Corepack enabled** (`corepack enable`) -- this provides Yarn 4.x automatically
- **Yarn 4.x** -- do not install Yarn globally; Corepack manages it via the `packageManager` field in `package.json`

## Getting Started

```bash
git clone https://github.com/c-h-/saas-mirror.git
cd saas-mirror
corepack enable
yarn install
yarn build
yarn test
```

If all tests pass, you are ready to develop.

## Development Workflow

### Common Commands

```bash
yarn build          # Compile all packages (explicit build order)
yarn typecheck      # Type-check all packages (uses tsc -b; also emits output)
yarn test           # Run all tests (vitest)
yarn lint           # Check formatting and lint rules (Biome)
yarn lint:fix       # Auto-fix lint and formatting issues
```

### Making Changes

1. Create a feature branch from `main`.
2. Make your changes. The monorepo uses Yarn workspaces with TypeScript project references -- no Turborepo.
3. Run `yarn build` to verify compilation.
4. Run `yarn test` to verify tests pass.
5. Run `yarn lint` to verify code style.

### Running a Single Adapter

To test a specific adapter during development:

```bash
# Configure credentials in .env.local (copy from .env.example)
yarn sync -- --adapter slack
```

## Writing an Adapter

Every adapter implements a single interface from `@saas-mirror/core`:

```typescript
interface Adapter {
  name: string;
  sync(ctx: SyncContext): Promise<SyncResult>;
}
```

### Steps

1. Create `adapters/<name>/` with `package.json`, `tsconfig.json`, and `vitest.config.ts`.
2. Implement the `Adapter` interface in `src/adapter.ts`.
3. Register the adapter in `packages/core/src/engine.ts`.
4. Add required env vars to `.env.example`.
5. Add build/typecheck entries to the root `package.json` scripts.

### Typical File Layout

```
adapters/<name>/
  src/
    adapter.ts      # Main sync logic
    api.ts          # API client with rate limiting
    types.ts        # API response types
    writer.ts       # Markdown output formatting
    __tests__/      # Unit tests
  package.json
  tsconfig.json
  vitest.config.ts
```

### Key Patterns

- **Config from env vars** -- validate required vars and throw early if missing.
- **Full vs incremental** -- branch on `ctx.mode` and `ctx.state.lastSyncAt`.
- **Batch + checkpoint** -- call `ctx.state.checkpoint()` after each batch for crash resumability.
- **Per-entity error isolation** -- wrap each entity in try/catch; collect errors in `SyncError[]`.
- **Rate limiter** -- call `ctx.rateLimiter.acquire()` before API calls; call `rateLimiter.backoff(ms)` on 429s.

See [AGENTS.md](AGENTS.md) for full architectural details and design decisions.

## Code Style

We use [Biome](https://biomejs.dev/) for linting and formatting. The configuration lives in `biome.json` at the repo root.

Key style rules:
- **2-space indentation**
- **Double quotes** for strings
- Biome recommended lint rules are enabled
- Import organization is handled automatically

```bash
yarn lint           # Check for issues
yarn lint:fix       # Auto-fix issues
```

Please run `yarn lint` before submitting a PR. CI will reject code that does not pass.

## Pull Request Process

1. **Branch** -- create a branch off `main` with a descriptive name (e.g., `feat/jira-adapter`, `fix/slack-pagination`).
2. **Test** -- ensure `yarn build`, `yarn test`, and `yarn lint` all pass.
3. **Commit** -- write clear commit messages. Use conventional prefixes when appropriate: `feat:`, `fix:`, `chore:`, `docs:`.
4. **PR** -- open a pull request against `main`. Include a brief description of what changed and why.
5. **Review** -- address any feedback. Keep PRs focused -- one feature or fix per PR.

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
