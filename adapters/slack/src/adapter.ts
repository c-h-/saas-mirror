import type { Adapter, SyncOptions, SyncResult } from "@saas-mirror/core";

export class SlackAdapter implements Adapter {
  name = "slack" as const;

  async sync(_options: SyncOptions): Promise<SyncResult> {
    // TODO: implement
    throw new Error("Not implemented");
  }
}
