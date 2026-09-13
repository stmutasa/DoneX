import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
      // Next's client/server guard; harmless and unresolvable in tests.
      "server-only": path.resolve(__dirname, "src/test/server-only-stub.ts"),
    },
  },
});
