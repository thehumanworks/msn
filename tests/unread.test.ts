import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { UNREAD_BOARDS, UNREAD_CAP } from "../src/store";

// Unread counts (ADR 0045): the reader sends its own read marks; the server counts messages above
// each one, bounded per board, and keeps no read state.
const ADMIN = "test-admin-secret-000000000000000000000";
const call = (path: string, token?: string, method = "GET", input?: unknown) =>
  exports.default.fetch(`https://msn.test${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(input !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(input !== undefined ? { body: JSON.stringify(input) } : {}),
  });
type Unread = { channel: string; after: number; count: number; toYou: number; capped?: true };

async function workspace() {
  const name = `unread-${crypto.randomUUID()}`;
  const created = await call(`/api/admin/tenants/${name}`, ADMIN, "PUT");
  expect(created.status).toBe(201);
  const { token } = await created.json<{ token: string }>();
  const api = `/api/tenants/${name}`;
  const send = async (channel: string, username: string, text: string, to?: string) => {
    const response = await call(`${api}/channels/${channel}/messages`, token, "POST", {
      username,
      text,
      ...(to ? { to } : {}),
    });
    expect(response.status).toBe(201);
    return (await response.json<{ message: { id: number } }>()).message.id;
  };
  const unread = (query: string, key = token) => call(`${api}/unread?${query}`, key);
  return { name, api, token, send, unread };
}

describe("GET /unread", () => {
  it("counts others' messages above each mark and those addressed to the reader", async () => {
    const w = await workspace();
    const mark = await w.send("work", "Tomas", "starting");
    await w.send("work", "lead", "plan posted");
    await w.send("work", "lead", "can you check this?", "  tomas ");
    await w.send("work", "Tomas", "my own reply is not news");
    await w.send("work", "worker", "for the lead", "lead");
    const quiet = await w.send("ops", "lead", "old news");
    const response = await w.unread(`me=Tomas&mark=work:${mark}&mark=ops:${quiet}&mark=empty:0`);
    expect(response.status).toBe(200);
    const body = await response.json<{ unread: Unread[]; cap: number }>();
    expect(body.cap).toBe(UNREAD_CAP);
    expect(body.unread).toEqual([
      { channel: "work", after: mark, count: 3, toYou: 1 },
      { channel: "ops", after: quiet, count: 0, toYou: 0 },
      { channel: "empty", after: 0, count: 0, toYou: 0 },
    ]);
  });

  it("stops counting at the cap and says so", async () => {
    const w = await workspace();
    for (let index = 0; index <= UNREAD_CAP; index += 1) await w.send("busy", "lead", `m${index}`);
    const body = await (await w.unread("me=Tomas&mark=busy:0")).json<{ unread: Unread[] }>();
    expect(body.unread[0]).toEqual({ channel: "busy", after: 0, count: UNREAD_CAP, toYou: 0, capped: true });
  });

  it("rejects malformed, duplicate, missing or too many marks", async () => {
    const w = await workspace();
    for (const query of [
      "me=a",
      "mark=work",
      "mark=work:",
      "mark=work:-1",
      "mark=work:1.5",
      "mark=Work:1",
      "mark=:1",
      "mark=work:1&mark=work:2",
      "mark=work:12345678901234567",
      `me=${"x".repeat(129)}&mark=work:1`,
      Array.from({ length: UNREAD_BOARDS + 1 }, (_, i) => `mark=b${i}:0`).join("&"),
    ]) {
      const response = await w.unread(query);
      expect(response.status, query).toBe(400);
    }
    expect((await call(`${w.api}/unread?mark=work:0`)).status).toBe(401);
  });

  it("works for a watch-only key on its own board and refuses other boards", async () => {
    const w = await workspace();
    const first = await w.send("work", "lead", "hello");
    await w.send("work", "lead", "for you", "watcher");
    const invite = await call(`${w.api}/invites`, w.token, "POST", { channel: "work", watch: true });
    expect(invite.status).toBe(201);
    const { code } = await invite.json<{ code: string }>();
    const redeemed = await call(`${w.api}/invites/redeem`, undefined, "POST", { code, username: "watcher" });
    expect(redeemed.status).toBe(201);
    const watcher = (await redeemed.json<{ token: string }>()).token;
    const own = await w.unread(`me=watcher&mark=work:${first}`, watcher);
    expect(own.status).toBe(200);
    expect((await own.json<{ unread: Unread[] }>()).unread).toEqual([
      { channel: "work", after: first, count: 1, toYou: 1 },
    ]);
    expect((await w.unread("me=watcher&mark=other:0", watcher)).status).toBe(403);
    // One board outside the key's scope refuses the whole request.
    expect((await w.unread("me=watcher&mark=work:0&mark=other:0", watcher)).status).toBe(403);
  });

  it("leaves deleted messages out", async () => {
    const w = await workspace();
    await w.send("work", "lead", "kept");
    const gone = await w.send("work", "lead", "removed", "Tomas");
    expect(
      (await call(`/api/admin/tenants/${w.name}/channels/work/messages/${gone}`, ADMIN, "DELETE")).status,
    ).toBe(204);
    const body = await (await w.unread("me=Tomas&mark=work:0")).json<{ unread: Unread[] }>();
    expect(body.unread[0]).toMatchObject({ count: 1, toYou: 0 });
  });
});
