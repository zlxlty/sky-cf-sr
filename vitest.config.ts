import { defineConfig } from "vitest/config";

// The handler is a pure function of its inputs, so the tests run in Node
// without the Workers runtime or the Cloudflare Vite plugin.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
  },
});
