#!/usr/bin/env node
import { Command } from "commander";
import { config as loadDotenv } from "dotenv";
import { SyncEngine } from "./engine.js";
import type { AdapterRegistration, SyncResult } from "./types.js";

loadDotenv();
loadDotenv({ path: ".env.local", override: true });

async function loadAdapters(): Promise<AdapterRegistration[]> {
  const registrations: AdapterRegistration[] = [];

  // Try loading each adapter — skip if not installed
  try {
    const { SlackAdapter } = await import("@saas-mirror/slack");
    if (process.env.SLACK_BOT_TOKEN) {
      registrations.push({
        adapter: new SlackAdapter(),
        rateLimiterConfig: { minDelayMs: 600, maxRequests: 50, windowMs: 60_000 },
      });
    }
  } catch { /* adapter not installed */ }

  try {
    const { NotionAdapter } = await import("@saas-mirror/notion");
    if (process.env.NOTION_TOKEN) {
      registrations.push({
        adapter: new NotionAdapter(),
        rateLimiterConfig: { maxRequests: 3, windowMs: 1_000, minDelayMs: 200 },
      });
    }
  } catch { /* adapter not installed */ }

  try {
    const { LinearAdapter } = await import("@saas-mirror/linear");
    if (process.env.LINEAR_API_KEY) {
      registrations.push({
        adapter: new LinearAdapter(),
        rateLimiterConfig: { minDelayMs: 50, maxRequests: 4500, windowMs: 3_600_000 },
      });
    }
  } catch { /* adapter not installed */ }

  try {
    const { GmailAdapter } = await import("@saas-mirror/gmail");
    if (process.env.GMAIL_CLIENT_ID && process.env.GMAIL_REFRESH_TOKEN) {
      registrations.push({
        adapter: new GmailAdapter(),
        rateLimiterConfig: { maxUnitsPerWindow: 14_000, unitsWindowMs: 60_000 },
      });
    }
  } catch { /* adapter not installed */ }

  try {
    const { GogAdapter } = await import("@saas-mirror/gog");
    if (process.env.GOG_ACCOUNT || process.env.GOG_PATH) {
      registrations.push({
        adapter: new GogAdapter(),
        rateLimiterConfig: { maxRequests: 20, windowMs: 1_000 },
      });
    }
  } catch { /* adapter not installed */ }

  return registrations;
}

function printResults(results: SyncResult[]): void {
  console.log("\n═══ Sync Summary ═══\n");
  for (const r of results) {
    const status = r.errors.length === 0 ? "✓" : "⚠";
    console.log(
      `${status} ${r.adapter} (${r.mode}): ${r.itemsSynced} synced, ${r.itemsFailed} failed [${(r.durationMs / 1000).toFixed(1)}s]`,
    );
    for (const err of r.errors.slice(0, 5)) {
      console.log(`  ✗ ${err.entity}: ${err.error}`);
    }
    if (r.errors.length > 5) {
      console.log(`  ... and ${r.errors.length - 5} more errors`);
    }
  }
}

const program = new Command()
  .name("saas-mirror")
  .description("Local replication of SaaS data for embedding/search")
  .version("0.1.0");

program
  .command("sync")
  .description("Sync data from configured adapters")
  .option("--full", "Run full hydration instead of incremental")
  .option("--adapter <name>", "Sync a specific adapter only")
  .option("--output <dir>", "Output directory", "./data")
  .action(async (opts) => {
    const mode = opts.full ? "full" : "incremental";
    const outputDir = opts.output;
    const adapters = await loadAdapters();

    if (adapters.length === 0) {
      console.error(
        "No adapters configured. Set API credentials in .env file.",
      );
      console.error("See .env.example for required variables.");
      process.exit(1);
    }

    const engine = new SyncEngine({
      outputDir,
      stateDir: outputDir,
      adapters,
    });

    let results: SyncResult[];
    if (opts.adapter) {
      const result = await engine.syncOne(opts.adapter, mode);
      results = [result];
    } else {
      results = await engine.syncAll(mode);
    }

    printResults(results);

    const hasErrors = results.some((r) => r.errors.length > 0);
    process.exit(hasErrors ? 1 : 0);
  });

program
  .command("status")
  .description("Check sync status for all adapters")
  .option("--output <dir>", "Output directory", "./data")
  .action(async (opts) => {
    const fs = await import("node:fs");
    const path = await import("node:path");

    const adapterNames = ["slack", "notion", "linear", "gmail", "gog"];
    for (const name of adapterNames) {
      const stateFile = path.join(opts.output, name, "_meta", "state.json");
      try {
        const raw = fs.readFileSync(stateFile, "utf-8");
        const state = JSON.parse(raw);
        console.log(
          `${name}: last synced ${state.lastSyncAt ?? "never"}`,
        );
      } catch {
        console.log(`${name}: no sync state found`);
      }
    }
  });

program
  .command("adapters")
  .description("List available adapters")
  .action(async () => {
    const adapters = await loadAdapters();
    if (adapters.length === 0) {
      console.log("No adapters configured. Set API credentials in .env");
    } else {
      console.log("Configured adapters:");
      for (const a of adapters) {
        console.log(`  - ${a.adapter.name}`);
      }
    }
  });

program.parse();
