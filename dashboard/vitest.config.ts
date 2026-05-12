import { defineConfig } from "vitest/config";
import path from "node:path";

/**
 * Dashboard test config — runs only the files under dashboard/src/tests/.
 * The path alias mirrors tsconfig.json so test imports of "@/lib/..." resolve.
 */
export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/tests/**/*.test.ts"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
