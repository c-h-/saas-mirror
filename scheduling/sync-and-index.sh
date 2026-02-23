#!/bin/bash
# saas-mirror sync + index pipeline
# Designed to run via launchd every 30 minutes.
# Syncs all configured SaaS adapters, then re-indexes changed files.
#
# Setup: run scheduling/setup.sh to install the launchd service.
# Logs: /tmp/saas-mirror.log

set -euo pipefail

# --- Self-locate repo root ---
# Works whether invoked directly, via symlink, or by launchd.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MIRROR_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DATA_DIR="$MIRROR_DIR/data"
LOCK_FILE="/tmp/saas-mirror.lock"
LOG_PREFIX="[$(date '+%Y-%m-%d %H:%M:%S')]"

# --- Build PATH ---
# Check common locations for node/yarn. Works with mise, nvm, Homebrew, and system installs.
for p in \
    "$HOME/.local/share/mise/shims" \
    "$HOME/.local/bin" \
    "$HOME/.nvm/versions/node/"*/bin \
    "/opt/homebrew/bin" \
    "/usr/local/bin"; do
    [ -d "$p" ] && export PATH="$p:$PATH"
done

# Verify required tools are available
for cmd in node yarn; do
    if ! command -v "$cmd" &>/dev/null; then
        echo "$LOG_PREFIX ERROR: '$cmd' not found in PATH. Install Node.js >= 20 and Yarn 4.x." >&2
        exit 1
    fi
done

# --- Load env ---
if [ -f "$MIRROR_DIR/.env.local" ]; then
    set -a
    # shellcheck disable=SC1091
    source "$MIRROR_DIR/.env.local"
    set +a
fi

# --- Singleton Lock ---
# Prevent overlapping runs. If previous run is still going, skip this cycle.
if [ -f "$LOCK_FILE" ]; then
    LOCK_PID=$(cat "$LOCK_FILE" 2>/dev/null)
    if kill -0 "$LOCK_PID" 2>/dev/null; then
        echo "$LOG_PREFIX Skipping — previous run still active (PID $LOCK_PID)"
        exit 0
    else
        echo "$LOG_PREFIX Removing stale lock (PID $LOCK_PID no longer running)"
        rm -f "$LOCK_FILE"
    fi
fi
echo $$ > "$LOCK_FILE"
trap 'rm -f "$LOCK_FILE"' EXIT

echo "$LOG_PREFIX Starting saas-mirror sync + index"

# --- Phase 1: Sync ---
echo "$LOG_PREFIX Phase 1: Syncing SaaS mirrors..."
cd "$MIRROR_DIR"
if yarn sync 2>&1; then
    echo "$LOG_PREFIX Sync completed successfully"
else
    echo "$LOG_PREFIX Sync completed with errors (continuing to index)"
fi

# --- Phase 2: Index saas-mirror data ---
# Requires RETRIEVAL_SKILL_DIR to point at a retrieval-skill checkout.
# Skip gracefully if unset or missing.
RETRIEVAL_DIR="${RETRIEVAL_SKILL_DIR:-}"
if [ -z "$RETRIEVAL_DIR" ]; then
    echo "$LOG_PREFIX Phase 2: Skipping indexing (RETRIEVAL_SKILL_DIR not set)"
elif [ ! -d "$RETRIEVAL_DIR" ]; then
    echo "$LOG_PREFIX Phase 2: Skipping indexing (RETRIEVAL_SKILL_DIR=$RETRIEVAL_DIR does not exist)"
elif ! curl -s -o /dev/null -w '%{http_code}' http://localhost:8100/v1/embeddings -X POST \
    -H "Content-Type: application/json" \
    -d '{"input":"healthcheck","model":"Octen-Embedding-8B"}' | grep -q "200"; then
    echo "$LOG_PREFIX Phase 2: Skipping indexing (embedding server not running on :8100)"
else
    echo "$LOG_PREFIX Phase 2: Indexing saas-mirror data..."
    cd "$RETRIEVAL_DIR"

    for adapter in linear notion slack gog; do
        adapter_dir="$DATA_DIR/$adapter"
        if [ -d "$adapter_dir" ]; then
            echo "$LOG_PREFIX   Indexing $adapter..."
            node src/cli.mjs index "$adapter_dir" --name "$adapter" 2>&1 || \
                echo "$LOG_PREFIX   Warning: $adapter indexing failed"
        fi
    done

    echo "$LOG_PREFIX Indexing completed"
fi

# --- Phase 3: Index codebase repos ---
# Optional: index additional local repos via retrieval-skill's sync-repos.sh.
# Requires RETRIEVAL_SKILL_DIR to be set and sync-repos.sh to exist.
SYNC_REPOS_SCRIPT="${RETRIEVAL_DIR:+$RETRIEVAL_DIR/sync-repos.sh}"
if [ -n "$SYNC_REPOS_SCRIPT" ] && [ -x "$SYNC_REPOS_SCRIPT" ]; then
    echo "$LOG_PREFIX Phase 3: Indexing codebase repos..."
    "$SYNC_REPOS_SCRIPT" 2>&1 || \
        echo "$LOG_PREFIX Phase 3: Warning: codebase indexing failed"
else
    echo "$LOG_PREFIX Phase 3: Skipping codebase indexing (no sync-repos.sh found)"
fi

echo "$LOG_PREFIX Done"
