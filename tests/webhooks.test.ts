import { runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { ALARM_FAILURE_BACKOFF_MS, type MsnDurableObject } from "../src/store";
import {
  MAX_PENDING_NOTICES,
  postNotice,
  privateHost,
  signNotice,
  WEBHOOK_RETRY_DELAYS_MS,
  webhookUrl,
} from "../src/webhook";

// Wake an agent with a webhook (ADR 0062): the owner registers an https URL for a board persona,
// and a message addressed to that persona makes the Durable Object POST a small signed notice.

const call = (tenant: string, suffix = "", token?: string, method = "GET", input?: unknown) =>
  exports.default.fetch(`https://msn.test/api/tenants/${tenant}${suffix}`, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json" },
    ...(input ? { body: JSON.stringify(input) } : {}),
  });

type Sent = { url: string; headers: Headers; body: string; redirect?: string; signal?: AbortSignal };
type Hook = {
  persona: string;
  url: string;
  pending: number;
  lastDelivery: {
    status: string;
    noticeId: string;
    httpStatus: number | null;
    error: string | null;
    deliveredAt: string | null;
  } | null;
};

async function fixture() {
  const tenant = `hook-${crypto.randomUUID()}`;
  const owner = (
    await (await call(tenant, "", undefined, "PUT", { username: "human" })).json<{ token: string }>()
  ).token;
  const agent = "b".repeat(64);
  expect(
    (await call(tenant, "/channels/work/board", owner, "PUT", { credential: agent, goal: "Ship it" })).status,
  ).toBe(201);
  for (const [id, name] of [
    ["lead", "lead"],
    ["rev", "reviewer"],
  ])
    expect(
      (await call(tenant, `/channels/work/personas/${id}`, agent, "PUT", { displayName: name })).status,
    ).toBe(201);
  const sent: Sent[] = [];
  let answer: () => Promise<Response> | Response = () => new Response("ok");
  const stub = env.MSN_DURABLE_OBJECT.getByName(JSON.stringify(["tenant", tenant]));
  await runInDurableObject(stub, (instance: MsnDurableObject) => {
    instance.webhookFetch = async (input, init) => {
      sent.push({
        url: String(input),
        headers: new Headers(init?.headers),
        body: String(init?.body),
        redirect: init?.redirect,
        signal: init?.signal ?? undefined,
      });
      return answer();
    };
  });
  const register = async (persona = "rev", url = "https://agent.example.com/wake") => {
    const response = await call(tenant, `/channels/work/personas/${persona}/webhook`, owner, "PUT", { url });
    return { status: response.status, ...(await response.json<{ webhook: Hook; secret: string }>()) };
  };
  const hook = async (persona = "rev") =>
    (
      await (
        await call(tenant, `/channels/work/personas/${persona}/webhook`, owner)
      ).json<{ webhook: Hook }>()
    ).webhook;
  /** Runs the delivery step now, as the alarm does, after moving every waiting notice to due. */
  const deliver = () =>
    runInDurableObject(stub, async (instance: MsnDurableObject, state) => {
      state.storage.sql.exec("UPDATE webhook_notices SET nextAttemptMs = 0");
      return instance.sendDueNotices();
    });
  const waiting = () =>
    runInDurableObject(
      stub,
      (_: MsnDurableObject, state) =>
        state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM webhook_notices").one().n,
    );
  return {
    tenant,
    owner,
    agent,
    sent,
    stub,
    register,
    hook,
    deliver,
    waiting,
    answerWith: (next: () => Promise<Response> | Response) => {
      answer = next;
    },
  };
}

const say = (
  f: { tenant: string; agent: string },
  text: string,
  extra: Record<string, unknown> = {},
  username = "lead",
) => call(f.tenant, "/channels/work/messages", f.agent, "POST", { username, text, ...extra });

