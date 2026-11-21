import { runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

// Agent status (ADR 0064): each name can say, in one short line, what it is doing on a board.
// It is only what the agent said, kept until it changes or clears it, with a metadata-only event.

const ADMIN = "test-admin-secret-000000000000000000000";
const call = (tenant: string, suffix = "", token?: string, method = "GET", input?: unknown) =>
  exports.default.fetch(`https://msn.test/api/tenants/${tenant}${suffix}`, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json" },
    ...(input ? { body: JSON.stringify(input) } : {}),
  });

type Status = { name: string; text: string; setAt: string; seq: number; personaId?: string };

/** An owner account with a board `work`, its shared agent credential and personas `lead` and `dev`. */
async function fixture() {
  const tenant = `status-${crypto.randomUUID()}`;
  const owner = (await (await call(tenant, "", undefined, "PUT", { username: "human" })).json()) as {
    token: string;
  };
  const agent = "e".repeat(64);
  expect(
    (await call(tenant, "/channels/work/board", owner.token, "PUT", { credential: agent, goal: "Ship" }))
      .status,
  ).toBe(201);
  for (const name of ["lead", "dev"])
    expect(
      (await call(tenant, `/channels/work/personas/${name}`, agent, "PUT", { displayName: name })).status,
    ).toBe(201);
  return { tenant, owner: owner.token, agent };
}

const set = (f: { tenant: string }, token: string, username: string, text: string | null) =>
  call(f.tenant, "/channels/work/status", token, "PUT", { username, text });
const list = async (f: { tenant: string }, token: string) =>
  (await (await call(f.tenant, "/channels/work/statuses", token)).json()) as {
    statuses: Status[];
    statusSeq: number;
  };

