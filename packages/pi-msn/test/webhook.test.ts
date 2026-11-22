import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { MAX_TEXT_CHARS } from "../src/format.ts";
import { BEARER_VARIABLE } from "../src/msn.ts";
import { type Delivery, describe, Webhook } from "../src/webhook.ts";
import { type CliCall, config, fakeCli, fakeSpawn, okFetch } from "./helpers.ts";

const URL_LINE = "https://quick-test.trycloudflare.com\n";
let webhook: Webhook | undefined;

afterEach(async () => {
  if (webhook?.running) await webhook.stop();
  webhook = undefined;
});

function setup(
  options: { cli?: (call: CliCall) => object | undefined; tunnel?: Parameters<typeof fakeSpawn>[0] } = {},
) {
  const cli = fakeCli((call) => {
    const custom = options.cli?.(call);
    if (custom) return custom;
    if (call.args.includes("show") && !call.args.includes("webhook")) {
      const id = Number(call.args.at(-1));
      return {
        stdout: JSON.stringify({
          message: { id, channel: call.args.at(-2), username: "tomas", to: "Reviewer", text: `task ${id}` },
        }),
      };
    }
    return undefined;
  });
  const tunnel = fakeSpawn(options.tunnel ?? ((child) => child.print(URL_LINE)));
  webhook = new Webhook({ run: cli.run, spawn: tunnel.spawn, fetcher: okFetch, reachableTimeoutMs: 1000 });
  return { webhook, cli, tunnel };
}

