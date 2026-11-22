import assert from "node:assert/strict";
import { test } from "node:test";
import { ApiError } from "../../ios/src/core/errors.ts";
import { parseJoinLink } from "../src/lib/joinLink.ts";
import {
  checkBearer,
  confirmsDelete,
  checkWebhookUrl,
  explain,
  Manage,
  subscribeNote,
  webhookSummary,
  type Webhook,
} from "../src/lib/manage.ts";

const connection = { origin: "https://msn.example", tenant: "acme", token: "t".repeat(40) };
const CODE = `acme.${"a".repeat(64)}`;
type Call = { url: string; init: RequestInit };

function fake(responses: Response[]) {
  const calls: Call[] = [];
  const fetchImpl = async (url: string, init?: RequestInit) => {
    calls.push({ url, init: init ?? {} });
    const next = responses.shift();
    if (!next) throw new Error("unexpected request");
    return next;
  };
  return { calls, manage: new Manage(connection, fetchImpl) };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const failure = (status: number, code: string, message = "no") => json({ error: { code, message } }, status);
const sent = (call: Call | undefined) => JSON.parse(String(call?.init.body)) as Record<string, unknown>;

const invite = (extra: Record<string, unknown> = {}) => ({
  id: "inv-1",
  tenant: "acme",
  channel: null,
  code: CODE,
  url: "https://evil.example/#invite=x",
  expiresAt: "2026-11-23T10:00:00.000Z",
  maxUses: 5,
  ...extra,
});

test("a workspace invitation is asked for with its limits, and its link points at this server", async () => {
  const { calls, manage } = fake([json(invite(), 201)]);
  const made = await manage.createInvite({ channel: null, maxUses: 5, expiresIn: 3600, watch: false });
  assert.equal(calls[0]?.url, "https://msn.example/api/tenants/acme/invites");
  assert.equal(calls[0]?.init.method, "POST");
  assert.equal(calls[0]?.init.redirect, "manual");
  assert.equal((calls[0]?.init.headers as Record<string, string>).Authorization, `Bearer ${connection.token}`);
  assert.deepEqual(sent(calls[0]), { channel: null, maxUses: 5, expiresIn: 3600 });
  // Built from the checked code: the server's own `url` field is never used.
  assert.equal(made.link, `https://msn.example/#invite=${CODE}`);
  assert.equal(made.watch, false);
  // The welcome screen accepts exactly what this app hands out.
  const parsed = parseJoinLink(made.link);
  assert.ok(parsed.ok && parsed.link.kind === "invite" && parsed.link.code === CODE);
});

test("a watch-only board invitation says so in the request and the result", async () => {
  const { calls, manage } = fake([json(invite({ channel: "launch", watch: true }), 201)]);
  const made = await manage.createInvite({ channel: "launch", maxUses: 5, expiresIn: 86400, watch: true });
  assert.deepEqual(sent(calls[0]), { channel: "launch", maxUses: 5, expiresIn: 86400, watch: true });
  assert.equal(made.channel, "launch");
  assert.equal(made.watch, true);
});

test("an invitation that is not what was asked for is refused", async () => {
  const ask = { channel: "launch", maxUses: 5, expiresIn: 3600, watch: true };
  for (const wrong of [
    invite({ channel: "launch", watch: true, code: `other.${"a".repeat(64)}` }),
    invite({ channel: "launch", watch: true, code: "acme.short" }),
    invite({ channel: "launch", watch: true, code: undefined }),
    invite({ channel: "launch", watch: true, expiresAt: "soon" }),
    invite({ channel: "launch" }), // full access where watch only was asked for
    invite({ channel: null, watch: true }), // the whole workspace where one board was asked for
    invite({ channel: "launch", watch: true, maxUses: 100 }),
  ]) {
    await assert.rejects(fake([json(wrong, 201)]).manage.createInvite(ask), /invitation/);
  }
});

test("revoking an invitation deletes it by id", async () => {
  const { calls, manage } = fake([new Response(null, { status: 204 })]);
  await manage.revokeInvite("inv-1");
  assert.equal(calls[0]?.url, "https://msn.example/api/tenants/acme/invites/inv-1");
  assert.equal(calls[0]?.init.method, "DELETE");
});

test("a board's shared link is one the welcome screen accepts", async () => {
  const key = "b".repeat(64);
  const { calls, manage } = fake([
    json({ url: "https://evil.example", tenant: "acme", token: key, channel: "launch", sharedChannel: true }),
  ]);
  const link = await manage.sharedBoardLink("launch");
  assert.equal(calls[0]?.url, "https://msn.example/api/tenants/acme/channels/launch/board/connection");
  assert.equal(link, `https://msn.example/#board=acme/launch&key=${key}`);
  const parsed = parseJoinLink(link ?? "");
  assert.ok(parsed.ok && parsed.link.kind === "board" && parsed.link.token === key && parsed.link.board === "launch");
});

test("a board without a shared link, or a key that may not read it, offers none", async () => {
  assert.equal(await fake([failure(404, "board_not_found")]).manage.sharedBoardLink("launch"), null);
  assert.equal(await fake([failure(404, "channel_connection_missing")]).manage.sharedBoardLink("launch"), null);
  assert.equal(await fake([failure(403, "channel_connection_required")]).manage.sharedBoardLink("launch"), null);
  await assert.rejects(fake([failure(401, "unauthorized")]).manage.sharedBoardLink("launch"), ApiError);
});

test("a shared link for another board or with a malformed key is refused", async () => {
  const key = "b".repeat(64);
  for (const wrong of [
    { tenant: "acme", token: key, channel: "other" },
    { tenant: "other", token: key, channel: "launch" },
    { tenant: "acme", token: "short", channel: "launch" },
    { tenant: "acme", token: `${key}&key=x`, channel: "launch" },
  ]) {
    await assert.rejects(fake([json(wrong)]).manage.sharedBoardLink("launch"), /invalid board link/);
  }
});

test("agents come with the ids a webhook is set on; a plain channel has none", async () => {
  const { manage } = fake([
    json({
      personas: [
        { id: "persona-1", displayName: "Planner", listening: true },
        { id: "persona-2", displayName: "Builder" },
        { displayName: "no id" },
        null,
      ],
    }),
  ]);
  assert.deepEqual(await manage.personas("launch"), [
    { id: "persona-1", displayName: "Planner", listening: true },
    { id: "persona-2", displayName: "Builder", listening: false },
  ]);
  assert.equal(await fake([failure(404, "board_not_found")]).manage.personas("launch"), null);
  await assert.rejects(fake([json({})]).manage.personas("launch"), /invalid list of agents/);
});

test("enabling agents on a plain channel provisions a shared key only in the request body", async () => {
  const { manage, calls } = fake([json({ board: { channel: "launch" }, sharedChannel: true }, 201)]);
  await manage.enableAgents("launch", (n) => { assert.equal(n, 32); return new Uint8Array(n).fill(0x0a); });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, "https://msn.example/api/tenants/acme/channels/launch/board");
  assert.equal(calls[0]?.init.method, "PUT");
  assert.equal(calls[0]?.init.redirect, "manual");
  assert.deepEqual(sent(calls[0]), { goal: "Collaborate in #launch.", credential: "0a".repeat(32) });
});

