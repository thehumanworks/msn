import { runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

const ADMIN = "test-admin-secret-000000000000000000000";

type Message = { id: number; text: string; replyTo?: number; labels?: Record<string, string> };
type Page = {
  messages: Message[];
  nextCursor: number;
  hasMore: boolean;
  thread?: number;
  edited?: Message[];
  editCursor?: number;
};

const call = (path: string, token?: string, init: RequestInit = {}) =>
  exports.default.fetch(`https://msn.test${path}`, {
    ...init,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...init.headers },
  });
const post = (data: unknown): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(data),
});

async function tenant() {
  const name = `thr-${crypto.randomUUID()}`;
  const response = await call(`/api/admin/tenants/${name}`, ADMIN, { method: "PUT" });
  expect(response.status).toBe(201);
  const { token } = await response.json<{ token: string }>();
  return {
    name,
    token,
    channel: `/api/tenants/${name}/channels/general`,
    admin: `/api/admin/tenants/${name}/channels/general`,
    stub: env.MSN_DURABLE_OBJECT.getByName(JSON.stringify(["tenant", name])),
  };
}
type Tenant = Awaited<ReturnType<typeof tenant>>;

async function sent(t: Tenant, text: string, extra: Record<string, unknown> = {}): Promise<Message> {
  const response = await call(`${t.channel}/messages`, t.token, post({ username: "agent", text, ...extra }));
  expect(response.status).toBe(201);
  return (await response.json<{ message: Message }>()).message;
}
async function list(t: Tenant, query: string): Promise<Page> {
  const response = await call(`${t.channel}/messages${query}`, t.token);
  expect(response.status).toBe(200);
  return response.json<Page>();
}
const ids = (page: Page) => page.messages.map((m) => m.id);

/** root ← a ← nested, root ← b, plus an unrelated message and a second thread. */
async function board(t: Tenant) {
  const root = await sent(t, "Plan the release");
  const other = await sent(t, "Unrelated chatter");
  const a = await sent(t, "Tests pass", { replyTo: root.id });
  const otherRoot = await sent(t, "Another topic");
  const nested = await sent(t, "Which suite?", { replyTo: a.id });
  const otherReply = await sent(t, "On the other topic", { replyTo: otherRoot.id });
  const b = await sent(t, "Tag it", { replyTo: root.id });
  return { root, other, a, otherRoot, nested, otherReply, b };
}

