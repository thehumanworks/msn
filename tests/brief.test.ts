import { runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

// Board brief (ADR 0074): the owner writes standing instructions for a board, up to 4 KiB of
// Markdown. Every first catch-up page leads with it and says whether this reader has had this
// version before. Old versions are kept.

const call = (tenant: string, suffix = "", token?: string, method = "GET", input?: unknown) =>
  exports.default.fetch(`https://msn.test/api/tenants/${tenant}${suffix}`, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json" },
    ...(input ? { body: JSON.stringify(input) } : {}),
  });

type Brief = {
  version: number;
  text?: string;
  bytes: number;
  updatedAt: string;
  updatedBy?: string;
  omitted?: boolean;
};
type BriefResult = { brief: Brief | null; changed?: boolean; currentVersion: number };
type Message = { id: number; username: string; text: string; contentType?: string };
type Catchup = {
  brief?: Brief;
  briefChanged?: boolean;
  pinned?: Message[];
  messages: Message[];
  nextCursor: number;
  byteLimitReached: boolean;
};

/** An owner account with a board `work`, its shared agent credential and persona `lead`. */
async function fixture() {
  const tenant = `brief-${crypto.randomUUID()}`;
  const owner = (await (await call(tenant, "", undefined, "PUT", { username: "human" })).json()) as {
    token: string;
  };
  const agent = "b".repeat(64);
  expect(
    (await call(tenant, "/channels/work/board", owner.token, "PUT", { credential: agent, goal: "Ship" }))
      .status,
  ).toBe(201);
  expect(
    (await call(tenant, "/channels/work/personas/lead", agent, "PUT", { displayName: "lead" })).status,
  ).toBe(201);
  return { tenant, owner: owner.token, agent };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

const put = (f: Fixture, text: unknown, baseVersion: unknown, token = f.owner) =>
  call(f.tenant, "/channels/work/brief", token, "PUT", { text, baseVersion });
const get = async (f: Fixture, token = f.agent, query = "") =>
  (await (await call(f.tenant, `/channels/work/brief${query}`, token)).json()) as BriefResult;
const catchup = async (f: Fixture, query = "", token = f.agent) =>
  (await (await call(f.tenant, `/channels/work/catchup?limit=10${query}`, token)).json()) as Catchup;
const send = async (f: Fixture, text: string) => {
  const response = await call(f.tenant, "/channels/work/messages", f.agent, "POST", {
    username: "lead",
    text,
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as { message: Message }).message;
};

describe("board brief (ADR 0074)", () => {
  it("lets only the owner write the brief, and every reader read it", async () => {
    const f = await fixture();
    expect(await get(f)).toMatchObject({ brief: null, currentVersion: 0 });
    const refused = await put(f, "Agents write this.", 0, f.agent);
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe("owner_required");

    const first = await put(f, "# Rules\n\nUse **small** pull requests.", 0);
    expect(first.status).toBe(201);
    const made = (await first.json()) as BriefResult;
    expect(made).toMatchObject({
      changed: true,
      currentVersion: 1,
      brief: { version: 1, text: "# Rules\n\nUse **small** pull requests.", bytes: 37, updatedBy: "human" },
    });
    expect(Date.parse(made.brief?.updatedAt ?? "")).toBeGreaterThan(Date.now() - 60_000);
    expect(await get(f)).toMatchObject({ brief: { version: 1, updatedBy: "human" }, currentVersion: 1 });
    expect(await get(f, f.owner)).toMatchObject({ brief: { version: 1 } });
    expect((await call(f.tenant, "/channels/work/brief", "z".repeat(64))).status).toBe(401);
    expect((await call(f.tenant, "/channels/other/brief", f.agent)).status).toBe(403);
    expect((await call(f.tenant, "/channels/missing/brief", f.owner)).status).toBe(404);
  });

  it("keeps old versions, refuses a stale write and ignores an unchanged one", async () => {
    const f = await fixture();
    await put(f, "one", 0);
    const stale = await put(f, "two", 0);
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({
      error: { code: "brief_conflict", details: { currentVersion: 1 } },
    });
    const same = await put(f, "one", 1);
    expect(same.status).toBe(200);
    expect(await same.json()).toMatchObject({ changed: false, currentVersion: 1, brief: { version: 1 } });
    expect((await put(f, "two", 1)).status).toBe(201);

    const versions = (await (await call(f.tenant, "/channels/work/brief/versions", f.agent)).json()) as {
      versions: Brief[];
    };
    expect(versions.versions.map((v) => [v.version, v.bytes, v.updatedBy])).toEqual([
      [2, 3, "human"],
      [1, 3, "human"],
    ]);
    expect(versions.versions.some((v) => "text" in v)).toBe(false);
    expect(await get(f, f.agent, "?version=1")).toMatchObject({
      brief: { version: 1, text: "one" },
      currentVersion: 2,
    });
    const missing = await call(f.tenant, "/channels/work/brief?version=9", f.agent);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ error: { code: "brief_version_not_found" } });
  });

  it("validates the text and base version", async () => {
    const f = await fixture();
    for (const [text, base] of [
      [7, 0],
      [undefined, 0],
      ["x".repeat(4097), 0],
      ["é".repeat(2049), 0],
      ["ok", "0"],
      ["ok", -1],
      ["ok", 1.5],
      ["ok", undefined],
    ]) {
      const response = await put(f, text, base);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: "invalid_brief" } });
    }
    expect((await put(f, "é".repeat(2048), 0)).status).toBe(201);
    expect(await get(f)).toMatchObject({ brief: { version: 1, bytes: 4096 } });
  });

  it("clears the brief with blank text and keeps what it was", async () => {
    const f = await fixture();
    // Clearing a brief that never existed changes nothing.
    const nothing = await put(f, "  \n", 0);
    expect(nothing.status).toBe(200);
    expect(await nothing.json()).toMatchObject({ changed: false, brief: null, currentVersion: 0 });
    await put(f, "Be kind.", 0);
    const cleared = await put(f, " ", 1);
    expect(cleared.status).toBe(201);
    expect(await cleared.json()).toMatchObject({ changed: true, brief: null, currentVersion: 2 });
    expect(await get(f)).toMatchObject({ brief: null, currentVersion: 2 });
    expect(await get(f, f.agent, "?version=1")).toMatchObject({ brief: { text: "Be kind." } });
    expect("brief" in (await catchup(f, "&reader=lead"))).toBe(false);
    // Writing again after a clear is a new version, and new to every reader.
    await put(f, "Be kind again.", 2);
    expect(await catchup(f, "&reader=lead")).toMatchObject({ brief: { version: 3 }, briefChanged: true });
  });

  it("leads the first catch-up page with the brief and tells each reader when it is new to them", async () => {
    const f = await fixture();
    const before = await catchup(f, "&reader=lead");
    expect("brief" in before).toBe(false);
    expect("briefChanged" in before).toBe(false);

    await put(f, "Run the tests before you post.", 0);
    const raw = await (await call(f.tenant, "/channels/work/catchup?reader=lead", f.agent)).text();
    // The brief is the first field of the page, before pins, snapshot and messages.
    expect(raw.startsWith('{"brief":{"version":1,')).toBe(true);
    expect(JSON.parse(raw)).toMatchObject({
      brief: { version: 1, text: "Run the tests before you post.", updatedBy: "human" },
      briefChanged: true,
    });
    expect(await catchup(f, "&reader=lead")).toMatchObject({ brief: { version: 1 }, briefChanged: false });
    // Another reader has not had it yet; a page without a reader says nothing and records nothing.
    const anonymous = await catchup(f);
    expect(anonymous.brief?.text).toBe("Run the tests before you post.");
    expect("briefChanged" in anonymous).toBe(false);
    expect(await catchup(f, `&reader=${encodeURIComponent("dev/worker 1")}`)).toMatchObject({
      briefChanged: true,
    });
    expect(await catchup(f, `&reader=${encodeURIComponent("dev/worker 1")}`)).toMatchObject({
      briefChanged: false,
    });

    await put(f, "Run the tests and the linter before you post.", 1);
    expect(await catchup(f, "&reader=lead")).toMatchObject({ brief: { version: 2 }, briefChanged: true });
    expect(await catchup(f, "&reader=lead")).toMatchObject({ briefChanged: false });
    // A continuation page already had the brief.
    const next = await catchup(f, "&after=0&reader=lead");
    expect("brief" in next).toBe(false);
    expect("briefChanged" in next).toBe(false);
    const bad = await call(f.tenant, "/channels/work/catchup?reader=", f.agent);
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: { code: "invalid_reader" } });
  });

  it("posts a board message without the text on each change, so waiting agents wake", async () => {
    const f = await fixture();
    await put(f, "First brief.", 0);
    await put(f, "First brief.", 1);
    await put(f, "", 1);
    const page = await catchup(f, "&after=0");
    const control = page.messages.filter((m) => m.username === "board");
    expect(control.map((m) => JSON.parse(m.text))).toEqual([
      { schema: "msn.brief.v1", version: 1, cleared: false, bytes: 12, updatedBy: "human" },
      { schema: "msn.brief.v1", version: 2, cleared: true, bytes: 0, updatedBy: "human" },
    ]);
    expect(control.every((m) => m.contentType === "application/json")).toBe(true);
  });

  it("drops the brief text only after the pins when the page is too small, and does not mark it seen", async () => {
    const f = await fixture();
    await put(f, "b".repeat(4000), 0);
    const first = await send(f, "m".repeat(300));
    expect((await call(f.tenant, `/channels/work/pins/${first.id}`, f.owner, "PUT")).status).toBe(201);
    const full = await catchup(f, "&after=0");
    const tail = full.messages.length;

    const roomy = await catchup(f, "&maxBytes=32768&reader=tight");
    expect(roomy).toMatchObject({ brief: { text: "b".repeat(4000) }, briefChanged: true });
    await put(f, "c".repeat(4000), 1);
    // Fits the brief and one message, not the pin and the whole tail.
    const whole = await catchup(f, "&maxBytes=32768&reader=other");
    const fits = JSON.stringify({ ...whole, messages: whole.messages.slice(0, 1), pinned: [] }).length + 100;
    const pinless = await catchup(f, `&maxBytes=${fits}&reader=tight`);
    expect(pinless.messages).toHaveLength(1);
    expect(pinless.brief?.text).toBe("c".repeat(4000));
    expect(pinless.pinned).toEqual([]);
    expect(pinless.byteLimitReached).toBe(true);
    await put(f, "d".repeat(4000), 2);
    const small = await call(f.tenant, "/channels/work/catchup?limit=10&maxBytes=3000&reader=tight", f.agent);
    expect(small.status).toBe(200);
    const body = await small.text();
    expect(body.length).toBeLessThanOrEqual(3000);
    const shed = JSON.parse(body) as Catchup;
    expect(shed.brief).toMatchObject({ version: 3, bytes: 4000, omitted: true });
    expect(shed.brief && "text" in shed.brief).toBe(false);
    expect(shed).toMatchObject({ briefChanged: true, byteLimitReached: true });
    expect(shed.messages.length).toBeGreaterThan(0);
    expect(shed.messages.length).toBeLessThanOrEqual(tail);
    // The text never reached this reader, so the next page still says it is new.
    expect(await catchup(f, "&reader=tight")).toMatchObject({
      brief: { text: "d".repeat(4000) },
      briefChanged: true,
    });
    // Too small even for the first message: the required size leaves the brief text out.
    const tiny = await call(f.tenant, "/channels/work/catchup?limit=10&maxBytes=1024&reader=tight", f.agent);
    if (tiny.status === 413) {
      const error = (await tiny.json()) as { error: { requiredBytes: number } };
      expect(error.error.requiredBytes).toBeLessThan(4000);
    }
  });

  it("lets a key mark the brief as received only for its own names", async () => {
    const f = await fixture();
    await put(f, "Read me.", 0);
    const invite = (await (
      await call(f.tenant, "/invites", f.owner, "POST", { channel: "work", watch: true })
    ).json()) as { code: string };
    const watcher = (await (
      await call(f.tenant, "/invites/redeem", undefined, "POST", { code: invite.code, username: "watcher" })
    ).json()) as { token: string };

    // A watch-only key bound to "watcher" and the owner's key bound to "human" both name "lead":
    // each gets the brief, with no briefChanged, and nothing is recorded for lead.
    for (const token of [watcher.token, f.owner]) {
      const page = await catchup(f, "&reader=lead", token);
      expect(page).toMatchObject({ brief: { text: "Read me." } });
      expect("briefChanged" in page).toBe(false);
    }
    const seen = () =>
      runInDurableObject(env.MSN_DURABLE_OBJECT.getByName(JSON.stringify(["tenant", f.tenant])), (_, state) =>
        state.storage.sql
          .exec<{ reader: string }>("SELECT reader FROM brief_seen ORDER BY reader")
          .toArray()
          .map((row) => row.reader),
      );
    expect(await seen()).toEqual([]);
    expect(await catchup(f, "&reader=lead")).toMatchObject({ briefChanged: true });

    // A bound key may name itself or one of its workers (`name/<worker>`), and nothing else.
    expect(await catchup(f, "&reader=human", f.owner)).toMatchObject({ briefChanged: true });
    expect(await catchup(f, "&reader=human", f.owner)).toMatchObject({ briefChanged: false });
    expect(await catchup(f, "&reader=human/w1", f.owner)).toMatchObject({ briefChanged: true });
    expect("briefChanged" in (await catchup(f, "&reader=humanoid", f.owner))).toBe(false);
    expect(await seen()).toEqual(["human", "human/w1", "lead"]);
  });

  it("refuses a write on an archived board and from a watch-only key", async () => {
    const f = await fixture();
    await put(f, "Kept.", 0);
    const invite = (await (
      await call(f.tenant, "/invites", f.owner, "POST", { channel: "work", watch: true })
    ).json()) as { code: string };
    const watcher = (await (
      await call(f.tenant, "/invites/redeem", undefined, "POST", { code: invite.code, username: "watcher" })
    ).json()) as { token: string };
    const watched = await put(f, "No.", 1, watcher.token);
    expect(watched.status).toBe(403);
    expect(await watched.json()).toMatchObject({ error: { code: "watch_only" } });
    // A watch-only reader still gets the brief, and is told when it is new.
    expect(await catchup(f, "&reader=watcher", watcher.token)).toMatchObject({
      brief: { text: "Kept." },
      briefChanged: true,
    });
    expect(await catchup(f, "&reader=watcher", watcher.token)).toMatchObject({ briefChanged: false });

    expect((await call(f.tenant, "/channels/work/archive", f.owner, "PUT")).status).toBe(200);
    const archived = await put(f, "Changed.", 1);
    expect(archived.status).toBe(409);
    expect(await archived.json()).toMatchObject({ error: { code: "board_archived" } });
    expect(await get(f)).toMatchObject({ brief: { version: 1, text: "Kept." } });
  });

  it("keeps at most 100 versions and counts the text against workspace storage", async () => {
    const f = await fixture();
    const stub = env.MSN_DURABLE_OBJECT.getByName(JSON.stringify(["tenant", f.tenant]));
    const usage = () =>
      runInDurableObject(stub, (_, state) => state.storage.sql.exec("SELECT bytes FROM usage").one().bytes);
    const start = (await usage()) as number;
    await put(f, "12345", 0);
    // The brief's 5 bytes, plus the control message that announces it.
    const afterFirst = (await usage()) as number;
    expect(afterFirst).toBeGreaterThanOrEqual(start + 5);
    await runInDurableObject(stub, (_, state) => {
      for (let version = 2; version <= 100; version++)
        state.storage.sql.exec(
          "INSERT INTO board_briefs(channel, version, text, bytes, updatedBy, updatedAt) VALUES ('work', ?, 'filler', 6, NULL, ?)",
          version,
          new Date().toISOString(),
        );
      state.storage.sql.exec("UPDATE usage SET bytes = bytes + 594 WHERE singleton = 1");
    });
    const before = (await usage()) as number;
    expect((await put(f, "newest", 100)).status).toBe(201);
    const kept = await runInDurableObject(stub, (_, state) =>
      state.storage.sql
        .exec("SELECT MIN(version) AS low, MAX(version) AS high, COUNT(*) AS n FROM board_briefs")
        .one(),
    );
    expect(kept).toEqual({ low: 2, high: 101, n: 100 });
    expect((await call(f.tenant, "/channels/work/brief?version=1", f.agent)).status).toBe(404);
    // +6 for the new text, -5 for the dropped first version, plus the control message.
    const message = (await catchup(f, "&after=0")).messages.at(-1);
    expect(message?.username).toBe("board");
    const control = await runInDurableObject(
      stub,
      (_, state) =>
        state.storage.sql.exec("SELECT bytes FROM messages WHERE id = ?", message?.id as number).one().bytes,
    );
    expect(await usage()).toBe(before + 6 - 5 + (control as number));
  });

  it("forgets the readers idle the longest once a board remembers 1000", async () => {
    const f = await fixture();
    await put(f, "Brief.", 0);
    expect(await catchup(f, "&reader=oldest")).toMatchObject({ briefChanged: true });
    const stub = env.MSN_DURABLE_OBJECT.getByName(JSON.stringify(["tenant", f.tenant]));
    await runInDurableObject(stub, (_, state) => {
      state.storage.sql.exec("UPDATE brief_seen SET seenAt = '2020-01-01T00:00:00.000Z'");
      for (let n = 0; n < 999; n++)
        state.storage.sql.exec(
          "INSERT INTO brief_seen(channel, reader, version, seenAt) VALUES ('work', ?, 1, '2021-01-01T00:00:00.000Z')",
          `reader-${n}`,
        );
    });
    expect(await catchup(f, "&reader=oldest")).toMatchObject({ briefChanged: false });
    expect(await catchup(f, "&reader=newcomer")).toMatchObject({ briefChanged: true });
    const rows = await runInDurableObject(stub, (_, state) =>
      state.storage.sql
        .exec("SELECT COUNT(*) AS n, SUM(reader = 'oldest') AS oldest FROM brief_seen WHERE channel = 'work'")
        .one(),
    );
    // `oldest` was just refreshed, so one of the 2021 readers went instead.
    expect(rows).toEqual({ n: 1000, oldest: 1 });
  });

  it("starts a board with a brief and carries it in a saved template", async () => {
    const f = await fixture();
    const created = await call(f.tenant, "/channels/next/board", f.owner, "PUT", {
      credential: "d".repeat(64),
      goal: "Next",
      brief: "Start here.",
    });
    expect(created.status).toBe(201);
    const next = (await (await call(f.tenant, "/channels/next/brief", f.owner)).json()) as BriefResult;
    expect(next).toMatchObject({ brief: { version: 1, text: "Start here.", updatedBy: "human" } });
    // A new board's brief needs no announcement: start already leads with it.
    const page = (await (
      await call(f.tenant, "/channels/next/catchup?reader=x", "d".repeat(64))
    ).json()) as Catchup;
    expect(page).toMatchObject({ brief: { text: "Start here." }, briefChanged: true, messages: [] });
    const invalid = await call(f.tenant, "/channels/bad/board", f.owner, "PUT", {
      credential: "e".repeat(64),
      goal: "Bad",
      brief: "x".repeat(4097),
    });
    expect(invalid.status).toBe(400);

    expect((await call(f.tenant, "/templates/with-brief", f.owner, "PUT", { channel: "next" })).status).toBe(
      201,
    );
    expect((await call(f.tenant, "/templates/no-brief", f.owner, "PUT", { channel: "work" })).status).toBe(
      201,
    );
    const list = (await (await call(f.tenant, "/templates", f.owner)).json()) as {
      templates: { id: string; brief?: string }[];
    };
    const saved = Object.fromEntries(list.templates.map((t) => [t.id, t]));
    expect(saved["with-brief"].brief).toBe("Start here.");
    expect("brief" in saved["no-brief"]).toBe(false);
  });
});
