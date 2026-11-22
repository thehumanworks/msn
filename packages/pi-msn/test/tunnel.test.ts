import assert from "node:assert/strict";
import { test } from "node:test";
import { startTunnel, TunnelError, waitUntilPublic } from "../src/tunnel.ts";
import { config, fakeSpawn } from "./helpers.ts";

// Copied from cloudflared 2026.11.1.
const CLOUDFLARED_LOG = `2026-11-22T02:01:09Z INF Requesting new quick Tunnel on trycloudflare.com...
2026-11-22T02:01:12Z INF +--------------------------------------------------------------------------------------------+
2026-11-22T02:01:12Z INF |  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):  |
2026-11-22T02:01:12Z INF |  https://beaver-thru-graphic-happen.trycloudflare.com                                      |
2026-11-22T02:01:12Z INF +--------------------------------------------------------------------------------------------+
`;

test("cloudflared: a quick tunnel to the local port, with no account or login arguments", async () => {
  const fake = fakeSpawn((child) => {
    child.print(
      "2026-11-22T02:01:09Z INF Thank you for trying Cloudflare Tunnel. See https://www.cloudflare.com/website-terms/\n",
    );
    child.print(CLOUDFLARED_LOG);
  });
  const tunnel = await startTunnel(config(), 4321, fake.spawn);
  assert.equal(tunnel.url, "https://beaver-thru-graphic-happen.trycloudflare.com");
  assert.deepEqual(fake.calls, [
    { command: "cloudflared", args: ["tunnel", "--no-autoupdate", "--url", "http://127.0.0.1:4321"] },
  ]);
  assert.equal(tunnel.alive(), true);
  await tunnel.stop();
  assert.deepEqual(fake.children[0].killed_with, ["SIGTERM"]);
  assert.equal(tunnel.alive(), false);
});

test("cloudflared missing: the error says no account is needed and names the other ways", async () => {
  const fake = fakeSpawn((child) =>
    child.emit("error", Object.assign(new Error("spawn cloudflared ENOENT"), { code: "ENOENT" })),
  );
  await assert.rejects(startTunnel(config(), 1, fake.spawn), (error: Error) => {
    assert.ok(error instanceof TunnelError);
    assert.match(error.message, /not installed/);
    assert.match(error.message, /no Cloudflare account is needed/);
    assert.match(error.message, /"command".*"none"/);
    return true;
  });
});

test("a tunnel that exits or stays silent fails with its last output", async () => {
  const exits = fakeSpawn((child) => {
    child.print("ERR failed to connect\n");
    child.exit(1);
  });
  await assert.rejects(
    startTunnel(config(), 1, exits.spawn),
    /stopped \(exit 1\) before it printed a public URL[\s\S]*failed to connect/,
  );
  const silent = fakeSpawn((child) => child.print("still starting\n"));
  await assert.rejects(
    startTunnel(config({ tunnelTimeoutMs: 1000 }), 1, silent.spawn),
    /no public URL within 1 seconds/,
  );
  assert.deepEqual(silent.children[0].killed_with, ["SIGTERM"], "the silent program is stopped");
});

test("command: any program; {port} and {url} are filled in and the first https URL is taken", async () => {
  const fake = fakeSpawn((child) =>
    child.print("Forwarding http://127.0.0.1:99 <- https://abc.ngrok.app/ (ready).\n"),
  );
  const tunnel = await startTunnel(
    config({ tunnel: "command", tunnelCommand: ["ngrok", "http", "{port}", "--upstream={url}"] }),
    99,
    fake.spawn,
  );
  assert.equal(tunnel.url, "https://abc.ngrok.app");
  assert.deepEqual(fake.calls, [
    { command: "ngrok", args: ["http", "99", "--upstream=http://127.0.0.1:99"] },
  ]);
  await tunnel.stop();
});

test("command: tunnelUrlPattern chooses among several URLs", async () => {
  const fake = fakeSpawn((child) =>
    child.print("docs https://docs.example.com\nurl https://me.tail1234.ts.net\n"),
  );
  const tunnel = await startTunnel(
    config({
      tunnel: "command",
      tunnelCommand: ["tailscale", "funnel", "{port}"],
      tunnelUrlPattern: "https://[a-z0-9.-]+\\.ts\\.net",
    }),
    5,
    fake.spawn,
  );
  assert.equal(tunnel.url, "https://me.tail1234.ts.net");
  await tunnel.stop();
});

test("none: the given public address is used and no program starts", async () => {
  const fake = fakeSpawn();
  const tunnel = await startTunnel(
    config({ tunnel: "none", publicUrl: "https://agent.example.com/hooks/", port: 8787 }),
    8787,
    fake.spawn,
  );
  assert.deepEqual(
    [tunnel.url, tunnel.provider, tunnel.alive(), fake.calls.length],
    ["https://agent.example.com/hooks", "none", true, 0],
  );
});

test("waitUntilPublic: true once the health page answers through the public address", async () => {
  let calls = 0;
  const fetcher = (async (url: string) => {
    calls += 1;
    assert.equal(url, "https://x.trycloudflare.com/healthz");
    if (calls < 2) throw new Error("getaddrinfo ENOTFOUND");
    return new Response("ok\n");
  }) as unknown as typeof fetch;
  assert.equal(await waitUntilPublic("https://x.trycloudflare.com", 5000, fetcher), true);
  assert.equal(calls, 2);
  // Another site's page at that address does not count.
  const other = (async () => new Response("<html>")) as unknown as typeof fetch;
  assert.equal(await waitUntilPublic("https://x.trycloudflare.com", 1000, other), false);
  // A dead tunnel is not waited for.
  assert.equal(await waitUntilPublic("https://x.trycloudflare.com", 60_000, other, () => false), false);
});