test("concurrent setup leaves the existing credential alone; other failures do not mean enabled", async () => {
  const random = (n: number) => new Uint8Array(n);
  const raced = fake([failure(409, "board_exists")]);
  await raced.manage.enableAgents("launch", random);
  assert.equal(raced.calls.length, 1);
  for (const reply of [
    failure(409, "board_archived"), failure(403, "owner_required"), failure(401, "unauthorized"),
    json({ board: { channel: "wrong" }, sharedChannel: true }), json({ board: { channel: "launch" } }),
  ]) {
    const { manage, calls } = fake([reply]);
    await assert.rejects(manage.enableAgents("launch", random));
    assert.equal(calls.length, 1); // Never rotates or falls back to creating another channel.
  }
  const { manage, calls } = fake([]);
  await assert.rejects(manage.enableAgents("launch", () => new Uint8Array(16)), /random bytes/);
  assert.equal(calls.length, 0);
});

test("registering an agent and retrying the same PUT confirm the same board, id and trimmed display name", async () => {
  const agent = { id: "persona-1", channel: "launch", displayName: "Planner" };
  const { manage, calls } = fake([json(agent, 201), json(agent, 200)]);
  for (let i = 0; i < 2; ++i) {
    assert.deepEqual(await manage.registerAgent("launch", agent.id, "  Planner "), { id: agent.id, displayName: "Planner" });
    assert.equal(calls[i]?.url, "https://msn.example/api/tenants/acme/channels/launch/personas/persona-1");
    assert.equal(calls[i]?.init.method, "PUT");
    assert.equal(calls[i]?.init.redirect, "manual");
    assert.deepEqual(sent(calls[i]), { displayName: "Planner" });
  }
});

