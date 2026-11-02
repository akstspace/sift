import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "./src") } },
  test: {
    environment: "jsdom",
    // Full-workspace interaction tests and V8 coverage are memory/CPU intensive.
    // Bound contention instead of extending timeouts or weakening assertions.
    maxWorkers: 1,
    setupFiles: ["./src/test/setup.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.{ts,tsx}"],
      exclude: ["src/**/*.test.{ts,tsx}", "src/test/**", "src/**/*.d.ts"],
      reporter: ["text", "json", "json-summary", "html", "lcov"],
      reportsDirectory: "../docs/verification/frontend-coverage",
    },
  },
});
