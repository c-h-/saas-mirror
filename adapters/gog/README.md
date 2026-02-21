# GOG Adapter (Experimental)

> **Warning:** This adapter depends on `gog`, a private/internal CLI tool that is
> **not publicly available**. If you do not already have access to `gog`, you
> cannot use this adapter. For Gmail sync, use the
> [Gmail (OAuth2) adapter](../gmail/) instead.

## Overview

The GOG adapter syncs Gmail data into local Markdown files by shelling out to the
`gog` CLI binary. `gog` is a Go-based tool that wraps the Gmail / Google APIs and
manages OAuth credentials via its own OS keyring -- no raw client secrets or
refresh tokens are needed in your environment.

Because `gog` is not publicly documented or distributed, **this adapter is
considered experimental** and is provided only for users who already have the tool
installed and authenticated.

## When to Use This vs. the Gmail Adapter

| | Gmail (OAuth2) adapter | GOG adapter |
|---|---|---|
| **Authentication** | Requires `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REFRESH_TOKEN` | Requires only `GOG_ACCOUNT`; OAuth handled by `gog` keyring |
| **Dependency** | None beyond Node.js | Requires the `gog` CLI binary |
| **Public availability** | Fully open | `gog` CLI is private/internal |
| **Recommendation** | Use this for most setups | Use only if you already have `gog` |

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `GOG_ACCOUNT` | Yes | Gmail account email address (e.g., `user@gmail.com`). Setting this variable enables the adapter. |
| `GOG_PATH` | No | Absolute path to the `gog` binary. Defaults to `gog` (looked up on `$PATH`). |

## Prerequisites

1. **Obtain the `gog` CLI.** This is a private tool -- it is not available on npm,
   Homebrew, or any public package registry. You must obtain it through internal
   channels.

2. **Authenticate `gog` with your Google account:**

   ```bash
   gog auth login
   ```

   This opens a browser-based OAuth flow and stores the resulting token in your
   OS keyring. No credentials are written to disk in plain text.

3. **Verify the CLI works:**

   ```bash
   gog gmail labels list --json --account you@gmail.com
   ```

   You should see a JSON list of your Gmail labels.

## How It Works

The adapter invokes `gog` as a child process for each Gmail API operation:

- **Label listing:** `gog gmail labels list`
- **Message search:** `gog gmail messages search <query> --max <n>`
- **Message fetch:** `gog gmail get <messageId> --format full`
- **Attachment download:** `gog gmail attachment <messageId> <attachmentId>`
- **History (incremental):** `gog gmail history --since <historyId>`

All commands are called with `--json --no-input --account <GOG_ACCOUNT>`.

### Sync Modes

- **Full sync:** Lists all message IDs via search, fetches each message, downloads
  attachments, and builds per-thread views. The highest `historyId` is recorded for
  future incremental runs.
- **Incremental sync:** Uses the Gmail History API (via `gog gmail history`) to
  fetch only messages added or deleted since the last `historyId`. Falls back to
  full sync if history has expired.

### Rate Limiting

The adapter self-throttles with a 1.5-second delay between `gog` CLI calls to stay
within Gmail API quotas. Fetch concurrency is limited to 2 parallel calls.

## Output

Output follows the same structure as the Gmail adapter:

```
data/gog/
  labels.md                       All Gmail labels
  messages/{msg-id}.md            Individual messages (Markdown + YAML frontmatter)
  messages/{msg-id}_meta.json     JSON sidecar with full metadata
  threads/{thread-id}.md          Threaded conversation view
  attachments/{msg-id}/{file}     Binary attachments
```

## Troubleshooting

- **`GOG_ACCOUNT environment variable is required`** -- Set `GOG_ACCOUNT` to your
  Gmail address in `.env.local`.
- **`gog gmail labels list failed: ...`** -- Ensure `gog` is on your PATH (or set
  `GOG_PATH`) and that you have authenticated with `gog auth login`.
- **Rate limit errors (429)** -- The adapter retries automatically with backoff.
  If errors persist, increase the delay between calls or reduce concurrency.
- **History expired** -- If too much time passes between syncs, Gmail discards the
  history. The adapter falls back to a full sync automatically.
