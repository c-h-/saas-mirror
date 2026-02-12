import type { Adapter, SyncOptions, SyncResult } from "@saas-mirror/core";

export class GmailAdapter implements Adapter {
  name = "gmail" as const;

  async sync(_options: SyncOptions): Promise<SyncResult> {
    throw new Error("Not implemented");
  }
}