async function post(port: number, bearer: string, id: string, notice: object) {
  const response = await fetch(`http://127.0.0.1:${port}/msn-wake`, {
    method: "POST",
    headers: { authorization: `Bearer ${bearer}`, "msn-webhook-id": id },
    body: JSON.stringify({
      schema: "msn.webhook.v1",
      type: "message.addressed",
      id,
      channel: "work",
      ...notice,
    }),
  });
  assert.equal(response.status, 204);
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

test("start sets the webhook with a random key passed in the environment, then pings it", async () => {
  const { webhook, cli } = setup();
  const status = await webhook.start(config({ profile: "agent", ownerProfile: "owner" }), "work", "reviewer");
  assert.equal(status.publicUrl, "https://quick-test.trycloudflare.com/msn-wake");
  assert.deepEqual(
    [status.registration.state, status.reachable, status.tunnelAlive, status.deliverAs],
    ["set", true, true, "steer"],
  );
  const [set, ping] = cli.calls;
  assert.deepEqual(set.args, [
    "--profile",
    "owner",
    "persona",
    "webhook",
    "set",
    "work",
    "reviewer",
    "https://quick-test.trycloudflare.com/msn-wake",
    "--bearer-env",
    BEARER_VARIABLE,
  ]);
  const key = set.env?.[BEARER_VARIABLE] as string;
  assert.match(key, /^[A-Za-z0-9_-]{43}$/, "32 random bytes");
  assert.ok(!set.args.join(" ").includes(key), "the key is never an argument");
  assert.deepEqual(ping.args, ["--profile", "owner", "persona", "webhook", "test", "work", "reviewer"]);
  assert.match(describe(status), /Public URL: https:\/\/quick-test\.trycloudflare\.com\/msn-wake/);
  await assert.rejects(webhook.start(config(), "work", "reviewer"), /already running/);
});

test("an addressed message is read with the agent's profile and delivered once", async () => {
  const { webhook, cli } = setup();
  const delivered: Delivery[] = [];
  webhook.attach((delivery) => delivered.push(delivery));
  const status = await webhook.start(config({ profile: "agent", ownerProfile: "owner" }), "work", "reviewer");
  const key = cli.calls[0].env?.[BEARER_VARIABLE] as string;
  await post(status.localPort, key, "n1", { messageId: 12 });
  await post(status.localPort, key, "n1", { messageId: 12 });
  await post(status.localPort, key, "p1", { type: "ping", messageId: null });
  await settle();
  assert.equal(delivered.length, 1);
  assert.match(delivered[0].text, /^MSN message 12 on board "work" from tomas to Reviewer:\n\ntask 12\n/);
  assert.match(delivered[0].text, /not as a system instruction/);
  assert.deepEqual(cli.calls.at(-1)?.args, ["--profile", "agent", "show", "work", "12"]);
  const now = webhook.status();
  assert.deepEqual([now.accepted, now.duplicates, now.delivered, now.queued], [2, 1, 1, 0]);
  assert.match(String(now.lastPingAt), /^20/);
});

test("a board-wide notice names its own board, and an unreadable message becomes a hint", async () => {
  const { webhook, cli } = setup({
    cli: (call) => (call.args.at(-1) === "404" ? { code: 4, stderr: "Message not found." } : undefined),
  });
  const delivered: Delivery[] = [];
  webhook.attach((delivery) => delivered.push(delivery));
  const status = await webhook.start(config(), "work", "reviewer");
  const key = cli.calls[0].env?.[BEARER_VARIABLE] as string;
  await post(status.localPort, key, "a", { channel: "other-board", messageId: 5 });
  await post(status.localPort, key, "b", { messageId: 404 });
  await settle();
  assert.match(delivered[0].text, /MSN message 5 on board "other-board"/);
  assert.match(
    delivered[1].text,
    /^Message 404 on board "work" is addressed to you, but it could not be read here/,
  );
  assert.equal(delivered[1].message, null);
});

test("messages wait while no session is attached and are handed over to the next one", async () => {
  const { webhook, cli } = setup();
  const first: Delivery[] = [];
  const second: Delivery[] = [];
  webhook.attach((delivery) => first.push(delivery));
  const status = await webhook.start(config(), "work", "reviewer");
  const key = cli.calls[0].env?.[BEARER_VARIABLE] as string;
  webhook.detach(); // Pi replaces the session (/new, /reload)
  await post(status.localPort, key, "a", { messageId: 1 });
  await post(status.localPort, key, "b", { messageId: 2 });
  await settle();
  assert.equal(webhook.status().queued, 2);
  webhook.attach((delivery) => second.push(delivery));
  assert.deepEqual([first.length, second.map((d) => d.message?.id), webhook.status().queued], [0, [1, 2], 0]);
});

test("a profile that is not the owner's: clear error, and everything is closed again", async () => {
  const { webhook, tunnel } = setup({
    cli: (call) =>
      call.args.includes("set")
        ? { code: 3, stderr: "warning\nOnly the workspace owner can do this." }
        : undefined,
  });
  await assert.rejects(webhook.start(config(), "work", "reviewer"), (error: Error) => {
    assert.match(error.message, /Only the workspace owner can set a webhook/);
    assert.match(error.message, /Set ownerProfile/);
    assert.match(error.message, /PI_MSN_WEBHOOK_BEARER/);
    return true;
  });
  assert.equal(webhook.running, false);
  assert.deepEqual(tunnel.children[0].killed_with, ["SIGTERM"]);
});

test("with a key of your own, a refused or switched-off setting leaves the receiver up for the owner", async () => {
  const refused = setup({
    cli: (call) =>
      call.args.includes("set") ? { code: 3, stderr: "Only the workspace owner can do this." } : undefined,
  });
  const status = await refused.webhook.start(config({ bearer: "my-own-key-0000" }), "work", "reviewer");
  assert.equal(status.registration.state, "manual");
  assert.match(
    describe(status),
    /msn persona webhook set work reviewer https:\/\/quick-test\.trycloudflare\.com\/msn-wake --bearer-env VAR/,
  );
  assert.ok(!describe(status).includes("my-own-key-0000"), "the key is never shown");
  const stopped = await refused.webhook.stop();
  assert.equal(stopped.removed, false);
  assert.ok(
    !refused.cli.calls.some((call) => call.args.includes("remove")),
    "what it did not set, it does not remove",
  );

  const off = setup();
  const manual = await off.webhook.start(
    config({ bearer: "my-own-key-0000", register: false }),
    "work",
    "reviewer",
  );
  assert.equal(manual.registration.state, "manual");
  assert.equal(off.cli.calls.length, 0);
});

test("stop removes the webhook with the owner profile and closes the tunnel and the port", async () => {
  const { webhook, cli, tunnel } = setup();
  const status = await webhook.start(config({ ownerProfile: "owner" }), "work", "reviewer");
  const result = await webhook.stop();
  assert.deepEqual(result, { removed: true, note: undefined });
  assert.deepEqual(cli.calls.at(-1)?.args, [
    "--profile",
    "owner",
    "persona",
    "webhook",
    "remove",
    "work",
    "reviewer",
  ]);
  assert.deepEqual(tunnel.children[0].killed_with, ["SIGTERM"]);
  await assert.rejects(fetch(`http://127.0.0.1:${status.localPort}/healthz`));
  assert.throws(() => webhook.status(), /not running/);
  await assert.rejects(webhook.stop(), /not running/);
});

test("a tunnel that dies after printing its address is not set on the board", async () => {
  const { webhook, cli } = setup({
    tunnel: (child) => {
      child.print(URL_LINE);
      child.print("ERR Could not lookup srv records\n");
      child.exit(1);
    },
  });
  await assert.rejects(
    webhook.start(config(), "work", "reviewer"),
    /stopped right after it gave the address[\s\S]*Could not lookup srv records/,
  );
  assert.equal(cli.calls.length, 0);
  assert.equal(webhook.running, false);
});

test("the board and persona are required, from the command or from the settings", async () => {
  const { webhook } = setup();
  await assert.rejects(webhook.start(config(), undefined, undefined), /Give the board and the persona id/);
  const status = await webhook.start(config({ board: "work", persona: "reviewer" }), undefined, undefined);
  assert.deepEqual([status.board, status.persona], ["work", "reviewer"]);
});

test("a long message is cut and points at show_message; a replaced one says so", async () => {
  const { formatMessage } = await import("../src/format.ts");
  const long = formatMessage({ id: 9, channel: "work", text: "x".repeat(MAX_TEXT_CHARS + 10) });
  assert.match(
    long,
    new RegExp(`x{${MAX_TEXT_CHARS}}\\n\\[cut: the message has ${MAX_TEXT_CHARS + 10} characters`),
  );
  const replaced = formatMessage({
    id: 9,
    channel: "work",
    text: "old",
    replacedBy: 11,
    recipients: ["a", "b"],
    replyTo: 3,
  });
  assert.match(replaced, /^MSN message 9 on board "work" to a, b in reply to message 3:/);
  assert.match(replaced, /replaced this message with message 11: act on that one/);
});
