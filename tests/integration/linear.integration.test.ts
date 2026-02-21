/**
 * Integration test for the Linear adapter.
 *
 * Requires LINEAR_API_KEY to be set.
 * Skipped entirely when credentials are not available.
 *
 * Note: LinearAdapter validates the API key in its constructor, so
 * we must guard construction behind the credential check as well.
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
import { LinearAdapter } from "../../adapters/linear/src/adapter.js";

const hasCredentials = Boolean(process.env.LINEAR_API_KEY);

describe.skipIf(!hasCredentials)("LinearAdapter integration", () => {
  let outputDir: string;

  beforeAll(async () => {
    outputDir = await mkdtemp(join(tmpdir(), "saas-mirror-linear-"));
  });

  afterAll(async () => {
    if (outputDir) {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("should sync Linear data without errors", async () => {
    const adapter = new LinearAdapter();
    const ctx = createSyncContext("full", outputDir);

    const result = await adapter.sync(ctx);

    expect(result.adapter).toBe("linear");
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