test("invalid and reserved agent names do not write; registration never enables agents on its own", async () => {
  const { manage, calls } = fake([]);
  for (const name of [" ", "é".repeat(65), "github"])
    await assert.rejects(manage.registerAgent("launch", "persona-1", name));
  assert.equal(calls.length, 0);
  for (const [status, code] of [[403, "watch_only"], [409, "board_archived"], [404, "board_not_found"], [409, "persona_name_conflict"]] as const) {
    const denied = fake([failure(status, code)]);
    await assert.rejects(denied.manage.registerAgent("launch", "persona-1", "Planner"),
      (err: unknown) => err instanceof ApiError && err.code === code);
    assert.equal(denied.calls.length, 1);
  }
});

test("another agent, name or channel cannot confirm registration", async () => {
  const agent = { id: "persona-1", channel: "launch", displayName: "Planner" };
  for (const wrong of [{ ...agent, id: "other" }, { ...agent, channel: "elsewhere" }, { ...agent, displayName: "Other" }, {}]) {
    await assert.rejects(fake([json(wrong)]).manage.registerAgent("launch", agent.id, agent.displayName), /did not confirm/);
  }
});

const hook = (extra: Record<string, unknown> = {}) => ({
  channel: "launch",
  persona: "persona-1",
  url: "https://agent.example/wake",
  subscribe: "board",
  bearer: true,
  createdAt: "2026-11-22T10:00:00.000Z",
  createdBy: "tomas",
  pending: 2,
  lastDelivery: null,
  ...extra,
});

test("a board's webhooks are listed by persona, and never carry the bearer key", async () => {
  const { calls, manage } = fake([json({ webhooks: [hook(), hook({ persona: "persona-2", subscribe: "nonsense" })] })]);
  const hooks = await manage.webhooks("launch");
  assert.equal(calls[0]?.url, "https://msn.example/api/tenants/acme/channels/launch/webhooks");
  assert.deepEqual(hooks.get("persona-1"), {
    persona: "persona-1",
    url: "https://agent.example/wake",
    subscribe: "board",
    bearer: true,
    pending: 2,
    lastDelivery: null,
  });
  assert.equal(hooks.get("persona-2")?.subscribe, "addressed");
});

test("setting a webhook sends the address, the level and the key only when one is given", async () => {
  const { calls, manage } = fake([json({ webhook: hook({ subscribe: "workspace" }) }, 201), json({ webhook: hook() })]);
  const made = await manage.setWebhook("launch", "persona-1", {
    url: "https://agent.example/wake",
    subscribe: "workspace",
    bearer: "secret-key-1",
  });
  assert.equal(calls[0]?.url, "https://msn.example/api/tenants/acme/channels/launch/personas/persona-1/webhook");
  assert.equal(calls[0]?.init.method, "PUT");
  assert.deepEqual(sent(calls[0]), {
    url: "https://agent.example/wake",
    subscribe: "workspace",
    bearer: "secret-key-1",
  });
  assert.equal(made.subscribe, "workspace");
  // The key travels in the body, never in the address.
  assert.ok(!calls[0]?.url.includes("secret-key-1"));
  await manage.setWebhook("launch", "persona-1", { url: "https://agent.example/wake", subscribe: "board" });
  assert.deepEqual(sent(calls[1]), { url: "https://agent.example/wake", subscribe: "board" });
});

test("a webhook answer for another persona is refused", async () => {
  const { manage } = fake([json({ webhook: hook({ persona: "persona-9" }) })]);
  await assert.rejects(
    manage.setWebhook("launch", "persona-1", { url: "https://agent.example/wake", subscribe: "board" }),
    /invalid webhook/,
  );
});

test("reading, testing and removing one webhook use the persona's path", async () => {
  const path = "https://msn.example/api/tenants/acme/channels/launch/personas/persona-1/webhook";
  const { calls, manage } = fake([
    json({ webhook: hook({ lastDelivery: { status: "retrying", at: "2026-11-22T10:00:00Z", error: "http_503" } }) }),
    failure(404, "webhook_not_found"),
    json({ queued: true, noticeId: "n-1" }, 202),
    new Response(null, { status: 204 }),
  ]);
  const read = await manage.webhook("launch", "persona-1");
  assert.equal(read?.lastDelivery?.error, "http_503");
  assert.equal(await manage.webhook("launch", "persona-1"), null);
  await manage.testWebhook("launch", "persona-1");
  await manage.removeWebhook("launch", "persona-1");
  assert.deepEqual(
    calls.map((call) => [call.init.method, call.url]),
    [
      ["GET", path],
      ["GET", path],
      ["POST", `${path}/test`],
      ["DELETE", path],
    ],
  );
});

