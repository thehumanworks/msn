import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: { bindings: { ADMIN_TOKEN: "test-admin-secret-000000000000000000000" } },
    }),
  ],
  test: { include: ["tests/api.test.ts"], testTimeout: 15000 },
});
