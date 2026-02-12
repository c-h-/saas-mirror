// Adapter
export { GogAdapter } from "./adapter.js";

// Types
export type {
  GogLabel,
  GogMessageSummary,
  GogMessageFull,
  GogMimePart,
  GogSyncMetadata,
} from "./types.js";

// CLI wrapper (for advanced usage / testing)
export { GogCli } from "./cli.js";

// Writer utilities
export {
  writeMessage,
  writeLabels,
  writeThreadView,
  removeMessage,
} from "./writer.js";
