import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { summarize } from "../public/since.js";

// "Since you last looked" for agents (ADR 0061): GET …/channels/:c/since.
const call = (tenant: string, suffix = "", token?: string, method = "GET", input?: unknown) =>
  exports.default.fetch(`https://msn.test/api/tenants/${tenant}${suffix}`, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json" },
    ...(input ? { body: JSON.stringify(input) } : {}),
  });
type Connection = { tenant: string; token: string };
type Item = { id: number; kind: string; text: string; attention: boolean };
type Since = {
  channel: string;
  reader: string;
  name: string;
  from: { source: string; after: number };
  head: number;
  lastId: number;
  headline: string;
  count: number;
  truncated: boolean;
  authors: string[];
  firstId: number | null;
  items: Item[];
  hidden: number;
  labels: {
    messages: { id: number; username: string; changes: number; labels: Record<string, string> }[];
    hidden: number;
    changes: number;
    truncated: boolean;
  };
};

async function fixture() {
  const tenant = `since-${crypto.randomUUID()}`;
  const owner = await (await call(tenant, "", undefined, "PUT", { username: "human" })).json<Connection>();
  const board = "c".repeat(64);
  expect(
    (await call(tenant, "/channels/work/board", owner.token, "PUT", { credential: board, goal: "Ship it" }))
      .status,
  ).toBe(201);
  for (const name of ["lead", "worker", "human"])
    await call(tenant, `/channels/work/personas/${name}`, board, "PUT", { displayName: name });
  const send = async (input: Record<string, unknown>) => {
    const response = await call(tenant, "/channels/work/messages", board, "POST", input);
    expect(response.status).toBe(201);
    return (await response.json<{ message: { id: number } }>()).message.id;
  };
  return { tenant, token: board, owner: owner.token, send };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const task = (fields: Record<string, unknown>) => ({
  username: "lead",
  contentType: "application/json",
  text: JSON.stringify({ schema: "msn.task.v1", ...fields }),
});
const since = async (f: Fixture, query: string) => {
  const response = await call(f.tenant, `/channels/work/since?${query}`, f.token);
  expect(response.status).toBe(200);
  return response.json<Since>();
};

describe("since you last looked for agents (ADR 0061)", () => {
  it("lists task changes and messages to the reader with the web panel's rules", async () => {
    const f = await fixture();
    await f.send({ username: "human", text: "before" });
    await f.send(task({ action: "open", task: "t1", title: "Ship the parser" }));
    await f.send(task({ action: "claim", task: "t1" }));
    await f.send(task({ action: "block", task: "t1", reason: "needs a key" }));
    await f.send({ username: "human", text: "Can you review?", to: "Worker" });
    await f.send({ username: "worker", text: "my own note" });
    await f.send(task({ action: "close", task: "t1" }));
    const result = await since(f, "reader=worker&after=1");
    expect(result).toMatchObject({
      channel: "work",
      reader: "worker",
      from: { source: "after", after: 1 },
      head: 7,
      lastId: 7,
      count: 5,
      truncated: false,
      authors: ["lead", "human"],
      firstId: 2,
      hidden: 0,
    });
    expect(result.headline).toBe("Since you last looked: 5 new messages from lead and human");
    // Attention first (the block and the question to the reader), then board order.
    expect(result.items.map((item) => [item.id, item.text, item.attention])).toEqual([
      [4, "lead blocked Ship the parser: needs a key", true],
      [5, "human to you: “Can you review?”", true],
      [2, "lead opened Ship the parser", false],
      [3, "lead claimed Ship the parser", false],
      [7, "lead closed Ship the parser", false],
    ]);
  });

  it("agrees with the web module on the same range", async () => {
    const f = await fixture();
    await f.send(task({ action: "open", task: "t1", title: "One" }));
    await f.send(task({ action: "assign", task: "t1", owner: "worker" }));
    await f.send({ username: "human", text: "hello" });
    const page = await (await call(f.tenant, "/channels/work/messages?after=0&limit=100", f.token)).json<{
      messages: { id: number; username: string; text: string; contentType: string }[];
    }>();
    const web = summarize(page.messages, { after: 0, me: "worker" });
    const agent = await since(f, "reader=worker");
    expect(agent.from).toEqual({ source: "start", after: 0 });
    expect({ ...agent, items: agent.items }).toMatchObject({
      count: web.count,
      authors: web.authors,
      firstId: web.firstId,
      items: web.items,
      hidden: web.hidden,
    });
  });

  it("starts at the server processing commit before any after, and never moves it", async () => {
    const f = await fixture();
    for (let i = 1; i <= 4; i++) await f.send({ username: "human", text: `m${i}` });
    const base = "/channels/work/processing/worker";
    const claimed = await call(f.tenant, `${base}/claim`, f.token, "POST", { expectGeneration: 0 });
    const { generation } = await claimed.json<{ generation: number }>();
    await call(f.tenant, `${base}/commit`, f.token, "POST", { generation, through: 3 });
    const result = await since(f, "reader=worker&after=1");
    expect(result.from).toEqual({ source: "processing", after: 3 });
    expect(result.count).toBe(1);
    const cursor = await (await call(f.tenant, base, f.token)).json<{ committedThrough: number }>();
    expect(cursor.committedThrough).toBe(3);
    // A persona's id reads as its display name in the rows.
    const asId = await since(f, "reader=worker/w1");
    expect(asId).toMatchObject({ reader: "worker/w1", name: "worker" });
    // Another reader with no commit starts where it says.
    expect((await since(f, "reader=lead&after=2")).from).toEqual({ source: "after", after: 2 });
  });

  it("reports messages whose labels changed after the starting point, with their labels now", async () => {
    const f = await fixture();
    const old = await f.send({ username: "human", text: "old work" });
    await call(f.tenant, `/channels/work/messages/${old}/labels`, f.token, "POST", {
      set: { state: "open" },
    });
    const mark = await f.send({ username: "human", text: "mark" });
    for (const set of [{ state: "done" }, { owner: "lead" }])
      await call(f.tenant, `/channels/work/messages/${old}/labels`, f.token, "POST", { set });
    const fresh = await f.send({ username: "lead", text: "new", labels: { kind: "note" } });
    await call(f.tenant, `/channels/work/messages/${fresh}/labels`, f.token, "POST", {
      set: { kind: "plan" },
    });
    const result = await since(f, `reader=worker&after=${mark}`);
    expect(result.labels).toEqual({
      messages: [
        { id: old, username: "human", changes: 2, labels: { owner: "lead", state: "done" } },
        { id: fresh, username: "lead", changes: 1, labels: { kind: "plan" } },
      ],
      hidden: 0,
      changes: 3,
      truncated: false,
    });
    // From the start, the first label change counts too.
    expect((await since(f, "reader=worker")).labels.changes).toBe(4);
  });

  it("is bounded to 300 messages and says so", async () => {
    const f = await fixture();
    for (let i = 0; i < 302; i++) await f.send({ username: "human", text: `m${i}` });
    const result = await since(f, "reader=worker");
    expect(result).toMatchObject({ count: 300, truncated: true, head: 302, lastId: 300 });
    expect(result.headline).toBe("Since you last looked: 300+ new messages from human");
  });

  it("uses a bound key's name, and refuses a missing reader or an after beyond the head", async () => {
    const f = await fixture();
    await f.send({ username: "human", text: "hi" });
    const missing = await call(f.tenant, "/channels/work/since", f.token);
    expect(missing.status).toBe(400);
    expect((await missing.json<{ error: { code: string } }>()).error.code).toBe("invalid_reader");
    const beyond = await call(f.tenant, "/channels/work/since?reader=w&after=9", f.token);
    expect(beyond.status).toBe(400);
    // The owner's key is bound to its name.
    const bound = await call(f.tenant, "/channels/work/since", f.owner);
    expect(bound.status).toBe(200);
    expect((await bound.json<Since>()).reader).toBe("human");
  });
});
