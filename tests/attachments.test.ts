import { runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { hex, hmacSha256, previewPayload } from "../src/attachment-bytes";
import type { Message } from "../src/store";
import { join, maxSizePng, privateJpeg, privateWebp, text } from "./fixtures/image-sanitisation";

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
const attachmentBytes = (t: Tenant) =>
  runInDurableObject(
    t.stub,
    (_instance, state) =>
      state.storage.sql.exec<{ bytes: number }>("SELECT attachmentBytes AS bytes FROM usage").one().bytes,
  );
const PNG = Uint8Array.from(
  atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="),
  (c) => c.charCodeAt(0),
);
describe("message attachments (ADR 0035)", () => {
  it("uploads by content hash, sends, lists and downloads a file", async () => {
    const t = await tenant();
    const before = await usageBytes(t);
    const first = await upload(t, "line 1\nline 2\n");
    expect(first.status).toBe(201);
    const { attachment } = await first.json<Upload>();
    expect(attachment.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(attachment.bytes).toBe(14);
    // The same bytes again are the same file: 200, no second copy, no second charge.
    const again = await upload(t, "line 1\nline 2\n");
    expect(again.status).toBe(200);
    expect((await again.json<Upload>()).attachment.id).toBe(attachment.id);
    // File bytes live in the attachment quota. The text quota is unchanged.
    expect(await usageBytes(t)).toBe(before);
    expect(await attachmentBytes(t)).toBe(14);

    const sent = await send(t, [{ id: attachment.id, name: "build.log" }], "k1");
    expect(sent.status).toBe(201);
    const { message } = await sent.json<{ message: Message }>();
    expect(message.attachments?.[0]).toMatchObject({
      index: 0,
      id: attachment.id,
      name: "build.log",
      mediaType: "text/plain",
      mime: "text/plain",
      bytes: 14,
      size: 14,
    });
    expect(message.attachments?.[0].url).toContain("/attachments/0");
    expect(message.attachments?.[0].downloadUrl).toContain("sig=");
    expect(message.attachments?.[0].previewUrl).toBeUndefined();

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

    const { attachment } = await (await upload(t, PNG)).json<Upload>();
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
    const big = await upload(t, new Uint8Array(25 * MiB + 1));
    expect(big.status).toBe(413);
    expect(((await big.json()) as { error: { code: string } }).error.code).toBe("attachment_too_large");
    expect((await upload(t, new Uint8Array(64))).status).toBe(201);
    expect((await upload(t, "x", "missing")).status).toBe(404);
    expect((await call(`${t.path}/channels/general/attachments`, undefined, { method: "POST" })).status).toBe(
      401,
    );

    const { attachment } = await (await upload(t, "patch")).json<Upload>();
    const ref = (extra: Record<string, unknown>) => ({ id: attachment.id, name: "a.diff", ...extra });
    const code = async (attachments: unknown) =>
      ((await (await send(t, attachments)).json()) as { error: { code: string } }).error.code;
    expect(await code([])).toBe("invalid_attachment");
    expect(await code([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map((n) => ref({ name: `${n}.diff` })))).toBe(
      "too_many_attachments",
    );
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

    // The client type and the .diff extension are ignored. The bytes are UTF-8 text.
    const typed = await (await send(t, [ref({ mediaType: "text/x-diff" })])).json<{ message: Message }>();
    expect(typed.message.attachments?.[0].mediaType).toBe("text/plain");
    expect(typed.message.attachments?.[0].mime).toBe("text/plain");
    const binary = await (await upload(t, new Uint8Array([0, 1, 2, 3, 4]))).json<Upload>();
    const unknown = await (
      await send(t, [{ id: binary.attachment.id, name: "blob.png", mediaType: "image/png" }])
    ).json<{ message: Message }>();
    expect(unknown.message.attachments?.[0].mediaType).toBe("application/octet-stream");
    expect(unknown.message.attachments?.[0].previewUrl).toBeUndefined();
  });

  it("counts attachments in the workspace content quota", async () => {
    const t = await tenant();
    await runInDurableObject(t.stub, (_instance, state) => {
      state.storage.sql.exec("UPDATE usage SET attachmentBytes = ?", 1024 * MiB - 10);
    });
    const full = await upload(t, "eleven byte");
    expect(full.status).toBe(409);
    expect(((await full.json()) as { error: { code: string } }).error.code).toBe("storage_quota");
    expect((await upload(t, "ten bytes!")).status).toBe(201);
    // A full text quota does not block a file, and a file does not fill the text quota.
    await runInDurableObject(t.stub, (_instance, state) => {
      state.storage.sql.exec("UPDATE usage SET bytes = ?, attachmentBytes = 0", 128 * MiB);
    });
    expect((await upload(t, "still room")).status).toBe(201);
  });

  it("deletes unused uploads after 24 hours, but never a referenced file", async () => {
    const t = await tenant();
    const kept = await (await upload(t, "referenced")).json<Upload>();
    const orphan = await (await upload(t, "orphan")).json<Upload>();
    await send(t, [{ id: kept.attachment.id, name: "kept.txt" }]);
    const before = await attachmentBytes(t);
    const textBefore = await usageBytes(t);
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
    expect(await attachmentBytes(t)).toBe(before - "orphan".length + "trigger".length);
    expect(await usageBytes(t)).toBe(textBefore);
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
    const filesBefore = await attachmentBytes(t);
    const deleted = await call(`${t.admin}/channels/general/messages/${first.message.id}`, ADMIN, {
      method: "DELETE",
    });
    expect(deleted.status).toBe(204);
    // The deleted message's text is gone from the text quota. Only the unshared file leaves the
    // attachment quota; the shared file stays for `second`.
    expect(await usageBytes(t)).toBe(before - new TextEncoder().encode("agentsee attached").length);
    expect(await attachmentBytes(t)).toBe(filesBefore - "own file".length);
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

  it("serves markup as a download and hardens file names", async () => {
    const t = await tenant();
    const svg = await (
      await upload(t, '<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>')
    ).json<Upload>();
    const html = await (await upload(t, "<script>alert(1)</script>")).json<Upload>();
    const sent = await (
      await send(t, [
        { id: svg.attachment.id, name: "x.svg", mediaType: "image/svg+xml" },
        { id: html.attachment.id, name: "it's (1)*.html", mediaType: "text/html" },
      ])
    ).json<{ message: Message }>();
    const file = (index: number) =>
      call(`${t.path}/channels/general/messages/${sent.message.id}/attachments/${index}`, t.token);
    const image = await file(0);
    expect(image.headers.get("Content-Type")).toBe("image/svg+xml");
    expect(image.headers.get("Content-Disposition")?.startsWith("attachment;")).toBe(true);
    expect(image.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(sent.message.attachments?.[0].previewUrl).toBeUndefined();
    expect(sent.message.attachments?.[0].mime).toBe("image/svg+xml");
    expect(image.headers.get("Content-Security-Policy")).toContain("default-src 'self'");
    const page = await file(1);
    expect(page.headers.get("Content-Type")).toBe("text/html");
    expect(page.headers.get("Content-Disposition")).toBe(
      `attachment; filename="it's (1)*.html"; filename*=UTF-8''it%27s%20%281%29%2A.html`,
    );
    // The name and the client type both say PNG. The bytes are HTML, so it is not an image.
    const disguised = await (
      await send(t, [{ id: html.attachment.id, name: "photo.png", mediaType: "image/png" }])
    ).json<{ message: Message }>();
    expect(disguised.message.attachments?.[0].mime).toBe("text/html");
    expect(disguised.message.attachments?.[0].previewUrl).toBeUndefined();
    const fake = await call(
      `${t.path}/channels/general/messages/${disguised.message.id}/attachments/0`,
      t.token,
    );
    expect(fake.headers.get("Content-Type")).toBe("text/html");
    expect(fake.headers.get("Content-Disposition")?.startsWith("attachment;")).toBe(true);
    // Bidirectional overrides could disguise an extension.
    const bidi = await send(t, [{ id: html.attachment.id, name: "report\u202Egpj.exe" }]);
    expect(bidi.status).toBe(400);
  });

  it("keeps uploads and downloads inside a channel-scoped key's channel", async () => {
    const tenantName = `scoped-${crypto.randomUUID()}`;
    const owner = await (
      await exports.default.fetch(`https://msn.test/api/tenants/${tenantName}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "owner" }),
      })
    ).json<{ token: string }>();
    const t = {
      name: tenantName,
      token: owner.token,
      path: `/api/tenants/${tenantName}`,
      admin: `/api/admin/tenants/${tenantName}`,
      stub: env.MSN_DURABLE_OBJECT.getByName(JSON.stringify(["tenant", tenantName])),
    };
    await call(`${t.path}/channels/secret`, t.token, { method: "PUT" });
    const secret = await (await upload(t, "private", "secret")).json<Upload>();
    const posted = await (
      await call(`${t.path}/channels/secret/messages`, t.token, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: "owner",
          text: "s",
          attachments: [{ id: secret.attachment.id, name: "s.txt" }],
        }),
      })
    ).json<{ message: Message }>();
    const invite = await (
      await call(`${t.path}/invites`, t.token, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channel: "general" }),
      })
    ).json<{ code: string }>();
    const guest = await (
      await call(`${t.path}/invites/redeem`, undefined, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: invite.code, username: "guest" }),
      })
    ).json<{ token: string; channel: string }>();
    expect(guest.channel).toBe("general");
    const scoped = { ...t, token: guest.token };
    expect((await upload(scoped, "x", "secret")).status).toBe(403);
    expect(
      (await call(`${t.path}/channels/secret/messages/${posted.message.id}/attachments/0`, guest.token))
        .status,
    ).toBe(403);
    expect((await upload(scoped, "allowed", "general")).status).toBe(201);
    const boundary = "bound";
    const denied = await call(`${t.path}/channels/secret/messages`, guest.token, {
      method: "POST",
      headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
      body: `--${boundary}\r\nContent-Disposition: form-data; name="username"\r\n\r\nguest\r\n--${boundary}\r\nContent-Disposition: form-data; name="text"\r\n\r\nhi\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.txt"\r\n\r\nno\r\n--${boundary}--\r\n`,
    });
    expect(denied.status).toBe(403);
  });

  it("accepts empty text when a file is attached and refuses it otherwise", async () => {
    const t = await tenant();
    const { attachment } = await (await upload(t, "log line\n")).json<Upload>();
    const sent = await send(t, [{ id: attachment.id, name: "run.log" }], undefined, "");
    expect(sent.status).toBe(201);
    const { message } = await sent.json<{ message: Message }>();
    expect(message.text).toBe("");
    expect(message.attachments?.[0].name).toBe("run.log");
    expect((await send(t, undefined, undefined, "")).status).toBe(400);
    expect((await send(t, undefined, undefined, "   ")).status).toBe(400);
  });

  it("serves a short-lived image link without a bearer and refuses a bad or missing one", async () => {
    const t = await tenant();
    const { attachment } = await (await upload(t, PNG)).json<Upload>();
    const sent = await (
      await send(t, [{ id: attachment.id, name: "shot.png", mediaType: "text/plain" }])
    ).json<{ message: Message }>();
    const file = sent.message.attachments?.[0];
    expect(file?.mime).toBe("image/png");
    expect(file?.width).toBe(1);
    expect(file?.height).toBe(1);
    expect(file?.previewUrl).toContain("sig=");
    const open = await call(file?.previewUrl ?? "");
    expect(open.status).toBe(200);
    expect(open.headers.get("Content-Type")).toBe("image/png");
    expect(open.headers.get("Content-Disposition")?.startsWith("inline;")).toBe(true);
    expect(open.headers.get("X-Content-Type-Options")).toBe("nosniff");
    const path = `${t.path}/channels/general/messages/${sent.message.id}/attachments/0`;
    expect((await call(path)).status).toBe(401);
    expect((await call((file?.previewUrl ?? "").replace(/sig=[^&]+/, "sig=00"))).status).toBe(401);
    expect((await call(`${path}?exp=1&sig=00`)).status).toBe(401);
    // A channel key still opens the file when the signature is missing or wrong.
    expect((await call(`${path}?exp=1`, t.token)).status).toBe(200);
    expect((await call(`${path}?sig=00`, t.token)).status).toBe(200);
    expect((await call(`${path}?exp=1&sig=00`, t.token)).status).toBe(200);
  });

  it("rejects a malformed image before storage and omits invalid legacy dimensions", async () => {
    const t = await tenant();
    const jpeg = new Uint8Array([
      0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x00, 0x00, 0x01, 0x01, 0x01, 0x11, 0x00, 0xff, 0xd9,
    ]);
    const rejected = await upload(t, jpeg);
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toMatchObject({ error: { code: "invalid_attachment" } });
    const orientedWebp = await upload(t, privateWebp(6));
    expect(orientedWebp.status).toBe(400);
    expect(await orientedWebp.json()).toMatchObject({ error: { code: "invalid_attachment" } });
    expect(await attachmentBytes(t)).toBe(0);
    expect((await env.ATTACHMENTS.list({ prefix: `${t.name}/` })).objects).toHaveLength(0);

    const { attachment } = await (await upload(t, PNG)).json<Upload>();
    const sent = await (await send(t, [{ id: attachment.id, name: "flat.png" }])).json<{
      message: Message;
    }>();
    expect(sent.message.attachments?.[0]).toMatchObject({ width: 1, height: 1 });
    await runInDurableObject(t.stub, (_instance, state) => {
      state.storage.sql.exec("UPDATE attachments SET width = 0, height = 1 WHERE id = ?", attachment.id);
    });
    const again = await (await call(`${t.path}/channels/general/messages/${sent.message.id}`, t.token)).json<{
      message: Message;
    }>();
    expect(again.message.attachments?.[0].width).toBeUndefined();
    expect(again.message.attachments?.[0].height).toBeUndefined();
  });

  it("sanitises every upload route before hashing, storing, accounting and signing", async () => {
    const t = await tenant();
    const { attachment } = await (await upload(t, privateJpeg(6))).json<Upload>();
    const duplicate = await upload(t, privateJpeg(6, "different-camera", false));
    expect(duplicate.status).toBe(200);
    expect((await duplicate.json<Upload>()).attachment.id).toBe(attachment.id);
    const other = await (await upload(t, privateJpeg(8))).json<Upload>();
    expect(other.attachment.id).not.toBe(attachment.id);
    const stored = await env.ATTACHMENTS.get(`${t.name}/general/${attachment.id}`);
    if (!stored) throw new Error("Sanitised R2 object missing");
    const bytes = new Uint8Array(await stored.arrayBuffer());
    expect(bytes.length).toBe(attachment.bytes);
    expect(new TextDecoder().decode(bytes)).not.toContain("private-camera-location");
    expect(await attachmentBytes(t)).toBe(attachment.bytes + other.attachment.bytes);

    const boundary = "image-boundary";
    const multipart = (path: string, fields: string) =>
      call(`${t.path}/channels/general/${path}`, t.token, {
        method: "POST",
        headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
        body: join(
          text(
            `${fields}--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="photo.jpg"\r\n\r\n`,
          ),
          privateJpeg(6, "third-camera"),
          text(`\r\n--${boundary}--\r\n`),
        ),
      });
    const uploaded = await multipart("attachments", "");
    expect(uploaded.status).toBe(201);
    expect(await uploaded.json()).toMatchObject({
      attachments: [{ id: attachment.id, bytes: attachment.bytes }],
    });
    const sent = await multipart(
      "messages",
      `--${boundary}\r\nContent-Disposition: form-data; name="username"\r\n\r\nagent\r\n`,
    );
    expect(sent.status).toBe(201);
    const { message } = await sent.json<{ message: Message }>();
    const file = message.attachments?.[0];
    expect(file).toMatchObject({
      id: attachment.id,
      width: 6,
      height: 8,
      mime: "image/jpeg",
      size: attachment.bytes,
    });
    const downloaded = await call(file?.previewUrl ?? "");
    expect(downloaded.status).toBe(200);
    expect(new Uint8Array(await downloaded.arrayBuffer())).toEqual(bytes);
    expect(await attachmentBytes(t)).toBe(attachment.bytes + other.attachment.bytes);
  });

  it("accepts an actual 25 MiB image and accounts only for the sanitised bytes", async () => {
    const t = await tenant();
    const response = await upload(t, maxSizePng());
    expect(response.status).toBe(201);
    const { attachment } = await response.json<Upload>();
    expect(attachment.bytes).toBeLessThan(25 * MiB);
    expect(attachment.bytes).toBeGreaterThan(24 * MiB);
    expect(await attachmentBytes(t)).toBe(attachment.bytes);
  }, 60_000);

  it("downloads a replayed preview and an expired signature falls back to the channel key", async () => {
    const t = await tenant();
    const { attachment } = await (await upload(t, PNG)).json<Upload>();
    const refs = [{ id: attachment.id, name: "shot.png" }];
    const created = await (await send(t, refs, "again")).json<{ message: Message }>();
    const replay = await (await send(t, refs, "again")).json<{ message: Message; replayed: boolean }>();
    expect(replay.replayed).toBe(true);
    const preview = replay.message.attachments?.[0].previewUrl ?? "";
    expect((await call(preview)).status).toBe(200);
    const secret = new Uint8Array(
      (await runInDurableObject(t.stub, (_instance, state) =>
        Array.from(
          new Uint8Array(
            state.storage.sql.exec<{ secret: ArrayBuffer }>("SELECT secret FROM attachment_signing").one()
              .secret,
          ),
        ),
      )) as number[],
    );
    const exp = Date.now() - 60_000;
    const sig = hex(
      hmacSha256(
        secret,
        new TextEncoder().encode(previewPayload(t.name, "general", created.message.id, 0, exp)),
      ),
    );
    const path = `${t.path}/channels/general/messages/${created.message.id}/attachments/0?exp=${exp}&sig=${sig}`;
    expect((await call(path)).status).toBe(401);
    const withKey = await call(path, t.token);
    expect(withKey.status).toBe(200);
    expect(withKey.headers.get("Content-Length")).toBe(String(PNG.byteLength));
    expect(withKey.headers.get("Content-Type")).toBe("image/png");
  });

  it("removes the R2 object when an upload expires, a message is deleted, or the board is deleted", async () => {
    const t = await tenant();
    const orphan = await (await upload(t, "orphan-bytes")).json<Upload>();
    const kept = await (await upload(t, "kept-bytes")).json<Upload>();
    await send(t, [{ id: kept.attachment.id, name: "kept.txt" }]);
    await runInDurableObject(t.stub, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE attachments SET createdAt = ? WHERE id = ?",
        "2000-01-01T00:00:00.000Z",
        orphan.attachment.id,
      );
    });
    await upload(t, "trigger-sweep");
    expect(await env.ATTACHMENTS.get(`${t.name}/general/${orphan.attachment.id}`)).toBeNull();
    expect(await env.ATTACHMENTS.get(`${t.name}/general/${kept.attachment.id}`)).not.toBeNull();

    const own = await (await upload(t, "own-bytes")).json<Upload>();
    const posted = await (await send(t, [{ id: own.attachment.id, name: "own.txt" }])).json<{
      message: Message;
    }>();
    expect(
      (await call(`${t.admin}/channels/general/messages/${posted.message.id}`, ADMIN, { method: "DELETE" }))
        .status,
    ).toBe(204);
    expect(await env.ATTACHMENTS.get(`${t.name}/general/${own.attachment.id}`)).toBeNull();
    expect(await env.ATTACHMENTS.get(`${t.name}/general/${kept.attachment.id}`)).not.toBeNull();

    await call(`${t.path}/channels/side`, t.token, { method: "PUT" });
    const side = await (await upload(t, "side-bytes", "side")).json<Upload>();
    await call(`${t.path}/channels/side/messages`, t.token, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "agent",
        text: "there",
        attachments: [{ id: side.attachment.id, name: "side.txt" }],
      }),
    });
    expect((await call(`${t.path}/channels/side?confirm=side`, t.token, { method: "DELETE" })).status).toBe(
      200,
    );
    expect(await env.ATTACHMENTS.get(`${t.name}/side/${side.attachment.id}`)).toBeNull();
    const leftover = await runInDurableObject(
      t.stub,
      (_instance, state) =>
        state.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM attachment_gc").one().count,
    );
    expect(leftover).toBe(0);
  });

  it("sends a multipart message, rejects an unknown field, and keeps an earlier file when a later one is bad", async () => {
    const t = await tenant();
    const boundary = "bound";
    const part = (name: string, value: string, filename?: string) =>
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"${filename ? `; filename="${filename}"` : ""}\r\n\r\n${value}\r\n`;
    const post = (body: string) =>
      call(`${t.path}/channels/general/messages`, t.token, {
        method: "POST",
        headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
        body,
      });
    const ok = await post(
      `${part("text", "see this")}${part("file", "hello", "note.txt")}${part("username", "ada")}--${boundary}--\r\n`,
    );
    expect(ok.status).toBe(201);
    const { message } = await ok.json<{ message: Message }>();
    expect(message.username).toBe("ada");
    expect(message.text).toBe("see this");
    expect(message.attachments?.[0]).toMatchObject({ name: "note.txt", mime: "text/plain", size: 5 });
    const downloaded = await call(`${t.path}/channels/general/messages/${message.id}/attachments/0`, t.token);
    expect(await downloaded.text()).toBe("hello");

    const before = await attachmentBytes(t);
    const unknown = await post(
      `${part("username", "ada")}${part("extra", "nope")}${part("file", "no", "a.txt")}--${boundary}--\r\n`,
    );
    expect(unknown.status).toBe(400);
    expect(((await unknown.json()) as { error: { code: string } }).error.code).toBe("invalid_attachment");
    expect(await attachmentBytes(t)).toBe(before);

    const badSecond = await post(
      `${part("username", "ada")}${part("text", "x")}${part("file", "first", "ok.txt")}${part("file", "second", "../no.txt")}--${boundary}--\r\n`,
    );
    expect(badSecond.status).toBe(400);
    const orphans = await runInDurableObject(t.stub, (_instance, state) =>
      state.storage.sql
        .exec<{ id: string }>(
          `SELECT a.id FROM attachments a
           WHERE NOT EXISTS (SELECT 1 FROM message_attachments r WHERE r.channel = a.channel AND r.attachmentId = a.id)`,
        )
        .toArray(),
    );
    expect(orphans.length).toBe(1);

    expect((await call(`${t.path}/channels/general/archive`, t.token, { method: "PUT" })).status).toBe(200);
    const archived = await post(
      `${part("username", "ada")}${part("text", "later")}${part("file", "z", "z.txt")}--${boundary}--\r\n`,
    );
    expect(archived.status).toBe(409);
  });

  it("accepts a 25 MB multipart file and refuses one more byte", async () => {
    const t = await tenant();
    const boundary = "Bb";
    const head = new TextEncoder().encode(
      `--${boundary}\r\nContent-Disposition: form-data; name="username"\r\n\r\nagent\r\n--${boundary}\r\nContent-Disposition: form-data; name="text"\r\n\r\nok\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="big.bin"\r\n\r\n`,
    );
    const tail = new TextEncoder().encode(`\r\n--${boundary}--\r\n`);
    const pack = (n: number) => {
      const body = new Uint8Array(head.length + n + tail.length);
      body.set(head);
      body.set(tail, head.length + n);
      return body;
    };
    const exact = await call(`${t.path}/channels/general/messages`, t.token, {
      method: "POST",
      headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
      body: pack(25 * MiB),
    });
    expect(exact.status).toBe(201);
    const over = await call(`${t.path}/channels/general/messages`, t.token, {
      method: "POST",
      headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
      body: pack(25 * MiB + 1),
    });
    expect(over.status).toBe(413);
    expect(((await over.json()) as { error: { code: string } }).error.code).toBe("attachment_too_large");
  }, 60_000);

  it("stores two large uploads one at a time and lets only one through when the quota fits one", async () => {
    const t = await tenant();
    const size = 8 * MiB;
    const [first, second] = await Promise.all([
      upload(t, new Uint8Array(size)),
      upload(t, new Uint8Array(size).fill(1)),
    ]);
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(await attachmentBytes(t)).toBe(size * 2);

    await runInDurableObject(t.stub, (_instance, state) => {
      state.storage.sql.exec("UPDATE usage SET attachmentBytes = ?", 1024 * MiB - 15);
    });
    const [nearA, nearB] = await Promise.all([upload(t, "0123456789"), upload(t, "abcdefghij")]);
    expect([nearA.status, nearB.status].sort()).toEqual([201, 409]);
    expect(await attachmentBytes(t)).toBe(1024 * MiB - 5);
  }, 60_000);

  it("keeps empty text out of the text quota and out of word search", async () => {
    const t = await tenant();
    const before = await usageBytes(t);
    const { attachment } = await (await upload(t, "log line\n")).json<Upload>();
    const sent = await send(t, [{ id: attachment.id, name: "run.log" }], undefined, "");
    expect(sent.status).toBe(201);
    expect(await usageBytes(t)).toBe(before + new TextEncoder().encode("agent").length);
    const found = await (await call(`${t.path}/channels/general/search?q=log`, t.token)).json<{
      messages: Message[];
    }>();
    expect(found.messages).toEqual([]);
  });

  it("sniffs a legacy sqlite row the first time it is downloaded", async () => {
    const t = await tenant();
    const posted = await (
      await call(`${t.path}/channels/general/messages`, t.token, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "agent", text: "old" }),
      })
    ).json<{ message: Message }>();
    const id = "ab".repeat(32);
    const html = new TextEncoder().encode("<script>alert(1)</script>");
    await runInDurableObject(t.stub, (_instance, state) => {
      state.storage.sql.exec(
        "INSERT INTO attachments(channel, id, bytes, createdAt, data, sha, mime, backend) VALUES (?, ?, ?, ?, ?, ?, NULL, 'sqlite')",
        "general",
        id,
        html.byteLength,
        new Date().toISOString(),
        html,
        id,
      );
      state.storage.sql.exec(
        "INSERT INTO message_attachments(messageId, position, channel, attachmentId, name, mediaType) VALUES (?, 0, 'general', ?, 'photo.png', 'image/png')",
        posted.message.id,
        id,
      );
    });
    const file = await call(
      `${t.path}/channels/general/messages/${posted.message.id}/attachments/0`,
      t.token,
    );
    expect(file.status).toBe(200);
    expect(file.headers.get("Content-Type")).toBe("text/html");
    expect(file.headers.get("Content-Disposition")?.startsWith("attachment;")).toBe(true);
    const stored = await runInDurableObject(
      t.stub,
      (_instance, state) =>
        state.storage.sql.exec<{ mime: string }>("SELECT mime FROM attachments WHERE id = ?", id).one().mime,
    );
    expect(stored).toBe("text/html");
  });
});