describe("agent status (ADR 0064)", () => {
  it("sets, replaces and clears a status, and the same text again changes nothing", async () => {
    const f = await fixture();
    const first = await set(f, f.agent, "lead", "  running tests on PR 54 ");
    expect(first.status).toBe(200);
    const made = (await first.json()) as { status: Status; changed: boolean };
    expect(made).toMatchObject({
      changed: true,
      status: { name: "lead", text: "running tests on PR 54", seq: 1, personaId: "lead" },
    });
    expect(Date.parse(made.status.setAt)).toBeGreaterThan(Date.now() - 60_000);

    const again = (await (await set(f, f.agent, "lead", "running tests on PR 54")).json()) as {
      status: Status;
      changed: boolean;
    };
    expect(again).toMatchObject({ changed: false, status: { seq: 1, setAt: made.status.setAt } });

    await set(f, f.agent, "dev", "reviewing the deploy job");
    await set(f, f.agent, "lead", "merging PR 54");
    const { statuses, statusSeq } = await list(f, f.owner);
    expect(statusSeq).toBe(3);
    expect(statuses.map((s) => [s.name, s.text, s.seq])).toEqual([
      ["lead", "merging PR 54", 3],
      ["dev", "reviewing the deploy job", 2],
    ]);

    const cleared = await (await set(f, f.agent, "lead", null)).json();
    expect(cleared).toEqual({ channel: "work", status: null, changed: true });
    const viaDelete = await call(f.tenant, "/channels/work/status?username=dev", f.agent, "DELETE");
    expect(viaDelete.status).toBe(200);
    expect(await viaDelete.json()).toEqual({ channel: "work", status: null, changed: true });
    expect(
      await (await call(f.tenant, "/channels/work/status?username=dev", f.agent, "DELETE")).json(),
    ).toEqual({ channel: "work", status: null, changed: false });
    expect((await list(f, f.agent)).statuses).toEqual([]);
  });

  it("shows the status on the persona list, and never infers one", async () => {
    const f = await fixture();
    await set(f, f.agent, "dev", "writing the ADR");
    const { personas } = (await (await call(f.tenant, "/channels/work/personas", f.owner)).json()) as {
      personas: { displayName: string; status: { text: string; setAt: string } | null }[];
    };
    expect(personas.map((p) => [p.displayName, p.status?.text ?? null])).toEqual([
      ["lead", null],
      ["dev", "writing the ADR"],
    ]);
  });

  it("writes one metadata-only status.changed event per change, only for include=statuses", async () => {
    const f = await fixture();
    const before = (await (await call(f.tenant, "/events?channel=work", f.owner)).json()) as {
      nextCursor: number;
    };
    await set(f, f.agent, "lead", "secret plan text");
    await set(f, f.agent, "lead", "secret plan text");
    await set(f, f.agent, "lead", null);
    const plain = (await (
      await call(f.tenant, `/events?channel=work&after=${before.nextCursor}`, f.owner)
    ).json()) as { events: unknown[] };
    expect(plain.events).toEqual([]);
    const response = await call(
      f.tenant,
      `/events?channel=work&after=${before.nextCursor}&include=statuses`,
      f.owner,
    );
    const raw = await response.text();
    expect(raw).not.toContain("secret");
    const { events } = JSON.parse(raw) as { events: { type: string; resourceId: number }[] };
    expect(events.map((e) => [e.type, e.resourceId])).toEqual([
      ["status.changed", 1],
      ["status.changed", 2],
    ]);
    expect((await call(f.tenant, "/events?include=bogus", f.owner)).status).toBe(400);
  });

  it("wakes a waiting event poll that asked for statuses", async () => {
    const f = await fixture();
    const { nextCursor } = (await (await call(f.tenant, "/events?channel=work", f.owner)).json()) as {
      nextCursor: number;
    };
    const waiting = call(
      f.tenant,
      `/events?channel=work&after=${nextCursor}&wait=10&include=statuses`,
      f.owner,
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    await set(f, f.agent, "lead", "starting");
    const { events } = (await (await waiting).json()) as { events: { type: string }[] };
    expect(events.map((e) => e.type)).toEqual(["status.changed"]);
  });

  it("lets a bound key set only its own name, and a board key only a registered persona", async () => {
    const f = await fixture();
    const key = (await (
      await exports.default.fetch(`https://msn.test/api/admin/tenants/${f.tenant}/keys/bot`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${ADMIN}`, "Content-Type": "application/json" },
        body: JSON.stringify({ username: "bot" }),
      })
    ).json()) as { token: string };
    expect((await set(f, key.token, "bot", "on it")).status).toBe(200);
    const other = await set(f, key.token, "lead", "pretending");
    expect(other.status).toBe(403);
    expect(await other.json()).toMatchObject({ error: { code: "username_bound" } });
    const cleared = await call(f.tenant, "/channels/work/status?username=lead", key.token, "DELETE");
    expect(cleared.status).toBe(403);

    const stranger = await set(f, f.agent, "stranger", "hello");
    expect(stranger.status).toBe(400);
    expect(await stranger.json()).toMatchObject({ error: { code: "persona_required" } });
    expect((await set(f, f.owner, "github", "fake")).status).toBe(403);
    // A name that is not a persona can have a status too, under a key that may use it.
    expect((await set(f, f.owner, "human", "reviewing")).status).toBe(200);
    expect((await list(f, f.agent)).statuses.map((s) => [s.name, s.personaId ?? null])).toEqual([
      ["human", null],
      ["bot", null],
    ]);
  });

  it("refuses bad text, unknown fields and unknown boards", async () => {
    const f = await fixture();
    for (const text of [
      "",
      "   ",
      "two\nlines",
      "tab\there",
      "x".repeat(81),
      5,
      "a\u2028b",
      "a\u2029b",
      "evil\u202Etxt",
      "iso\u2066late",
      "\u0085lead",
      "zero\u200Bwidth",
      "mid\uFEFFbom",
    ])
      expect(
        (await call(f.tenant, "/channels/work/status", f.agent, "PUT", { username: "lead", text })).status,
      ).toBe(400);
    // Emoji sequences keep their zero-width joiner and mixed text its RLM; a leading BOM is trimmed.
    expect((await set(f, f.agent, "lead", "PR 54 \u200Fשלום")).status).toBe(200);
    expect((await set(f, f.agent, "lead", "👨\u200D💻 coding")).status).toBe(200);
    const trimmed = (await (await set(f, f.agent, "lead", "\uFEFFok")).json()) as { status: Status };
    expect(trimmed.status.text).toBe("ok");
    // 80 characters is the limit in code points, not bytes.
    expect((await set(f, f.agent, "lead", "é".repeat(80))).status).toBe(200);
    expect(
      (await call(f.tenant, "/channels/work/status", f.agent, "PUT", { username: "lead", text: "a", x: 1 }))
        .status,
    ).toBe(400);
    expect((await call(f.tenant, "/channels/work/status", f.agent, "DELETE")).status).toBe(400);
    expect((await call(f.tenant, "/channels/nope/statuses", f.owner)).status).toBe(404);
    expect(
      (await call(f.tenant, "/channels/nope/status", f.owner, "PUT", { username: "a", text: "b" })).status,
    ).toBe(404);
    // The board's shared key is scoped to its board.
    await call(f.tenant, "/channels/other", f.owner, "PUT");
    expect((await call(f.tenant, "/channels/other/statuses", f.agent)).status).toBe(403);
  });

  it("refuses watch-only keys and archived boards, and still lists on an archived board", async () => {
    const f = await fixture();
    await set(f, f.agent, "lead", "before archive");
    const invite = (await (
      await call(f.tenant, "/invites", f.owner, "POST", { channel: "work", watch: true })
    ).json()) as { code: string };
    const watcher = (await (
      await call(f.tenant, "/invites/redeem", undefined, "POST", { code: invite.code, username: "viewer" })
    ).json()) as { token: string };
    const refused = await set(f, watcher.token, "viewer", "watching");
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ error: { code: "watch_only" } });
    expect((await list(f, watcher.token)).statuses).toHaveLength(1);

    expect((await call(f.tenant, "/channels/work/archive", f.owner, "PUT")).status).toBe(200);
    const archived = await set(f, f.agent, "lead", "after archive");
    expect(archived.status).toBe(409);
    expect(await archived.json()).toMatchObject({ error: { code: "board_archived" } });
    expect((await list(f, f.agent)).statuses.map((s) => s.text)).toEqual(["before archive"]);
  });

  it("caps names per board and changes per workspace", async () => {
    const f = await fixture();
    const key = (await (
      await exports.default.fetch(`https://msn.test/api/admin/tenants/${f.tenant}/keys/many`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${ADMIN}`, "Content-Type": "application/json" },
        body: JSON.stringify({ usernamePrefix: "n" }),
      })
    ).json()) as { token: string };
    const stub = env.MSN_DURABLE_OBJECT.getByName(JSON.stringify(["tenant", f.tenant]));
    await runInDurableObject(stub, (_instance, state) => {
      const now = new Date().toISOString();
      for (let i = 0; i < 200; i++)
        state.storage.sql.exec(
          "INSERT INTO agent_status(channel, name, text, setAt, seq) VALUES ('work', ?, 'x', ?, 0)",
          `n${i}`,
          now,
        );
    });
    const full = await set(f, key.token, "n-one-more", "hi");
    expect(full.status).toBe(409);
    expect(await full.json()).toMatchObject({ error: { code: "status_limit" } });
    // Changing a name that already has a status still works at the cap.
    expect((await set(f, key.token, "n0", "changed")).status).toBe(200);
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec("UPDATE usage SET statusChanges = 100000");
    });
    const spent = await set(f, key.token, "n1", "again");
    expect(spent.status).toBe(409);
    expect(await spent.json()).toMatchObject({ error: { code: "status_quota" } });
    // Past the cap a clear still goes through, with its event, so no line outlives the quota.
    const cleared = await set(f, key.token, "n0", null);
    expect(cleared.status).toBe(200);
    expect(await cleared.json()).toMatchObject({ status: null, changed: true });
    const viaDelete = await call(f.tenant, "/channels/work/status?username=n1", key.token, "DELETE");
    expect(await viaDelete.json()).toMatchObject({ changed: true });
    const { events } = (await (
      await call(f.tenant, "/events?channel=work&include=statuses", f.owner)
    ).json()) as { events: { type: string; resourceId: number }[] };
    expect(events.filter((e) => e.type === "status.changed").map((e) => e.resourceId)).toEqual([
      1, 100001, 100002,
    ]);
    expect((await list(f, f.agent)).statuses.some((s) => s.name === "n0" || s.name === "n1")).toBe(false);
  });
});