describe("webhook URLs", () => {
  it("accepts public https hosts only", () => {
    expect(webhookUrl("https://agent.example.com/wake?x=1", ["msn.test"])).toBe(
      "https://agent.example.com/wake?x=1",
    );
    expect(webhookUrl("https://AGENT.example.com:443/w", ["msn.test"])).toBe("https://agent.example.com/w");
    const refused: [string, string][] = [
      ["http://agent.example.com/wake", "webhook_https_required"],
      ["ftp://agent.example.com/wake", "webhook_https_required"],
      ["https://localhost/wake", "webhook_host_refused"],
      ["https://box.localhost/wake", "webhook_host_refused"],
      ["https://printer.local/wake", "webhook_host_refused"],
      ["https://api.internal/wake", "webhook_host_refused"],
      ["https://intranet/wake", "webhook_host_refused"],
      ["https://127.0.0.1/wake", "webhook_host_refused"],
      ["https://2130706433/wake", "webhook_host_refused"],
      ["https://0x7f.1/wake", "webhook_host_refused"],
      ["https://10.1.2.3/wake", "webhook_host_refused"],
      ["https://172.20.0.1/wake", "webhook_host_refused"],
      ["https://192.168.1.10/wake", "webhook_host_refused"],
      ["https://169.254.169.254/latest/meta-data", "webhook_host_refused"],
      ["https://100.64.0.1/wake", "webhook_host_refused"],
      ["https://0.0.0.0/wake", "webhook_host_refused"],
      ["https://[::1]/wake", "webhook_host_refused"],
      ["https://[::]/wake", "webhook_host_refused"],
      ["https://[::ffff:127.0.0.1]/wake", "webhook_host_refused"],
      ["https://[fd00::1]/wake", "webhook_host_refused"],
      ["https://[fe80::1]/wake", "webhook_host_refused"],
      ["https://[2001:db8::1]/wake", "webhook_host_refused"],
      ["https://msn.test/api/x", "webhook_host_refused"],
      ["https://msn.test./api/x", "webhook_host_refused"],
      ["https://MSN.EXAMPLE.ORG./api/x", "webhook_host_refused"],
      ["https://msn.someone.workers.dev/api/x", "webhook_host_refused"],
      ["https://[2002:a00:1::1]/wake", "webhook_host_refused"],
      ["https://[2001:0:4136:e378::1]/wake", "webhook_host_refused"],
      ["https://[2001::1]/wake", "webhook_host_refused"],
      ["https://agent.example.com:8443/wake", "webhook_port_refused"],
      ["https://user:pw@agent.example.com/wake", "invalid_webhook"],
      ["https://agent.example.com/wake#frag", "invalid_webhook"],
      ["not a url", "invalid_webhook"],
      [`https://agent.example.com/${"a".repeat(2100)}`, "invalid_webhook"],
    ];
    for (const [url, code] of refused) {
      let thrown: unknown;
      try {
        webhookUrl(url, ["msn.test", "msn.example.org"]);
      } catch (error) {
        thrown = error;
      }
      expect((thrown as { code?: string })?.code, url).toBe(code);
    }
    expect(privateHost("8.8.8.8")).toBe(false);
    expect(privateHost("[2606:4700::1111]")).toBe(false);
    expect(privateHost("[2001:4860:4860::8888]")).toBe(false);
    // A receiver on someone's own workers.dev Worker is fine.
    expect(webhookUrl("https://agent.someone.workers.dev/wake", ["msn.test"])).toBe(
      "https://agent.someone.workers.dev/wake",
    );
  });

  it("signs notices so a receiver can check them, and never follows redirects", async () => {
    const seen: RequestInit[] = [];
    const fetcher = (async (_url: string, init: RequestInit) => {
      seen.push(init);
      return new Response(null, { status: 302, headers: { Location: "https://elsewhere.example.com" } });
    }) as unknown as typeof fetch;
    const attempt = await postNotice(
      "https://a.example.com/",
      "whsec_x",
      '{"a":1}',
      "n1",
      fetcher,
      1_700_000_000_000,
    );
    expect(attempt).toEqual({ ok: false, retry: false, httpStatus: 302, error: "redirect_refused" });
    const headers = new Headers(seen[0].headers);
    expect(seen[0].redirect).toBe("manual");
    expect(seen[0].signal).toBeInstanceOf(AbortSignal);
    expect(headers.get("MSN-Webhook-Timestamp")).toBe("1700000000");
    expect(headers.get("MSN-Webhook-Id")).toBe("n1");
    // Independent HMAC: Web Crypto over "timestamp.body" with the whole secret string as the key.
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode("whsec_x"),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const hex = headers.get("MSN-Webhook-Signature")?.replace(/^v1=/, "") ?? "";
    const mac = Uint8Array.from(hex.match(/../g) ?? [], (h) => Number.parseInt(h, 16));
    expect(await crypto.subtle.verify("HMAC", key, mac, new TextEncoder().encode('1700000000.{"a":1}'))).toBe(
      true,
    );
    expect(await signNotice("whsec_x", 1700000000, '{"a":1}')).toBe(hex);
    const failing = (async () => {
      throw new TypeError("connect failed");
    }) as unknown as typeof fetch;
    expect(await postNotice("https://a.example.com/", "s", "{}", "n2", failing)).toEqual({
      ok: false,
      retry: true,
      httpStatus: null,
      error: "network_error",
    });
    const slow = (async () => {
      throw new DOMException("timed out", "TimeoutError");
    }) as unknown as typeof fetch;
    expect(
      (await postNotice("https://a.example.com/", "s", "{}", "n3", slow)) as { error: string },
    ).toMatchObject({ error: "timeout", retry: true });
  });
});

