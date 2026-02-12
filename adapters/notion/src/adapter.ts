import type { Adapter, SyncOptions, SyncResult } from "@saas-mirror/core";

export class NotionAdapter implements Adapter {
  name = "notion" as const;

  async sync(_options: SyncOptions): Promise<SyncResult> {
    throw new Error("Not implemented");
  }
}
