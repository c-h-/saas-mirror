/**
 * Integration test for the Gmail adapter.
 *
 * Requires GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, and GMAIL_REFRESH_TOKEN
 * to be set. Skipped entirely when any credential is missing.
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
import { GmailAdapter } from "../../adapters/gmail/src/adapter.js";

const hasCredentials = Boolean(
  process.env.GMAIL_CLIENT_ID &&
    process.env.GMAIL_CLIENT_SECRET &&
    process.env.GMAIL_REFRESH_TOKEN,
);

describe.skipIf(!hasCredentials)("GmailAdapter integration", () => {
  let outputDir: string;

  beforeAll(async () => {
    outputDir = await mkdtemp(join(tmpdir(), "saas-mirror-gmail-"));
  });

  afterAll(async () => {
    if (outputDir) {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("should sync Gmail data without errors", async () => {
    const adapter = new GmailAdapter();
    const ctx = createSyncContext("full", outputDir);

    const result = await adapter.sync(ctx);

    expect(result.adapter).toBe("gmail");
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
