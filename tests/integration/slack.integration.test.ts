/**
 * Integration test for the Slack adapter.
 *
 * Requires SLACK_BOT_TOKEN (or SLACK_TOKEN) to be set.
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
import { SlackAdapter } from "../../adapters/slack/src/adapter.js";

const hasCredentials = Boolean(
  process.env.SLACK_BOT_TOKEN ?? process.env.SLACK_TOKEN,
);

describe.skipIf(!hasCredentials)("SlackAdapter integration", () => {
  let outputDir: string;

  beforeAll(async () => {
    outputDir = await mkdtemp(join(tmpdir(), "saas-mirror-slack-"));
  });

  afterAll(async () => {
    if (outputDir) {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("should sync Slack data without errors", async () => {
    const adapter = new SlackAdapter();
    const ctx = createSyncContext("full", outputDir);

    const result = await adapter.sync(ctx);

    expect(result.adapter).toBe("slack");
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
