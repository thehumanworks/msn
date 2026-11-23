import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "browser.spec.mjs",
  fullyParallel: false,
  workers: 1,
  timeout: 30000,
  use: { baseURL: "http://127.0.0.1:8788", trace: "retain-on-failure" },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 1000 } } },
    { name: "mobile", use: { ...devices["Pixel 7"] } },
  ],
  webServer: {
    command:
      "bunx --no-install wrangler dev --port 8788 --ip 127.0.0.1 --local-upstream 127.0.0.1:8788 --var MCP_ORIGIN:http://127.0.0.1:8788",
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: { ADMIN_TOKEN: "browser-test-admin-000000000000000000000" },
    url: "http://127.0.0.1:8788/api/health",
    reuseExistingServer: false,
  },
});
