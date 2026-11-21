import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

// Search every board at once (ADR 0073): GET /api/tenants/:t/search answers from every board the
// key can read, newest first. The key decides which boards; no parameter widens it.

type Message = {
  id: number;
  channel: string;
  text: string;
  username: string;
  labels?: Record<string, string>;
  reactions?: unknown;
  attachments?: { name: string }[];
};
type Result = { messages: Message[]; hasMore: boolean; nextBefore?: number; complete: boolean };

const call = (path: string, token?: string, init: { method?: string; json?: unknown; body?: string } = {}) =>
  exports.default.fetch(`https://msn.test${path}`, {
    method: init.method ?? "GET",
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      "Content-Type": init.body === undefined ? "application/json" : "application/octet-stream",
    },
    ...(init.json === undefined ? {} : { body: JSON.stringify(init.json) }),
    ...(init.body === undefined ? {} : { body: init.body }),
  });

/** An owner with shared boards `work` and `next` and a plain channel `general`. */
async function fixture() {
  const tenant = `all-${crypto.randomUUID()}`;
  const api = `/api/tenants/${tenant}`;
  const owner = (
    await (
      await call(api, undefined, { method: "PUT", json: { username: "human" } })
    ).json<{
      token: string;
    }>()
  ).token;
  const keys = { work: "b".repeat(64), next: "d".repeat(64) };
  for (const [channel, credential] of Object.entries(keys)) {
    expect(
      (
        await call(`${api}/channels/${channel}/board`, owner, {
          method: "PUT",
          json: { credential, goal: "Ship the release" },
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await call(`${api}/channels/${channel}/personas/lead`, credential, {
          method: "PUT",
          json: { displayName: "lead" },
        })
      ).status,
    ).toBe(201);
  }
  return { tenant, api, owner, keys };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function send(f: Fixture, channel: string, text: string, extra: Record<string, unknown> = {}) {
  const response = await call(`${f.api}/channels/${channel}/messages`, f.owner, {
    method: "POST",
    json: { username: "human", text, ...extra },
  });
  expect(response.status).toBe(201);
  return (await response.json<{ message: Message }>()).message;
}
async function found(f: Fixture, query: string, token = f.owner): Promise<Result> {
  const response = await call(`${f.api}/search?${query}`, token);
  expect(response.status).toBe(200);
  return response.json<Result>();
}
const where = (result: Result) => result.messages.map((message) => `${message.channel}:${message.id}`);

/** A key for one channel from an invitation; `readOnly` makes it watch-only (ADR 0041). */
async function invited(f: Fixture, channel: string, readOnly = false) {
  const created = await call(`${f.api}/invites`, f.owner, {
    method: "POST",
    json: { channel, ...(readOnly ? { watch: true } : {}) },
  });
  expect(created.status).toBe(201);
  const { code } = await created.json<{ code: string }>();
  const redeemed = await call(`${f.api}/invites/redeem`, undefined, {
    method: "POST",
    json: { code, username: `guest-${crypto.randomUUID().slice(0, 8)}` },
  });
  expect(redeemed.status).toBe(201);
  return (await redeemed.json<{ token: string }>()).token;
}

describe("search every board (ADR 0073)", () => {
  it("answers from every board, newest first, with each message's board", async () => {
    const f = await fixture();
    const a = await send(f, "work", "We decided to deploy on Friday.");
    const b = await send(f, "general", "Lunch is at noon.");
    const c = await send(f, "next", "Deployment plan for next week");
    const d = await send(f, "general", "deploy the docs too");
    const result = await found(f, "q=deploy");
    expect(where(result)).toEqual([`general:${d.id}`, `next:${c.id}`, `work:${a.id}`]);
    expect(result).toMatchObject({ hasMore: false, complete: true });
    expect(result.messages.every((message) => "tenant" in message)).toBe(true);
    // One board's search is unchanged.
    const one = await (await call(`${f.api}/channels/general/search?q=deploy`, f.owner)).json<Result>();
    expect(where(one)).toEqual([`general:${d.id}`]);
    expect(where(await found(f, "q=lunch"))).toEqual([`general:${b.id}`]);
  });

  it("narrows by sender, kind and label across boards, and searches without words", async () => {
    const f = await fixture();
    const a = await send(f, "work", "status one", { labels: { state: "open" } });
    await send(f, "general", "status two");
    const c = await send(f, "next", '{"status":3}', {
      contentType: "application/json",
      labels: { state: "open" },
    });
    const lead = await call(`${f.api}/channels/work/messages`, f.keys.work, {
      method: "POST",
      json: { username: "lead", text: "status from lead" },
    });
    const leadId = (await lead.json<{ message: Message }>()).message.id;
    expect(where(await found(f, "from=lead"))).toEqual([`work:${leadId}`]);
    expect(where(await found(f, "kind=json"))).toEqual([`next:${c.id}`]);
    const open = await found(f, "label=state%3Dopen");
    expect(where(open)).toEqual([`next:${c.id}`, `work:${a.id}`]);
    expect(open.messages.map((message) => message.labels)).toEqual([{ state: "open" }, { state: "open" }]);
    expect(where(await found(f, "q=status&label=state%3Dopen&kind=text"))).toEqual([`work:${a.id}`]);
  });

  it("returns each board's labels, reactions and attachments with its messages", async () => {
    const f = await fixture();
    const file = await (
      await call(`${f.api}/channels/work/attachments`, f.owner, { method: "POST", body: "build log" })
    ).json<{ attachment: { id: string } }>();
    const a = await send(f, "work", "release notes", {
      attachments: [{ id: file.attachment.id, name: "build.log" }],
      labels: { area: "ship" },
    });
    const b = await send(f, "next", "release plan", { labels: { area: "plan" } });
    expect(
      (
        await call(`${f.api}/channels/next/messages/${b.id}/reactions`, f.owner, {
          method: "POST",
          json: { username: "human", kind: "seen" },
        })
      ).status,
    ).toBeLessThan(300);
    const result = await found(f, "q=release");
    expect(where(result)).toEqual([`next:${b.id}`, `work:${a.id}`]);
    expect(result.messages[0].labels).toEqual({ area: "plan" });
    expect(result.messages[0].reactions).toBeDefined();
    expect(result.messages[0].attachments).toBeUndefined();
    expect(result.messages[1].labels).toEqual({ area: "ship" });
    expect(result.messages[1].attachments?.map((file) => file.name)).toEqual(["build.log"]);
    expect(result.messages[1].reactions).toBeUndefined();
  });

  it("pages to older matches across boards with before", async () => {
    const f = await fixture();
    const sent: Message[] = [];
    for (let index = 0; index < 5; index++)
      sent.push(await send(f, ["work", "next", "general"][index % 3], `page item ${index}`));
    const first = await found(f, "q=page&limit=2");
    expect(first.messages.map((message) => message.id)).toEqual([sent[4].id, sent[3].id]);
    expect(first).toMatchObject({ hasMore: true, nextBefore: sent[3].id });
    const second = await found(f, `q=page&limit=2&before=${first.nextBefore}`);
    expect(second.messages.map((message) => message.id)).toEqual([sent[2].id, sent[1].id]);
    const last = await found(f, `q=page&limit=2&before=${second.nextBefore}`);
    expect(last.messages.map((message) => message.id)).toEqual([sent[0].id]);
    expect(last.hasMore).toBe(false);
    expect(last.nextBefore).toBeUndefined();
  });

  it("keeps a board's shared key to its own board", async () => {
    const f = await fixture();
    const mine = await send(f, "work", "secret plan for work");
    await send(f, "next", "secret plan for next");
    await send(f, "general", "secret plan for general");
    for (const query of ["q=secret", "from=human", "kind=text", "q=secret&include=archived"]) {
      const result = await found(f, query, f.keys.work);
      expect(where(result)).toEqual([`work:${mine.id}`]);
      expect(JSON.stringify(result)).not.toMatch(/for next|for general/);
    }
    // Naming another board never widens the key: the parameter is refused, not obeyed.
    for (const query of ["q=secret&channel=next", "q=secret&board=next", "q=secret&all=true"])
      expect((await call(`${f.api}/search?${query}`, f.keys.work)).status).toBe(400);
    expect((await call(`${f.api}/channels/next/search?q=secret`, f.keys.work)).status).toBe(403);
  });

  it("keeps invited and watch-only keys to their own channel", async () => {
    const f = await fixture();
    await send(f, "work", "budget for work");
    const general = await send(f, "general", "budget for general");
    await send(f, "next", "budget for next");
    for (const token of [await invited(f, "general"), await invited(f, "general", true)]) {
      const result = await found(f, "q=budget", token);
      expect(where(result)).toEqual([`general:${general.id}`]);
      expect(JSON.stringify(await found(f, "q=budget&limit=100&include=archived", token))).not.toMatch(
        /for work|for next/,
      );
    }
  });

  it("leaves archived boards out unless asked, as the board list does", async () => {
    const f = await fixture();
    const old = await send(f, "work", "retro notes from the old board");
    const live = await send(f, "next", "retro notes from the live board");
    expect((await call(`${f.api}/channels/work/archive`, f.owner, { method: "PUT" })).status).toBe(200);
    expect(where(await found(f, "q=retro"))).toEqual([`next:${live.id}`]);
    expect(where(await found(f, "from=human"))).toEqual([`next:${live.id}`]);
    expect(where(await found(f, "q=retro&include=archived"))).toEqual([`next:${live.id}`, `work:${old.id}`]);
    // The archived board itself stays searchable (ADR 0046), also with its own shared key.
    const own = await (await call(`${f.api}/channels/work/search?q=retro`, f.owner)).json<Result>();
    expect(where(own)).toEqual([`work:${old.id}`]);
    expect(where(await found(f, "q=retro", f.keys.work))).toEqual([`work:${old.id}`]);
    expect(where(await found(f, "q=retro", f.keys.next))).toEqual([`next:${live.id}`]);
    expect((await call(`${f.api}/channels/work/archive`, f.owner, { method: "DELETE" })).status).toBe(200);
    expect(where(await found(f, "q=retro"))).toEqual([`next:${live.id}`, `work:${old.id}`]);
  });

  it("drops deleted messages and rejects bad input and bad keys", async () => {
    const f = await fixture();
    await send(f, "work", "hello there");
    for (const query of [
      "",
      "q=!!!",
      "kind=xml",
      "q=a&limit=0",
      "q=a&sort=old",
      "q=a&include=everything",
      "q=a&include=archived&include=archived",
      `q=${"a".repeat(257)}`,
    ])
      expect((await call(`${f.api}/search?${query}`, f.owner)).status).toBe(400);
    expect((await call(`${f.api}/search?q=hello`, "wrong-token")).status).toBe(401);
    expect((await call(`${f.api}/search?q=hello`)).status).toBe(401);
    expect((await call(`${f.api}/search?q=hello`, f.owner, { method: "POST", json: {} })).status).not.toBe(
      200,
    );
    // One board's search still refuses the every-board parameter.
    expect((await call(`${f.api}/channels/work/search?q=hello&include=archived`, f.owner)).status).toBe(400);
  });
});