test("deleting a board repeats its name to confirm, and needs the server to say it is gone", async () => {
  const { calls, manage } = fake([json({ channel: "launch", deleted: true })]);
  await manage.deleteBoard("launch");
  assert.equal(calls[0]?.url, "https://msn.example/api/tenants/acme/channels/launch?confirm=launch");
  assert.equal(calls[0]?.init.method, "DELETE");
  await assert.rejects(fake([json({ channel: "other", deleted: true })]).manage.deleteBoard("launch"), /did not confirm/);
  await assert.rejects(fake([new Response(null, { status: 204 })]).manage.deleteBoard("launch"), /did not confirm/);
});

test("a redirect stops a management call before the key goes anywhere else", async () => {
  const redirect = new Response(null, { status: 302, headers: { location: "https://evil.example" } });
  const { calls, manage } = fake([redirect]);
  await assert.rejects(manage.deleteBoard("launch"), /redirect/);
  assert.equal(calls.length, 1);
});

test("failures are explained in plain words", () => {
  const api = (status: number, code: string, message = "server words") => new ApiError(status, code, message);
  assert.deepEqual(explain(api(401, "unauthorized"), "delete boards"), {
    message: "Your access key was revoked or reset.",
    expired: true,
  });
  assert.match(explain(api(403, "owner_required"), "delete boards").message, /owner/);
  assert.match(explain(api(403, "watch_only"), "invite people").message, /watch only/);
  assert.match(explain(api(409, "board_archived"), "set webhooks").message, /Unarchive/);
  // A server from before ADR 0080 has no delete route.
  assert.equal(
    explain(api(404, "route_not_found"), "delete boards").message,
    "This server cannot delete boards yet. It needs to be updated first.",
  );
  assert.equal(explain(api(409, "webhook_quota"), "set webhooks").message, "server words");
  assert.equal(explain(new Error("offline"), "delete boards").message, "offline");
  assert.equal(explain(null, "delete boards").message, "Could not delete boards.");
});

test("a webhook address must be a plain https address", () => {
  assert.equal(checkWebhookUrl(" https://agent.example/wake?x=1 "), null);
  assert.ok(checkWebhookUrl(""));
  assert.match(checkWebhookUrl("http://agent.example") ?? "", /https/);
  assert.match(checkWebhookUrl("agent.example/wake") ?? "", /complete address/);
  assert.ok(checkWebhookUrl("https://user:pass@agent.example"));
  assert.ok(checkWebhookUrl("https://agent.example/#part"));
  assert.ok(checkWebhookUrl(`https://agent.example/${"a".repeat(2048)}`));
});

test("a bearer key is optional, and otherwise 8 to 1024 visible characters", () => {
  assert.equal(checkBearer(""), null);
  assert.equal(checkBearer("  "), null);
  assert.equal(checkBearer("secret-key"), null);
  assert.ok(checkBearer("short"));
  assert.ok(checkBearer("has a space in it"));
  assert.ok(checkBearer("x".repeat(1025)));
});

test("a webhook is summarised in one line, as on the web", () => {
  const now = Date.parse("2026-11-22T10:10:00Z");
  const base: Webhook = {
    persona: "persona-1",
    url: "https://agent.example/wake",
    subscribe: "addressed",
    bearer: false,
    pending: 0,
    lastDelivery: null,
  };
  const last = (status: string, error: string | null = null) => ({
    ...base,
    lastDelivery: { status, at: "2026-11-22T10:07:00Z", httpStatus: null, error },
  });
  assert.equal(webhookSummary(null), "No webhook: its agent wakes only when it listens.");
  assert.equal(webhookSummary(base, now), "Wakes agent.example · nothing sent yet");
  assert.equal(
    webhookSummary({ ...base, subscribe: "workspace" }, now),
    "Wakes agent.example for every message on every board · nothing sent yet",
  );
  assert.equal(webhookSummary(last("delivered"), now), "Wakes agent.example · delivered 3 min ago");
  assert.equal(webhookSummary(last("retrying", "timeout"), now), "Wakes agent.example · retrying: no answer within 5 seconds");
  assert.equal(webhookSummary(last("failed", "http_410"), now), "Wakes agent.example · failed 3 min ago: it answered HTTP 410");
  assert.match(webhookSummary(last("dropped", "backlog_full"), now), /50 notices/);
  assert.match(subscribeNote("addressed"), /default/);
  assert.match(subscribeNote("workspace"), /share that notice/);
});

test("a board is deleted only when its name was typed", () => {
  assert.equal(confirmsDelete("old-notes", "old-notes"), true);
  // The keyboard adds a space or a capital; board names are lowercase only.
  assert.equal(confirmsDelete("  Old-notes ", "old-notes"), true);
  for (const typed of [undefined, "", " ", "old", "old-notes2", "old notes", "delete", "yes"])
    assert.equal(confirmsDelete(typed, "old-notes"), false, String(typed));
  assert.equal(confirmsDelete("", ""), false);
});
