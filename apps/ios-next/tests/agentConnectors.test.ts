import assert from "node:assert/strict";
import { test } from "node:test";
import { ApiError, ProtocolError } from "../../ios/src/core/errors.ts";
import { AgentConnectors } from "../src/lib/agentConnectors.ts";
import { ChannelAgentSetup } from "../src/lib/channelAgentSetup.ts";

const home = "local-team";
const origin = "https://msn.example";
const owner = "test-owner";
const endpoint = origin + "/mcp";
const board = "chat";
const a = { id: "10000000-0000-4000-8000-000000000001", name: "Atlas" };
const b = { ...a, id: "20000000-0000-4000-8000-000000000002" };
const install = {
  id: "30000000-0000-4000-8000-000000000003",
  label: "Office",
  kind: "bearer",
  createdAt: "2026-01-02T12:34:56.000Z",
};
const receipt = { id: install.id, token: `msni1.${home}.${"a".repeat(64)}` };
const membership = { tenant: home, channel: board, watchOnly: true };
const echo = { ...membership, ...a };
const dir = { agents: [a, b], endpoint };
const roster = { members: [{ ...b, channel: board, watchOnly: false }] };
const detail = (channels: unknown[], installs: unknown[] = [], user = a) => ({
  user,
  channels,
  installations: installs,
});
const nil = () => new Response(null, { status: 204 });
const json = (data: unknown, status = 200) => Response.json(data, { status });
const denied = (status: number, code: string) => json({ error: { code, message: "Refused." } }, status);

function fixture(...responses: (Response | Promise<Response>)[]) {
  const calls: { path: string; method: string; body?: unknown }[] = [];
  const api = new AgentConnectors({ origin, tenant: home, token: owner }, async (url, init) => {
    const prefix = origin + "/api/tenants/" + home;
    assert.ok(url.startsWith(prefix + "/"));
    assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer " + owner);
    assert.equal(init?.redirect, "manual");
    calls.push({
      path: url.slice(prefix.length),
      method: init?.method ?? "GET",
      ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
    });
    const next = responses.shift();
    if (!next) throw new Error("Unexpected request");
    return next;
  });
  let expired = 0;
  const epoch = new AbortController();
  const setup = new ChannelAgentSetup(api, board, epoch.signal, () => expired++);
  return { calls, api, setup, epoch, expired: () => expired };
}

test("owner creates, explicitly joins watch-only, gets a key once, and disconnects just that host", async () => {
  const { setup, calls } = fixture(
    json(dir),
    json(roster),
    json({ agent: a }, 201),
    json(detail([])),
    json(echo),
    json(detail([membership])),
    json(receipt, 201),
    json(detail([membership], [{ ...install, token: receipt.token }])),
    nil(),
    json(detail([membership])),
    nil(),
    json(detail([])),
  );
  await setup.users();
  assert.equal(setup.state.get().directory?.users.length, 2);
  await setup.create("  Atlas  ");
  assert.equal(setup.state.get().selected?.id, a.id);
  await setup.issue("Office");
  assert.equal(calls.length, 4); // no host key until this user joins the channel
  await setup.add(true);
  assert.equal(setup.member()?.watchOnly, true);
  await setup.issue(" Office ");
  assert.equal(setup.copyableKey(install.id), receipt.token);
  assert.equal(setup.copyableKey(b.id), null);
  await setup.refresh();
  assert.equal(setup.copyableKey(install.id), null);
  assert.deepEqual(setup.state.get().detail?.installations, [install]); // allow-list metadata, never cache a returned key
  await setup.disconnect(install.id);
  assert.equal(setup.member()?.watchOnly, true);
  await setup.remove(a.id);
  assert.equal(setup.member(), undefined);
  assert.deepEqual(
    calls.filter((c) => c.method !== "GET"),
    [
      { path: "/agents", method: "POST", body: { name: "Atlas" } },
      { path: `/channels/chat/members/${a.id}`, method: "PUT", body: { watchOnly: true } },
      { path: `/agents/${a.id}/installations`, method: "POST", body: { label: "Office" } },
      { path: `/agents/${a.id}/installations/${install.id}`, method: "DELETE" },
      { path: `/channels/chat/members/${a.id}`, method: "DELETE" },
    ],
  );
});

test("same names and foreign members do not confer authority to configure another user's host", async () => {
  const foreign = { ...a, id: "40000000-0000-4000-8000-000000000004", channel: board, watchOnly: false };
  const { setup, calls } = fixture(
    json(dir),
    json({ members: [foreign] }),
    json(detail([{ ...membership, tenant: "elsewhere" }], [], b)),
  );
  await setup.users();
  await setup.select(foreign.id);
  await setup.issue("Not mine");
  assert.equal(calls.length, 2);
  await setup.select(b.id);
  assert.equal(setup.state.get().selected?.id, b.id);
  await setup.issue("Not this channel");
  await setup.remove(a.id);
  assert.equal(calls.length, 3);
  assert.equal(calls[2]?.path, `/agents/${b.id}`);
});

