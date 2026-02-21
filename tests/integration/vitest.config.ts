import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    testTimeout: 120_000, // 2 minutes — real API calls can be slow
    hookTimeout: 30_000,
    root: new URL(".", import.meta.url).pathname,
    include: ["*.integration.test.ts"],
  },
  resolve: {
    alias: {
      "@saas-mirror/core": new URL(
        "../../packages/core/src/index.ts",
        import.meta.url,
      ).pathname,
    },
  },
});