describe("follow one thread (ADR 0063)", () => {
  it("returns the root and every reply at any depth, in id order, and names the root", async () => {
    const t = await tenant();
    const m = await board(t);
    const page = await list(t, `?thread=${m.root.id}&after=0`);
    expect(ids(page)).toEqual([m.root.id, m.a.id, m.nested.id, m.b.id]);
    expect(page.thread).toBe(m.root.id);
    expect(page.nextCursor).toBe(m.b.id);
    expect(page.hasMore).toBe(false);
    // An unscoped page keeps its old shape: no thread key.
    expect("thread" in (await list(t, "?after=0"))).toBe(false);
  });

  it("follows the thread a reply belongs to when given a reply id", async () => {
    const t = await tenant();
    const m = await board(t);
    const page = await list(t, `?thread=${m.nested.id}`);
    expect(page.thread).toBe(m.root.id);
    expect(ids(page)).toEqual([m.root.id, m.a.id, m.nested.id, m.b.id]);
  });

  it("pages with after and limit, and combines with label filters", async () => {
    const t = await tenant();
    const m = await board(t);
    const first = await list(t, `?thread=${m.root.id}&limit=2`);
    expect(ids(first)).toEqual([m.root.id, m.a.id]);
    expect(first.hasMore).toBe(true);
    const second = await list(t, `?thread=${m.root.id}&after=${first.nextCursor}&limit=2`);
    expect(ids(second)).toEqual([m.nested.id, m.b.id]);
    expect(second.hasMore).toBe(false);
    await sent(t, "Open item in thread", { replyTo: m.b.id, labels: { state: "open" } });
    await sent(t, "Open item elsewhere", { labels: { state: "open" } });
    const labelled = await list(t, `?thread=${m.root.id}&label=state=open`);
    expect(labelled.messages.map((x) => x.text)).toEqual(["Open item in thread"]);
  });

  it("waits only for new replies in the thread", async () => {
    const t = await tenant();
    const m = await board(t);
    const waiting = call(`${t.channel}/messages?thread=${m.root.id}&after=${m.b.id}&wait=10`, t.token);
    await new Promise((resolve) => setTimeout(resolve, 100));
    await sent(t, "Board noise");
    await sent(t, "Reply in another thread", { replyTo: m.otherRoot.id });
    const reply = await sent(t, "Deep reply", { replyTo: m.nested.id });
    const page = await (await waiting).json<Page>();
    expect(ids(page)).toEqual([reply.id]);
    expect(page.thread).toBe(m.root.id);
  });

  it("returns an empty page when the wait ends with no reply in the thread", async () => {
    const t = await tenant();
    const m = await board(t);
    const waiting = call(`${t.channel}/messages?thread=${m.root.id}&after=${m.b.id}&wait=1`, t.token);
    await sent(t, "Board noise");
    const page = await (await waiting).json<Page>();
    expect(page.messages).toEqual([]);
    expect(page.nextCursor).toBe(m.b.id);
  });

  it("keeps a deleted message's replies in the thread and leaves the deleted one out", async () => {
    const t = await tenant();
    const m = await board(t);
    expect((await call(`${t.admin}/messages/${m.a.id}`, ADMIN, { method: "DELETE" })).status).toBe(204);
    expect(ids(await list(t, `?thread=${m.root.id}`))).toEqual([m.root.id, m.nested.id, m.b.id]);
    // A deleted id still names its thread.
    expect((await list(t, `?thread=${m.a.id}`)).thread).toBe(m.root.id);
  });

  it("reports edits only for messages in the thread", async () => {
    const t = await tenant();
    const m = await board(t);
    const start = await list(t, `?thread=${m.root.id}&editsAfter=latest`);
    const patch = (id: number, text: string) =>
      call(`${t.channel}/messages/${id}`, t.token, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "agent", text }),
      });
    expect((await patch(m.other.id, "Unrelated, edited")).status).toBe(200);
    expect((await patch(m.a.id, "Tests pass on CI too")).status).toBe(200);
    const page = await list(t, `?thread=${m.root.id}&after=${m.b.id}&editsAfter=${start.editCursor}`);
    expect(page.edited?.map((x) => x.text)).toEqual(["Tests pass on CI too"]);
  });

  it("rejects bad thread ids, unknown messages and thread with processingReader", async () => {
    const t = await tenant();
    const m = await board(t);
    for (const bad of ["0", "-1", "abc", "01"]) {
      const response = await call(`${t.channel}/messages?thread=${bad}`, t.token);
      expect(response.status).toBe(400);
    }
    const missing = await call(`${t.channel}/messages?thread=${m.b.id + 100}`, t.token);
    expect(missing.status).toBe(404);
    expect((await missing.json<{ error: { code: string } }>()).error.code).toBe("message_not_found");
    // A message on another board is not in this board's threads.
    await call(`/api/tenants/${t.name}/channels`, t.token, post({ channel: "elsewhere" }));
    const elsewhere = await call(
      `/api/tenants/${t.name}/channels/elsewhere/messages?thread=${m.root.id}`,
      t.token,
    );
    expect(elsewhere.status).toBe(404);
    const fenced = await call(
      `${t.channel}/messages?thread=${m.root.id}&processingReader=agent&generation=1`,
      t.token,
    );
    expect(fenced.status).toBe(400);
  });

  it("serves thread reads from the reply index", async () => {
    const t = await tenant();
    await board(t);
    const plan = await runInDurableObject(t.stub, (_, state) =>
      state.storage.sql
        .exec<{ detail: string }>(
          "EXPLAIN QUERY PLAN SELECT id FROM messages WHERE channel = 'general' AND replyTo = 1",
        )
        .toArray()
        .map((row) => row.detail)
        .join("\n"),
    );
    expect(plan).toContain("message_replies");
  });
});
