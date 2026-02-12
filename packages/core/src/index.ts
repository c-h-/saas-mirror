/** Shared adapter interface for all SaaS mirrors. */
export interface SyncOptions {
  /** Full hydration (all data) vs incremental (changes since last sync). */
  mode: "full" | "incremental";
  /** Where to write output files. */
  outputDir: string;
  /** Path to sync state (cursors, timestamps, etc). */
  stateFile: string;
}

export interface SyncResult {
  adapter: string;
  itemsSynced: number;
  errors: string[];
  durationMs: number;
}

export interface Adapter {
  name: string;
  sync(options: SyncOptions): Promise<SyncResult>;
}

/** Sync state persisted between runs for incremental sync. */
export interface SyncState {
  lastSyncAt: string; // ISO timestamp
  cursors: Record<string, string>; // adapter-specific cursors
  metadata: Record<string, unknown>;
}

export function loadState(path: string): SyncState | null {
  try {
    const fs = require("fs");
    return JSON.parse(fs.readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

export function saveState(path: string, state: SyncState): void {
  const fs = require("fs");
  fs.writeFileSync(path, JSON.stringify(state, null, 2));
}
