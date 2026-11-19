import { runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { Message } from "../src/store";

declare module "cloudflare:workers" {
  interface ProvidedEnv extends Env {}
}
const ADMIN = "test-admin-secret-000000000000000000000";
const MiB = 1024 * 1024;
type Upload = { attachment: { id: string; bytes: number } };

const call = (path: string, token?: string, init: RequestInit = {}) =>
  exports.default.fetch(`https://msn.test${path}`, {
    ...init,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...init.headers },
  });

async function tenant() {
  const name = `t-${crypto.randomUUID()}`;
  const response = await call(`/api/admin/tenants/${name}`, ADMIN, { method: "PUT" });
  expect(response.status).toBe(201);
  const token = (await response.json<{ token: string }>()).token;
  const path = `/api/tenants/${name}`;
  expect((await call(`${path}/channels/general`, token, { method: "PUT" })).status).toBe(201);
  return {
    name,
    token,
    path,
    admin: `/api/admin/tenants/${name}`,
    stub: env.MSN_DURABLE_OBJECT.getByName(JSON.stringify(["tenant", name])),
  };
}
type Tenant = Awaited<ReturnType<typeof tenant>>;

const upload = (t: Tenant, data: BodyInit, channel = "general") =>
  call(`${t.path}/channels/${channel}/attachments`, t.token, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: data,
  });
const send = (t: Tenant, attachments: unknown, key?: string, text = "see attached") =>
  call(`${t.path}/channels/general/messages`, t.token, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(key ? { "Idempotency-Key": key } : {}) },
    body: JSON.stringify({ username: "agent", text, attachments }),
  });
const usageBytes = (t: Tenant) =>
  runInDurableObject(
    t.stub,
    (_instance, state) => state.storage.sql.exec<{ bytes: number }>("SELECT bytes FROM usage").one().bytes,
  );
async function sha(text: string) {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, "0")).join("");
}

