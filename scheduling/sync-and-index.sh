#!/bin/bash
# saas-mirror sync + index pipeline
# Designed to run via launchd every 30 minutes.
# Syncs all configured SaaS adapters, then re-indexes changed files.
#
# Setup: symlink the plist into ~/Library/LaunchAgents/ and load it:
#   ln -sf /path/to/saas-mirror/scheduling/com.saas-mirror.sync.plist ~/Library/LaunchAgents/
#   launchctl load ~/Library/LaunchAgents/com.saas-mirror.sync.plist
#
# Logs: /tmp/saas-mirror.log
# Unload: launchctl unload ~/Library/LaunchAgents/com.saas-mirror.sync.plist

set -euo pipefail

MIRROR_DIR="${SAAS_MIRROR_DIR:-$HOME/personal/saas-mirror}"
RETRIEVAL_DIR="${RETRIEVAL_SKILL_DIR:-$HOME/personal/retrieval-skill}"
DATA_DIR="$MIRROR_DIR/data"
LOCK_FILE="/tmp/saas-mirror.lock"
LOG_PREFIX="[$(date '+%Y-%m-%d %H:%M:%S')]"

# Ensure PATH includes mise-managed node
export PATH="$HOME/.local/share/mise/shims:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

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

# --- Phase 2: Index ---
# Only index if the embedding server is running
if curl -s -o /dev/null -w '%{http_code}' http://localhost:8100/v1/embeddings -X POST \
    -H "Content-Type: application/json" \
    -d '{"input":"healthcheck","model":"Octen-Embedding-8B"}' | grep -q "200"; then
    echo "$LOG_PREFIX Phase 2: Indexing (embedding server is up)..."
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
else
    echo "$LOG_PREFIX Phase 2: Skipping indexing (embedding server not running on :8100)"
fi

echo "$LOG_PREFIX Done"
