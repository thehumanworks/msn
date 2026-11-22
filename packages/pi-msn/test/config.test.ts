import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ConfigError, DEFAULTS, loadConfig } from "../src/config.ts";

function dir(content: unknown): string {
  const path = mkdtempSync(join(tmpdir(), "pi-msn-config-"));
  writeFileSync(join(path, "pi-msn.json"), typeof content === "string" ? content : JSON.stringify(content));
  return path;
}

test("defaults: steering, a cloudflared quick tunnel, direct tools", () => {
  const config = loadConfig({});
  assert.deepEqual(config, DEFAULTS);
  assert.deepEqual(
    [config.deliverAs, config.tunnel, config.tools, config.msnBin],
    ["steer", "cloudflared", "direct", "msn"],
  );
});

test("the project file wins over the user file, and the environment over both", () => {
  const agentDir = dir({ board: "user-board", persona: "reviewer", deliverAs: "followUp" });
  const projectDir = dir({ board: "project-board" });
  const config = loadConfig({
    agentDir,
    projectDir,
    env: { PI_MSN_DELIVER_AS: "nextTurn", PI_MSN_WEBHOOK: "1" },
  });
  assert.deepEqual(
    [config.board, config.persona, config.deliverAs, config.autoStart],
    ["project-board", "reviewer", "nextTurn", true],
  );
  // An untrusted project passes no projectDir, so its file is never read.
  assert.equal(loadConfig({ agentDir }).board, "user-board");
});

test("a bearer key is taken from the environment only", () => {
  const agentDir = dir({ bearer: "key-in-a-file-000" });
  assert.equal(loadConfig({ agentDir }).bearer, undefined);
  assert.equal(
    loadConfig({ agentDir, env: { PI_MSN_WEBHOOK_BEARER: "key-in-env-000" } }).bearer,
    "key-in-env-000",
  );
  assert.throws(() => loadConfig({ env: { PI_MSN_WEBHOOK_BEARER: "short" } }), ConfigError);
});

test("a custom tunnel command is an argv, from a file or as JSON in the environment", () => {
  assert.throws(() => loadConfig({ env: { PI_MSN_TUNNEL: "command" } }), /needs tunnelCommand/);
  assert.deepEqual(
    loadConfig({ env: { PI_MSN_TUNNEL: "command", PI_MSN_TUNNEL_COMMAND: '["ngrok","http","{port}"]' } })
      .tunnelCommand,
    ["ngrok", "http", "{port}"],
  );
  assert.throws(() => loadConfig({ env: { PI_MSN_TUNNEL_COMMAND: "ngrok http" } }), /JSON array/);
  assert.throws(() => loadConfig({ agentDir: dir({ tunnelCommand: [] }) }), /non-empty array/);
});

test('tunnel "none" needs a public https address and a fixed port', () => {
  assert.throws(() => loadConfig({ env: { PI_MSN_TUNNEL: "none" } }), /needs publicUrl/);
  assert.throws(
    () => loadConfig({ env: { PI_MSN_TUNNEL: "none", PI_MSN_PUBLIC_URL: "https://a.example.com" } }),
    /fixed port/,
  );
  assert.throws(
    () =>
      loadConfig({
        env: { PI_MSN_TUNNEL: "none", PI_MSN_PUBLIC_URL: "http://a.example.com", PI_MSN_PORT: "8787" },
      }),
    /must be https/,
  );
  const config = loadConfig({
    env: { PI_MSN_TUNNEL: "none", PI_MSN_PUBLIC_URL: "https://a.example.com", PI_MSN_PORT: "8787" },
  });
  assert.deepEqual([config.publicUrl, config.port], ["https://a.example.com", 8787]);
});

test("bad values are refused with the name of the setting", () => {
  assert.throws(
    () => loadConfig({ env: { PI_MSN_DELIVER_AS: "interrupt" } }),
    /PI_MSN_DELIVER_AS must be one of: steer, followUp, nextTurn/,
  );
  assert.throws(() => loadConfig({ env: { PI_MSN_PORT: "70000" } }), /PI_MSN_PORT/);
  assert.throws(() => loadConfig({ env: { PI_MSN_PATH: "wake" } }), /path must start/);
  assert.throws(() => loadConfig({ agentDir: dir("{not json") }), /not valid JSON/);
  assert.throws(
    () => loadConfig({ agentDir: dir({ tools: "all" }) }),
    /tools in .*pi-msn\.json must be one of/,
  );
});