describe("message attachments (ADR 0035)", () => {
  it("uploads by content hash, sends, lists and downloads a file", async () => {
    const t = await tenant();
    const before = await usageBytes(t);
    const first = await upload(t, "line 1\nline 2\n");
    expect(first.status).toBe(201);
    const { attachment } = await first.json<Upload>();
    expect(attachment).toEqual({ id: await sha("line 1\nline 2\n"), bytes: 14 });
    // The same bytes again are the same file: 200, no second copy, no second charge.
    const again = await upload(t, "line 1\nline 2\n");
    expect(again.status).toBe(200);
    expect((await again.json<Upload>()).attachment.id).toBe(attachment.id);
    expect(await usageBytes(t)).toBe(before + 14);

    const sent = await send(t, [{ id: attachment.id, name: "build.log" }], "k1");
    expect(sent.status).toBe(201);
    const { message } = await sent.json<{ message: Message }>();
    expect(message.attachments).toEqual([
      { index: 0, id: attachment.id, name: "build.log", mediaType: "text/plain", bytes: 14 },
    ]);

    const page = await (await call(`${t.path}/channels/general/messages`, t.token)).json<{
      messages: Message[];
    }>();
    expect(page.messages.at(-1)?.attachments?.[0].name).toBe("build.log");
    const shown = await (await call(`${t.path}/channels/general/messages/${message.id}`, t.token)).json<{
      message: Message;
    }>();
    expect(shown.message.attachments).toEqual(message.attachments);
    const catchup = await (await call(`${t.path}/channels/general/catchup`, t.token)).json<{
      messages: Message[];
    }>();
    expect(catchup.messages.at(-1)?.attachments).toEqual(message.attachments);

    const file = await call(`${t.path}/channels/general/messages/${message.id}/attachments/0`, t.token);
    expect(file.status).toBe(200);
    expect(file.headers.get("Content-Type")).toBe("text/plain");
    expect(file.headers.get("Content-Disposition")).toBe(
      `attachment; filename="build.log"; filename*=UTF-8''build.log`,
    );
    expect(file.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(await file.text()).toBe("line 1\nline 2\n");
    expect(
      (await call(`${t.path}/channels/general/messages/${message.id}/attachments/1`, t.token)).status,
    ).toBe(404);
  });

  it("keeps plain messages unchanged and replays retries with the same files", async () => {
    const t = await tenant();
    const plain = await send(t, undefined, "plain");
    expect("attachments" in (await plain.json<{ message: Message }>()).message).toBe(false);

    const { attachment } = await (await upload(t, new Uint8Array([137, 80, 78, 71]))).json<Upload>();
    const refs = [{ id: attachment.id, name: "shot.png" }];
    const created = await (await send(t, refs, "retry")).json<{ message: Message }>();
    const replay = await send(t, refs, "retry");
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({ message: created.message, replayed: true });
    // Same key with different files is a conflict, not a silent replay.
    expect((await send(t, [{ id: attachment.id, name: "other.png" }], "retry")).status).toBe(409);
    expect((await send(t, undefined, "retry")).status).toBe(409);

    const image = await call(
      `${t.path}/channels/general/messages/${created.message.id}/attachments/0`,
      t.token,
    );
    expect(image.headers.get("Content-Type")).toBe("image/png");
    expect(image.headers.get("Content-Disposition")?.startsWith("inline;")).toBe(true);
  });

  it("validates uploads and references", async () => {
    const t = await tenant();
    expect((await upload(t, "")).status).toBe(400);
    const big = await upload(t, new Uint8Array(MiB + 1));
    expect(big.status).toBe(413);
    expect(((await big.json()) as { error: { code: string } }).error.code).toBe("attachment_too_large");
    expect((await upload(t, new Uint8Array(MiB))).status).toBe(201);
    expect((await upload(t, "x", "missing")).status).toBe(404);
    expect((await call(`${t.path}/channels/general/attachments`, undefined, { method: "POST" })).status).toBe(
      401,
    );

    const { attachment } = await (await upload(t, "patch")).json<Upload>();
    const ref = (extra: Record<string, unknown>) => ({ id: attachment.id, name: "a.diff", ...extra });
    const code = async (attachments: unknown) =>
      ((await (await send(t, attachments)).json()) as { error: { code: string } }).error.code;
    expect(await code([])).toBe("invalid_attachment");
    expect(await code([1, 2, 3, 4, 5].map((n) => ref({ name: `${n}.diff` })))).toBe("invalid_attachment");
    expect(await code([ref({ name: "../etc/passwd" })])).toBe("invalid_attachment");
    expect(await code([ref({ name: "a\nb" })])).toBe("invalid_attachment");
    expect(await code([ref({}), ref({})])).toBe("invalid_attachment");
    expect(await code([ref({ mediaType: "Text/HTML" })])).toBe("invalid_attachment");
    expect(await code([ref({ size: 1 })])).toBe("invalid_attachment");
    expect(await code([ref({ id: "abc" })])).toBe("invalid_attachment");
    expect(await code([ref({ id: "0".repeat(64) })])).toBe("attachment_not_found");

    // A file uploaded to another channel cannot be referenced here.
    await call(`${t.path}/channels/other`, t.token, { method: "PUT" });
    const elsewhere = await (await upload(t, "only there", "other")).json<Upload>();
    expect(await code([{ id: elsewhere.attachment.id, name: "x.txt" }])).toBe("attachment_not_found");

    const typed = await (await send(t, [ref({ mediaType: "text/x-diff" })])).json<{ message: Message }>();
    expect(typed.message.attachments?.[0].mediaType).toBe("text/x-diff");
    const unknown = await (await send(t, [ref({ name: "blob.bin" })])).json<{ message: Message }>();
    expect(unknown.message.attachments?.[0].mediaType).toBe("application/octet-stream");
  });

  it("counts attachments in the workspace content quota", async () => {
    const t = await tenant();
    await runInDurableObject(t.stub, (_instance, state) => {
      state.storage.sql.exec("UPDATE usage SET bytes = ?", 128 * MiB - 10);
    });
    const full = await upload(t, "eleven byte");
    expect(full.status).toBe(409);
    expect(((await full.json()) as { error: { code: string } }).error.code).toBe("storage_quota");
    expect((await upload(t, "ten bytes!")).status).toBe(201);
  });

  it("deletes unused uploads after 24 hours, but never a referenced file", async () => {
    const t = await tenant();
    const kept = await (await upload(t, "referenced")).json<Upload>();
    const orphan = await (await upload(t, "orphan")).json<Upload>();
    await send(t, [{ id: kept.attachment.id, name: "kept.txt" }]);
    const before = await usageBytes(t);
    await runInDurableObject(t.stub, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE attachments SET createdAt = ?",
        new Date(Date.now() - 25 * 3600_000).toISOString(),
      );
    });
    await upload(t, "trigger");
    const ids = await runInDurableObject(t.stub, (_instance, state) =>
      state.storage.sql
        .exec<{ id: string }>("SELECT id FROM attachments ORDER BY bytes")
        .toArray()
        .map((row) => row.id),
    );
    expect(ids).not.toContain(orphan.attachment.id);
    expect(ids).toContain(kept.attachment.id);
    expect(await usageBytes(t)).toBe(before - "orphan".length + "trigger".length);
    expect((await send(t, [{ id: orphan.attachment.id, name: "late.txt" }])).status).toBe(400);
  });

  it("removes a deleted message's files at once and frees their bytes", async () => {
    const t = await tenant();
    const shared = await (await upload(t, "shared")).json<Upload>();
    const own = await (await upload(t, "own file")).json<Upload>();
    const first = await (
      await send(t, [
        { id: shared.attachment.id, name: "a.txt" },
        { id: own.attachment.id, name: "b.txt" },
      ])
    ).json<{ message: Message }>();
    const second = await (await send(t, [{ id: shared.attachment.id, name: "c.txt" }])).json<{
      message: Message;
    }>();
    const before = await usageBytes(t);
    const deleted = await call(`${t.admin}/channels/general/messages/${first.message.id}`, ADMIN, {
      method: "DELETE",
    });
    expect(deleted.status).toBe(204);
    // The deleted message's text and its unshared file are gone; the shared file stays for `second`.
    expect(await usageBytes(t)).toBe(before - new TextEncoder().encode("agentsee attached").length - 8);
    expect(
      (await call(`${t.path}/channels/general/messages/${first.message.id}/attachments/0`, t.token)).status,
    ).toBe(410);
    const still = await call(
      `${t.path}/channels/general/messages/${second.message.id}/attachments/0`,
      t.token,
    );
    expect(await still.text()).toBe("shared");
    const remaining = await runInDurableObject(
      t.stub,
      (_instance, state) =>
        state.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM attachments").one().count,
    );
    expect(remaining).toBe(1);
  });
});