test("wrong host, channel, user, watch mode and malformed installation keys fail closed", async () => {
  const s = new AbortController().signal;
  for (const address of ["https://other.example/mcp", endpoint + "?token=oops", endpoint + "#host"]) {
    await assert.rejects(
      fixture(json({ ...dir, endpoint: address }), json(roster)).api.directory(board, s),
      ProtocolError,
    );
  }
  await assert.rejects(
    fixture(json(dir), json({ members: [{ ...a, channel: "elsewhere", watchOnly: false }] })).api.directory(
      board,
      s,
    ),
    ProtocolError,
  );
  await assert.rejects(fixture(json(detail([], [], b))).api.detail(a.id, s), ProtocolError);
  await assert.rejects(
    fixture(json(detail([{ ...membership, watchOnly: "true" }]))).api.detail(a.id, s),
    ProtocolError,
  );
  for (const wrong of [
    { ...echo, id: b.id },
    { ...echo, tenant: "other" },
    { ...echo, channel: "other" },
    { ...echo, watchOnly: false },
  ]) {
    await assert.rejects(fixture(json(wrong)).api.add(board, a.id, true, s), ProtocolError);
  }
  for (const v of [
    { ...receipt, token: owner },
    { ...receipt, token: receipt.token.replace(home, "other") },
    { ...receipt, token: receipt.token + "!" },
    { ...receipt, id: "broken" },
  ]) {
    await assert.rejects(fixture(json(v)).api.issue(a.id, "Host", s), ProtocolError);
  }
  const f = fixture();
  await assert.rejects(f.api.directory("../admin", s));
  await assert.rejects(f.api.issue("../me", "Host", s));
  await assert.rejects(f.api.create("GITHUB", s));
  await assert.rejects(f.api.issue(a.id, "界".repeat(43), s));
  assert.equal(f.calls.length, 0);
});

test("an owner refusal is not a missing channel, and only a 401 expires the session", async () => {
  const noAccess = fixture(denied(403, "owner_required"), json(roster));
  await noAccess.setup.users();
  assert.match(noAccess.setup.state.get().error ?? "", /owner/);
  assert.equal(noAccess.expired(), 0);
  await noAccess.setup.create("Atlas");
  assert.equal(noAccess.calls.length, 2);
  const expired = fixture(json(dir), json(roster), json(detail([membership])), denied(401, "unauthorized"));
  await expired.setup.users();
  await expired.setup.select(a.id);
  await expired.setup.issue("Host");
  assert.equal(expired.expired(), 1);
  assert.equal(expired.setup.state.get().selected, null);
  await assert.rejects(
    fixture(denied(403, "owner_required")).api.issue(a.id, "Host", new AbortController().signal),
    ApiError,
  );
});

test("a lost POST response is never replayed; refresh GETs recover the created user or installation", async () => {
  const f = fixture(
    json(dir),
    json(roster),
    json({ oops: true }, 201),
    json(dir),
    json(roster),
    json(detail([membership])),
    json({}, 201),
    json(detail([membership], [install])),
  );
  await f.setup.users();
  await f.setup.create("Atlas");
  await f.setup.create("Atlas");
  assert.match(f.setup.state.get().error ?? "", /Check the agent list/);
  assert.equal(f.calls.filter((c) => c.method === "POST").length, 1);
  await f.setup.refresh();
  await f.setup.select(a.id);
  await f.setup.issue("Office");
  assert.match(f.setup.state.get().error ?? "", /disconnect it/);
  await f.setup.issue("Office");
  await f.setup.refresh();
  assert.deepEqual(f.setup.state.get().detail?.installations, [install]);
  assert.equal(f.setup.copyableKey(install.id), null);
  assert.equal(f.calls.filter((c) => c.method === "POST").length, 2);
});

test("double taps make one POST; neither leaving nor pausing lets a late response restore the secret", async () => {
  for (const close of ["navigate", "pause"]) {
    const pending = Promise.withResolvers<Response>();
    const f = fixture(json(dir), json(roster), json(detail([membership])), pending.promise);
    await f.setup.users();
    await f.setup.select(a.id);
    const first = f.setup.issue("Host");
    await f.setup.issue("Host");
    await f.setup.select(b.id);
    assert.equal(f.calls.filter((c) => c.method === "POST").length, 1);
    if (close === "pause") f.epoch.abort();
    else f.setup.close();
    pending.resolve(json(receipt, 201));
    await first;
    assert.equal(f.setup.state.get().issued, null);
    assert.equal(f.setup.copyableKey(install.id), null);
    assert.equal(f.setup.state.get().directory, null);
    await f.setup.users();
    assert.equal(f.calls.length, 4);
  }
});

test("leaving the receipt drops the key immediately, before the refresh finishes", async () => {
  const pending = Promise.withResolvers<Response>();
  const f = fixture(json(dir), json(roster), json(detail([membership])), json(receipt, 201), pending.promise);
  await f.setup.users();
  await f.setup.select(a.id);
  await f.setup.issue("Host");
  const refresh = f.setup.refresh();
  assert.equal(f.setup.copyableKey(install.id), null);
  pending.resolve(json(detail([membership], [install])));
  await refresh;
  assert.equal(f.setup.state.get().issued, null);
});