describe("persona webhooks", () => {
  it("only the owner sets, reads and removes a webhook; the secret is shown once", async () => {
    const f = await fixture();
    const path = "/channels/work/personas/rev/webhook";
    expect((await call(f.tenant, path, f.agent, "PUT", { url: "https://agent.example.com/w" })).status).toBe(
      403,
    );
    expect((await call(f.tenant, path, f.agent)).status).toBe(403);
    expect((await call(f.tenant, path, f.owner)).status).toBe(404);
    expect(
      (
        await call(f.tenant, "/channels/work/personas/ghost/webhook", f.owner, "PUT", {
          url: "https://agent.example.com/w",
        })
      ).status,
    ).toBe(404);
    const refused = await call(f.tenant, path, f.owner, "PUT", { url: "http://127.0.0.1/w" });
    expect(refused.status).toBe(400);
    const made = await f.register();
    expect(made.status).toBe(201);
    expect(made.secret).toMatch(/^whsec_[0-9a-f]{64}$/);
    expect(made.webhook).toMatchObject({ persona: "rev", url: "https://agent.example.com/wake", pending: 0 });
    const read = await (await call(f.tenant, path, f.owner)).text();
    expect(read).not.toContain(made.secret);
    expect(read).not.toContain("whsec_");
    const list = await (await call(f.tenant, "/channels/work/webhooks", f.owner)).json<{
      webhooks: Hook[];
    }>();
    expect(list.webhooks.map((w) => w.persona)).toEqual(["rev"]);
    expect((await call(f.tenant, "/channels/work/webhooks", f.agent)).status).toBe(403);
    const again = await f.register("rev", "https://other.example.com/wake");
    expect(again.status).toBe(200);
    expect(again.secret).not.toBe(made.secret);
    expect(again.webhook.url).toBe("https://other.example.com/wake");
    expect((await call(f.tenant, path, f.agent, "DELETE")).status).toBe(403);
    expect((await call(f.tenant, path, f.owner, "DELETE")).status).toBe(204);
    expect((await call(f.tenant, path, f.owner)).status).toBe(404);
  });

  it("wakes the addressed persona with a signed notice that holds ids, never text", async () => {
    const f = await fixture();
    const { secret } = await f.register();
    const sentMessage = await (await say(f, "please review the secret plan", { to: "reviewer" })).json<{
      message: { id: number };
    }>();
    // The alarm sends it on its own; no request waits for it.
    await vi.waitFor(() => expect(f.sent).toHaveLength(1), { timeout: 5000 });
    const [notice] = f.sent;
    expect(notice.url).toBe("https://agent.example.com/wake");
    expect(notice.redirect).toBe("manual");
    expect(notice.body).not.toContain("secret plan");
    expect(notice.body).not.toContain(f.agent);
    expect(notice.body).not.toContain(secret);
    expect(new TextEncoder().encode(notice.body).length).toBeLessThanOrEqual(1024);
    const body = JSON.parse(notice.body);
    expect(body).toMatchObject({
      schema: "msn.webhook.v1",
      type: "message.addressed",
      tenant: f.tenant,
      channel: "work",
      persona: "rev",
      messageId: sentMessage.message.id,
      messageUrl: `https://msn.test/api/tenants/${f.tenant}/channels/work/messages/${sentMessage.message.id}`,
    });
    expect(notice.headers.get("MSN-Webhook-Id")).toBe(body.id);
    const timestamp = Number(notice.headers.get("MSN-Webhook-Timestamp"));
    expect(Math.abs(timestamp - Date.now() / 1000)).toBeLessThan(60);
    expect(notice.headers.get("MSN-Webhook-Signature")).toBe(
      `v1=${await signNotice(secret, timestamp, notice.body)}`,
    );
    // The event id is the board journal entry for this message.
    const events = await (await call(f.tenant, "/events?after=0", f.agent)).json<{
      events: { id: number; type: string; resourceId: number }[];
    }>();
    expect(events.events.find((e) => e.id === body.eventId)).toMatchObject({
      type: "message.created",
      resourceId: sentMessage.message.id,
    });
    // The woken agent reads the message with its own key.
    const read = await exports.default.fetch(body.messageUrl, {
      headers: { Authorization: `Bearer ${f.agent}` },
    });
    expect(read.status).toBe(200);
    expect(await read.text()).toContain("secret plan");
    await vi.waitFor(async () => expect((await f.hook()).lastDelivery?.status).toBe("delivered"));
    const hook = await f.hook();
    expect(hook).toMatchObject({
      pending: 0,
      lastDelivery: { noticeId: body.id, httpStatus: 200, error: null },
    });
    expect(hook.lastDelivery?.deliveredAt).toBeTruthy();
  });

  it("sends nothing for unaddressed messages, other personas or the persona's own messages", async () => {
    const f = await fixture();
    await f.register();
    expect((await say(f, "to nobody")).status).toBe(201);
    expect((await say(f, "to the lead", { to: "lead" })).status).toBe(201);
    expect((await say(f, "note to self", { to: "reviewer" }, "reviewer")).status).toBe(201);
    expect((await say(f, "unknown name", { to: "review" })).status).toBe(201);
    expect((await say(f, "self, other case", { to: " Reviewer " }, "reviewer")).status).toBe(201);
    expect(await f.waiting()).toBe(0);
    expect(await f.deliver()).toBe(0);
    expect(f.sent).toHaveLength(0);
    // An idempotent retry of an addressed send does not queue a second notice.
    for (let n = 0; n < 2; n++)
      expect(
        (
          await exports.default.fetch(`https://msn.test/api/tenants/${f.tenant}/channels/work/messages`, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${f.agent}`,
              "Content-Type": "application/json",
              "Idempotency-Key": "wake-once",
            },
            body: JSON.stringify({ username: "lead", text: "once", to: "reviewer" }),
          })
        ).status,
      ).toBe(n ? 200 : 201);
    await vi.waitFor(() => expect(f.sent).toHaveLength(1));
    expect(await f.deliver()).toBe(0);
    expect(f.sent).toHaveLength(1);
  });

  it("matches the addressed name trimmed and ignoring case", async () => {
    const f = await fixture();
    await f.register();
    expect((await say(f, "case", { to: " Reviewer " })).status).toBe(201);
    await vi.waitFor(() => expect(f.sent).toHaveLength(1));
    expect(JSON.parse(f.sent[0].body).persona).toBe("rev");
  });

  it("an exact name wins over a name that differs only in case, and other-case senders still wake it", async () => {
    const f = await fixture();
    expect(
      (await call(f.tenant, "/channels/work/personas/rev2", f.agent, "PUT", { displayName: "Reviewer" }))
        .status,
    ).toBe(201);
    await f.register("rev");
    await f.register("rev2", "https://other.example.com/wake");
    expect((await say(f, "to the lower one", { to: "reviewer" })).status).toBe(201);
    await vi.waitFor(() => expect(f.sent).toHaveLength(1));
    expect(JSON.parse(f.sent[0].body).persona).toBe("rev");
    expect((await say(f, "to the upper one", { to: "Reviewer" })).status).toBe(201);
    await vi.waitFor(() => expect(f.sent).toHaveLength(2));
    expect(JSON.parse(f.sent[1].body).persona).toBe("rev2");
    // "Reviewer" writing to "reviewer" is someone else, so it wakes "reviewer".
    expect((await say(f, "from the upper one", { to: "reviewer" }, "Reviewer")).status).toBe(201);
    await vi.waitFor(() => expect(f.sent).toHaveLength(3));
    expect(JSON.parse(f.sent[2].body).persona).toBe("rev");
  });

  it("an owner key reset removes every webhook and waiting notice", async () => {
    const f = await fixture();
    f.answerWith(() => new Response(null, { status: 500 }));
    await f.register();
    await say(f, "wake", { to: "reviewer" });
    await vi.waitFor(async () => expect((await f.hook()).lastDelivery?.status).toBe("retrying"));
    const reset = await exports.default.fetch(`https://msn.test/api/admin/tenants/${f.tenant}/token`, {
      method: "POST",
      headers: { Authorization: "Bearer test-admin-secret-000000000000000000000" },
    });
    expect(reset.status).toBe(200);
    const { token } = await reset.json<{ token: string }>();
    expect(await f.waiting()).toBe(0);
    const list = await (await call(f.tenant, "/channels/work/webhooks", token)).json<{ webhooks: Hook[] }>();
    expect(list.webhooks).toEqual([]);
  });

  it("an alarm run in which a job throws waits before the next run", async () => {
    const f = await fixture();
    f.answerWith(() => new Response(null, { status: 500 }));
    await f.register();
    await say(f, "wake", { to: "reviewer" });
    await vi.waitFor(async () => expect((await f.hook()).lastDelivery?.status).toBe("retrying"));
    const next = await runInDurableObject(f.stub, async (instance: MsnDurableObject, state) => {
      state.storage.sql.exec("UPDATE webhook_notices SET nextAttemptMs = 0");
      instance.sendDueNotices = async () => {
        throw new Error("boom");
      };
      const before = Date.now();
      await instance.alarm();
      return { before, alarm: await state.storage.getAlarm() };
    });
    expect(next.alarm).not.toBeNull();
    expect((next.alarm as number) - next.before).toBeGreaterThanOrEqual(ALARM_FAILURE_BACKOFF_MS - 50);
  });

  it("setting, testing or removing a webhook on an archived board is refused until unarchived", async () => {
    const f = await fixture();
    await f.register();
    expect((await call(f.tenant, "/channels/work/archive", f.owner, "PUT")).status).toBe(200);
    const path = "/channels/work/personas/rev/webhook";
    for (const [method, suffix, input] of [
      ["PUT", "", { url: "https://agent.example.com/x" }],
      ["POST", "/test", undefined],
      ["DELETE", "", undefined],
    ] as const)
      expect((await call(f.tenant, path + suffix, f.owner, method, input)).status, method).toBe(409);
    expect((await call(f.tenant, path, f.owner)).status).toBe(200);
  });

  it("retries failures with backoff, records the outcome, and gives up after five attempts", async () => {
    const f = await fixture();
    // Hold the alarm's own run back, so this test drives every attempt.
    f.answerWith(() => new Response("busy", { status: 503 }));
    await f.register();
    await say(f, "wake up", { to: "reviewer" });
    await vi.waitFor(() => expect(f.sent.length).toBeGreaterThanOrEqual(1));
    await vi.waitFor(async () => expect((await f.hook()).lastDelivery?.status).toBe("retrying"));
    expect((await f.hook()).lastDelivery).toMatchObject({ httpStatus: 503, error: "http_503" });
    // The next attempt waits for the first retry delay.
    const next = await runInDurableObject(f.stub, (_: MsnDurableObject, state) =>
      state.storage.sql
        .exec<{ nextAttemptMs: number; attempts: number }>(
          "SELECT nextAttemptMs, attempts FROM webhook_notices",
        )
        .one(),
    );
    expect(next.attempts).toBe(1);
    expect(next.nextAttemptMs - Date.now()).toBeGreaterThan(WEBHOOK_RETRY_DELAYS_MS[0] - 5000);
    for (let attempt = 2; attempt <= 5; attempt++) expect(await f.deliver()).toBe(1);
    expect(f.sent).toHaveLength(5);
    expect(new Set(f.sent.map((s) => s.headers.get("MSN-Webhook-Id"))).size).toBe(1);
    expect(await f.waiting()).toBe(0);
    expect((await f.hook()).lastDelivery).toMatchObject({ status: "failed", httpStatus: 503 });
    expect(await f.deliver()).toBe(0);
  });

  it("does not retry a refusal, and a later success is recorded", async () => {
    const f = await fixture();
    f.answerWith(() => new Response(null, { status: 401 }));
    await f.register();
    await say(f, "first", { to: "reviewer" });
    await vi.waitFor(async () => expect((await f.hook()).lastDelivery?.status).toBe("failed"));
    expect((await f.hook()).lastDelivery).toMatchObject({ httpStatus: 401, error: "http_401" });
    expect(await f.waiting()).toBe(0);
    f.answerWith(() => {
      throw new TypeError("connect failed");
    });
    await say(f, "second", { to: "reviewer" });
    await vi.waitFor(async () => expect((await f.hook()).lastDelivery?.error).toBe("network_error"));
    expect((await f.hook()).lastDelivery?.status).toBe("retrying");
    f.answerWith(() => new Response(null, { status: 204 }));
    expect(await f.deliver()).toBe(1);
    expect((await f.hook()).lastDelivery).toMatchObject({
      status: "delivered",
      httpStatus: 204,
      error: null,
    });
  });

  it("removing a webhook drops its waiting notices", async () => {
    const f = await fixture();
    f.answerWith(() => new Response(null, { status: 500 }));
    await f.register();
    await say(f, "wake", { to: "reviewer" });
    await vi.waitFor(async () => expect((await f.hook()).lastDelivery?.status).toBe("retrying"));
    expect(await f.waiting()).toBe(1);
    expect((await call(f.tenant, "/channels/work/personas/rev/webhook", f.owner, "DELETE")).status).toBe(204);
    expect(await f.waiting()).toBe(0);
    await say(f, "wake again", { to: "reviewer" });
    expect(await f.waiting()).toBe(0);
  });

  it("queues a test ping and caps the backlog", async () => {
    const f = await fixture();
    await f.register();
    expect((await call(f.tenant, "/channels/work/personas/rev/webhook/test", f.agent, "POST")).status).toBe(
      403,
    );
    const ping = await call(f.tenant, "/channels/work/personas/rev/webhook/test", f.owner, "POST");
    expect(ping.status).toBe(202);
    const { noticeId } = await ping.json<{ noticeId: string }>();
    await vi.waitFor(() => expect(f.sent).toHaveLength(1));
    expect(JSON.parse(f.sent[0].body)).toMatchObject({
      type: "ping",
      id: noticeId,
      tenant: f.tenant,
      channel: "work",
      persona: "rev",
      messageId: null,
      eventId: null,
      messageUrl: null,
    });
    // A receiver that never answers: notices wait, and past the cap new ones are dropped.
    f.answerWith(() => new Response(null, { status: 500 }));
    await runInDurableObject(f.stub, (_: MsnDurableObject, state) => {
      for (let n = 0; n < MAX_PENDING_NOTICES; n++)
        state.storage.sql.exec(
          "INSERT INTO webhook_notices(id, channel, personaId, body, attempts, nextAttemptMs, createdAt) VALUES (?, 'work', 'rev', '{}', 0, ?, ?)",
          `filler-${n}`,
          Date.now() + 3_600_000,
          new Date().toISOString(),
        );
    });
    const sentBefore = f.sent.length;
    expect((await say(f, "one too many", { to: "reviewer" })).status).toBe(201);
    expect(await f.waiting()).toBe(MAX_PENDING_NOTICES);
    expect((await f.hook()).lastDelivery).toMatchObject({ status: "dropped", error: "backlog_full" });
    expect((await call(f.tenant, "/channels/work/personas/rev/webhook/test", f.owner, "POST")).status).toBe(
      409,
    );
    expect(f.sent.length).toBe(sentBefore);
  });

  it("watch-only keys and plain channels cannot set webhooks", async () => {
    const f = await fixture();
    const plain = await call(f.tenant, "/channels/general/webhooks", f.owner);
    expect(plain.status).toBe(404);
    const invite = await (
      await call(f.tenant, "/invites", f.owner, "POST", { channel: "work", watch: true, uses: 1 })
    ).json<{ code: string }>();
    const watcher = await (
      await call(f.tenant, "/invites/redeem", undefined, "POST", { code: invite.code, username: "viewer" })
    ).json<{ token: string }>();
    expect(watcher.token).toBeTruthy();
    expect(
      (
        await call(f.tenant, "/channels/work/personas/rev/webhook", watcher.token, "PUT", {
          url: "https://agent.example.com/w",
        })
      ).status,
    ).toBe(403);
  });
});
