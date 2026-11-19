import { exports } from "cloudflare:workers";
import { expect, it } from "vitest";

it("serves the CLI install script as plain text a shell can pipe", async () => {
  const response = await exports.default.fetch("https://msn.test/install.sh");
  expect(response.status).toBe(200);
  expect(response.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
  expect(response.headers.get("Cache-Control")).toBe("public, max-age=300");
  const body = await response.text();
  expect(body.startsWith("#!/bin/sh\n")).toBe(true);
  expect(body).toContain("checksum verified");
});
