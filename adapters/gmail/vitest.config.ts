import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { globals: true },
  resolve: {
    alias: {
      "@saas-mirror/core": new URL(
        "../../packages/core/src/index.ts",
        import.meta.url,
      ).pathname,
    },
  },
});
