import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Coverage: run `npm i -D @vitest/coverage-v8` then `npm run test:coverage`.
    // coverage: { provider: "v8", reporter: ["text", "html"] },
  },
});
