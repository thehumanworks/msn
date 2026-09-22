import { abortAllDurableObjects, runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

/**
 * Goal: GET /api/tenants/:tenant/channels/:channel/messages/:id returns a live same-channel
 * row as {message,historyRevision}; missing/wrong-channel are 404 message_not_found;
 * same-channel tombstones are 410 message_deleted with no wiped data.
 *
 * I1 auth before lookup → "rejects unauthenticated and foreign tokens before lookup"
 * I2 requireChannel → "requires an existing channel before id lookup"
 * I3 live identity + historyRevision → "returns live identity matching poll including annotations"
 * I4 missing id → "missing and wrong-channel are message_not_found"
 * I5 wrong-channel live or deleted never 410 → "does not leak a foreign-channel tombstone as 410"
 * I6 tombstone body has only error → "deleted tombstone does not leak wiped data"
 * I7 malformed/non-positive/non-canonical id → "rejects malformed ids after auth"
 * I8 poll/send/snapshot unchanged → "preserves poll send and snapshot routes"
 * I9 participant keys / tenant isolation → "accepts participant keys and isolates tenants"
 * I10 historyRevision follows redaction → "historyRevision follows channel redaction"
 *
 * Edge cases: 0, 01, +1, -1, 1.5, 1e2, overflow, empty segment; wait query ignored.
 * Out of scope: batch metadata, CLI show, schema migration.
 * QA: bunx vitest run tests/evidence.test.ts; scoped mutants on src/store.ts showMessage path.
 */
type Message = {
  id: number;
  tenant: string;
  channel: string;
  username: string;
  text: string;
  contentType: string;
  createdAt: string;
  replyTo?: number;
  correlationId?: string;
  to?: string;
};
type ErrorBody = { error: { code: string; message: string }; message?: unknown };
const ADMIN = "test-admin-secret-000000000000000000000";
const WRONG = "wrong-token-00000000000000000000000000";
const SECRET = "wipe-secret-do-not-leak";

const call = (path: string, token?: string, method = "GET", data?: unknown, key?: string) =>
  exports.default.fetch(`https://msn.test${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(data === undefined ? {} : { "Content-Type": "application/json" }),
      ...(key === undefined ? {} : { "Idempotency-Key": key }),
    },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  });

async function workspace() {
  const name = `ev-${crypto.randomUUID()}`;
  const admin = `/api/admin/tenants/${name}`;
  const response = await call(admin, ADMIN, "PUT");
  expect(response.status).toBe(201);
  const { token } = await response.json<{ token: string }>();
  const root = `/api/tenants/${name}`;
  await call(`${root}/channels/general`, token, "PUT");
  return {
    name,
    token,
    admin,
    root,
    stub: env.MSN_DURABLE_OBJECT.getByName(JSON.stringify(["tenant", name])),
  };
}
type Workspace = Awaited<ReturnType<typeof workspace>>;

async function send(
  w: Workspace,
  text = "event",
  channel = "general",
  extra: Record<string, unknown> = {},
  key?: string,
) {
  const response = await call(
    `${w.root}/channels/${channel}/messages`,
    w.token,
    "POST",
    { username: "agent", text, ...extra },
    key,
  );
  expect(response.status).toBe(201);
  return (await response.json<{ message: Message }>()).message;
}

const show = (w: Workspace, id: string | number, channel = "general", token?: string, query = "") =>
  call(`${w.root}/channels/${channel}/messages/${id}${query}`, token === undefined ? w.token : token);

const remove = (w: Workspace, id: number, channel = "general") =>
  call(`${w.admin}/channels/${channel}/messages/${id}`, ADMIN, "DELETE");

async function errorOf(response: Response): Promise<ErrorBody> {
  return response.json<ErrorBody>();
}

describe("participant point lookup of canonical channel messages", () => {
  it("rejects unauthenticated and foreign tokens before lookup", async () => {
    const w = await workspace();
    const message = await send(w, "private-row");
    const path = `${w.root}/channels/general/messages/${message.id}`;
    for (const token of [undefined, WRONG, ADMIN]) {
      const response = await call(path, token);
      expect(response.status, String(token)).toBe(401);
      const body = await errorOf(response);
      expect(body.error.code).toBe("unauthorized");
      expect(body).not.toHaveProperty("message");
      expect(JSON.stringify(body)).not.toContain("private-row");
    }
    const alien = await workspace();
    const cross = await call(path, alien.token);
    expect(cross.status).toBe(401);
    expect((await errorOf(cross)).error.code).toBe("unauthorized");
    expect((await show(w, message.id)).status).toBe(200);
  });

  it("requires an existing channel before id lookup", async () => {
    const w = await workspace();
    const response = await show(w, 1, "missing");
    expect(response.status).toBe(404);
    expect((await errorOf(response)).error.code).toBe("channel_not_found");
    const malformedOnMissing = await show(w, "01", "missing");
    expect(malformedOnMissing.status).toBe(404);
    expect((await errorOf(malformedOnMissing)).error.code).toBe("channel_not_found");
  });

  it("returns live identity matching poll including annotations", async () => {
    const w = await workspace();
    const root = await send(w, "root-note");
    const typed = await send(w, '{"ok":true}', "general", {
      contentType: "application/json",
      replyTo: root.id,
      correlationId: "task-evidence",
      to: "reviewer",
    });
    const listed = await call(`${w.root}/channels/general/messages`, w.token);
    expect(listed.status).toBe(200);
    const page = await listed.json<{ messages: Message[] }>();
    const shown = await show(w, typed.id, "general", w.token, "?wait=5&after=0&limit=1");
    expect(shown.status).toBe(200);
    const body = await shown.json<{ message: Message; historyRevision: number }>();
    expect(Object.keys(body).sort()).toEqual(["historyRevision", "message"]);
    expect(body.historyRevision).toBe(0);
    expect(body.message).toEqual(page.messages.find((row) => row.id === typed.id));
    expect(body.message).toMatchObject({
      id: typed.id,
      tenant: w.name,
      channel: "general",
      username: "agent",
      text: '{"ok":true}',
      contentType: "application/json",
      replyTo: root.id,
      correlationId: "task-evidence",
      to: "reviewer",
    });
    const plain = await show(w, root.id);
    expect(plain.status).toBe(200);
    const live = await plain.json<{ message: Message }>();
    expect(live.message.replyTo).toBeUndefined();
    expect(live.message.correlationId).toBeUndefined();
    expect(live.message.to).toBeUndefined();
    expect(Object.keys(live.message).sort()).toEqual([
      "channel",
      "contentType",
      "createdAt",
      "id",
      "tenant",
      "text",
      "username",
    ]);
    await abortAllDurableObjects();
    expect(await (await show(w, typed.id)).json()).toEqual(body);
  });

  it("missing and wrong-channel are message_not_found", async () => {
    const w = await workspace();
    const general = await send(w, "keep-here");
    const other = await send(w, "other-row", "other");
    const missing = await show(w, general.id + other.id + 99);
    expect(missing.status).toBe(404);
    const missingBody = await errorOf(missing);
    expect(missingBody.error.code).toBe("message_not_found");
    expect(Object.keys(missingBody).sort()).toEqual(["error"]);
    const wrong = await show(w, general.id, "other");
    expect(wrong.status).toBe(404);
    expect((await errorOf(wrong)).error.code).toBe("message_not_found");
    expect((await errorOf(await show(w, other.id))).error.code).toBe("message_not_found");
    expect((await show(w, general.id)).status).toBe(200);
    expect((await show(w, other.id, "other")).status).toBe(200);
  });

  it("does not leak a foreign-channel tombstone as 410", async () => {
    const w = await workspace();
    const hidden = await send(w, SECRET);
    await send(w, "visible-other", "other");
    expect((await remove(w, hidden.id)).status).toBe(204);
    const foreign = await show(w, hidden.id, "other");
    expect(foreign.status).toBe(404);
    const body = await errorOf(foreign);
    expect(body.error.code).toBe("message_not_found");
    expect(body).not.toHaveProperty("message");
    expect(JSON.stringify(body)).not.toContain(SECRET);
  });

  it("deleted tombstone does not leak wiped data", async () => {
    const w = await workspace();
    const victim = await send(w, SECRET, "general", { correlationId: "redact-me", to: "spy" });
    expect((await remove(w, victim.id)).status).toBe(204);
    const stored = await runInDurableObject(w.stub, (_, state) =>
      state.storage.sql
        .exec<{ username: string; text: string; deleted: number }>(
          "SELECT username, text, deleted FROM messages WHERE id = ?",
          victim.id,
        )
        .one(),
    );
    expect(stored).toEqual({ username: "", text: "", deleted: 1 });
    const response = await show(w, victim.id);
    expect(response.status).toBe(410);
    const body = await errorOf(response);
    expect(body.error.code).toBe("message_deleted");
    expect(Object.keys(body).sort()).toEqual(["error"]);
    expect(Object.keys(body.error).sort()).toEqual(["code", "message"]);
    expect(body).not.toHaveProperty("message");
    expect(body).not.toHaveProperty("historyRevision");
    const dumped = JSON.stringify(body);
    expect(dumped).not.toContain(SECRET);
    expect(dumped).not.toContain("redact-me");
    expect(dumped).not.toContain("spy");
    expect(dumped).not.toContain(victim.username);
  });

  it("rejects malformed ids after auth", async () => {
    const w = await workspace();
    await send(w);
    for (const id of ["0", "01", "+1", "-1", "1.5", "1e2", "abc", "9007199254740992", ""]) {
      const response = await show(w, id);
      expect(response.status, id).toBe(400);
      const body = await errorOf(response);
      expect(body.error.code).toBe("invalid_query");
      expect(body).not.toHaveProperty("message");
    }
    expect((await show(w, 1)).status).toBe(200);
    expect((await show(w, "0", "general", undefined)).status).toBe(400);
    expect((await show(w, "0", "general", WRONG)).status).toBe(401);
  });

  it("preserves poll send and snapshot routes", async () => {
    const w = await workspace();
    const first = await send(w, "page-one");
    const shown = await (await show(w, first.id)).json<{ message: Message }>();
    const page = await call(`${w.root}/channels/general/messages`, w.token);
    expect(page.status).toBe(200);
    expect((await page.json<{ messages: Message[] }>()).messages).toEqual([shown.message]);
    expect((await show(w, first.id, "general", w.token, "?wait=1")).status).toBe(200);
    expect((await call(`${w.root}/channels/general/messages/${first.id}`, w.token, "DELETE")).status).toBe(
      404,
    );
    expect((await call(`${w.root}/channels/general/messages/${first.id}`, w.token, "POST", {})).status).toBe(
      404,
    );
    const published = await call(
      `${w.root}/channels/general/snapshots`,
      w.token,
      "POST",
      {
        username: "agent",
        text: "checkpoint",
        coversThrough: first.id,
        baseVersion: 0,
        historyRevision: 0,
      },
      "snap-1",
    );
    expect(published.status).toBe(201);
    const catchup = await call(`${w.root}/channels/general/catchup`, w.token);
    expect(catchup.status).toBe(200);
    expect(await catchup.json()).toMatchObject({
      snapshot: { version: 1, coversThrough: first.id },
      historyRevision: 0,
    });
    const versions = await runInDurableObject(w.stub, (_, state) =>
      state.storage.sql
        .exec<{ version: number }>("SELECT version FROM schema_version ORDER BY version")
        .toArray(),
    );
    expect(versions.map((row) => row.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it("accepts participant keys and isolates tenants", async () => {
    const w = await workspace();
    const message = await send(w, "shared-evidence");
    const created = await call(`${w.admin}/keys/reader`, ADMIN, "PUT", { username: "reader" });
    expect(created.status).toBe(201);
    const { token } = await created.json<{ token: string }>();
    const asParticipant = await show(w, message.id, "general", token);
    expect(asParticipant.status).toBe(200);
    expect((await asParticipant.json<{ message: Message }>()).message.text).toBe("shared-evidence");
    const other = await workspace();
    expect((await show(other, message.id)).status).toBe(404);
    expect((await show(other, 1)).status).toBe(404);
    expect((await call(`${other.root}/channels/general/messages/${message.id}`, w.token)).status).toBe(401);
  });

  it("historyRevision follows channel redaction", async () => {
    const w = await workspace();
    const first = await send(w, "keep");
    const second = await send(w, SECRET);
    expect((await (await show(w, first.id)).json<{ historyRevision: number }>()).historyRevision).toBe(0);
    expect((await remove(w, second.id)).status).toBe(204);
    const after = await show(w, first.id);
    expect(after.status).toBe(200);
    expect((await after.json<{ historyRevision: number; message: Message }>()).historyRevision).toBe(1);
    expect((await show(w, second.id)).status).toBe(410);
    const other = await send(w, "other-keep", "other");
    expect(
      (await (await show(w, other.id, "other")).json<{ historyRevision: number }>()).historyRevision,
    ).toBe(0);
  });
});
