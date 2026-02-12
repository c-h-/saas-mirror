// Adapter
export { GmailAdapter } from "./adapter.js";

// Types
export type {
  GmailMessage,
  GmailLabel,
  AttachmentMeta,
  GmailConfig,
  HistoryChanges,
  LabelChange,
  MimeWalkResult,
} from "./types.js";

// Client (for advanced usage / testing)
export { GmailClient } from "./client.js";

// MIME utilities
export { walkParts, parseMessage, getHeader, bodyToMarkdown } from "./mime.js";

// Writer utilities
export {
  writeMessage,
  writeAttachments,
  writeLabels,
  writeThreadView,
  removeMessage,
  resolveLabels,
} from "./writer.js";