describe("agent status and since you last looked (ADR 0061, ADR 0064)", () => {
  it("many status changes do not crowd label changes out of the since window", async () => {
    const f = await fixture();
    const send = async (text: string) =>
      (
        (await (
          await call(f.tenant, "/channels/work/messages", f.agent, "POST", { username: "lead", text })
        ).json()) as { message: { id: number } }
      ).message.id;
    const mark = await send("mark");
    const task = await send("task");
    await call(f.tenant, `/channels/work/messages/${task}/labels`, f.agent, "POST", {
      set: { state: "done" },
    });
    // More status events than the 2,000-event window, all newer than the label change.
    const stub = env.MSN_DURABLE_OBJECT.getByName(JSON.stringify(["tenant", f.tenant]));
    await runInDurableObject(stub, (_instance, state) => {
      const now = new Date().toISOString();
      for (let i = 1; i <= 2100; i++)
        state.storage.sql.exec(
          "INSERT INTO events (channel, type, resourceId, historyRevision, createdAt) VALUES ('work', 'status.changed', ?, 0, ?)",
          i,
          now,
        );
    });
    const since = (await (
      await call(f.tenant, `/channels/work/since?reader=dev&after=${mark}`, f.agent)
    ).json()) as { labels: { messages: { id: number }[]; changes: number } };
    expect(since.labels.messages.map((m) => m.id)).toEqual([task]);
    expect(since.labels.changes).toBe(1);
  });
});
