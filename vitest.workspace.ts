import { defineWorkspace } from "vitest/config";

export default defineWorkspace([
  "packages/core",
  "adapters/linear",
  "adapters/slack",
  "adapters/gmail",
  "adapters/notion",
  "adapters/gog",
]);
