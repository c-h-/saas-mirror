import type { Adapter, SyncOptions, SyncResult } from "@saas-mirror/core";

export class LinearAdapter implements Adapter {
  name = "linear" as const;

  async sync(_options: SyncOptions): Promise<SyncResult> {
    throw new Error("Not implemented");
  }
}
