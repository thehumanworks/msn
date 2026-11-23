import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        kvNamespaces: ["OAUTH_KV"],
        bindings: { ADMIN_TOKEN: "test-admin-secret-000000000000000000000" },
      },
    }),
  ],
  test: { include: ["tests/*.test.ts"], testTimeout: 15000 },
});
