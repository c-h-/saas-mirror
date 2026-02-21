/**
 * Integration test for the Notion adapter.
 *
 * Requires NOTION_TOKEN to be set.
 * Skipped entirely when credentials are not available.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AdapterState,
  Logger,
  RateLimiter,
  SyncContext,
} from "@saas-mirror/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NotionAdapter } from "../../adapters/notion/src/adapter.js";

const hasCredentials = Boolean(process.env.NOTION_TOKEN);

describe.skipIf(!hasCredentials)("NotionAdapter integration", () => {
  let outputDir: string;

  beforeAll(async () => {
    outputDir = await mkdtemp(join(tmpdir(), "saas-mirror-notion-"));
  });

  afterAll(async () => {
    if (outputDir) {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("should sync Notion data without errors", async () => {
    const adapter = new NotionAdapter();
    const ctx = createSyncContext("full", outputDir);

    const result = await adapter.sync(ctx);

    expect(result.adapter).toBe("notion");
    expect(result.mode).toBe("full");
    expect(result.errors).toEqual([]);
    expect(result.itemsSynced).toBeGreaterThan(0);
    expect(result.durationMs).toBeGreaterThan(0);
  });
});

// ── Helpers ──

function createSyncContext(
  mode: "full" | "incremental",
  outputDir: string,
): SyncContext {
  return {
    mode,
    outputDir,
    state: createMockState(),
    rateLimiter: createNoopRateLimiter(),
    logger: createSilentLogger(),
    signal: new AbortController().signal,
  };
}

function createMockState(): AdapterState {
  return {
    lastSyncAt: null,
    cursors: {},
    metadata: {},
    async checkpoint() {},
  };
}

function createNoopRateLimiter(): RateLimiter {
  return {
    async acquire() {},
    backoff() {},
    updateFromHeaders() {},
  };
}

function createSilentLogger(): Logger {
  return {
    info() {},
    warn() {},
    error() {},
    progress() {},
  };
}
