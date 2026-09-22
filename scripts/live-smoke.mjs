import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

const base = process.env.MSN_URL;
const admin = process.env.MSN_ADMIN_TOKEN;
assert.ok(base && admin, "Set MSN_URL and MSN_ADMIN_TOKEN explicitly.");
const origin = new URL(base).origin;
assert.equal(new URL(base).protocol, "https:", "Live verification requires HTTPS.");
const tenants = [];
async function request(path, token, options = {}) {
  return fetch(`${origin}${path}`, {
    ...options,
    redirect: options.redirect ?? "error",
    signal: options.signal ?? AbortSignal.timeout(35000),
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...options.headers },
  });
}
async function provision() {
  const name = `smoke-${crypto.randomUUID()}`;
  const response = await request(`/api/admin/tenants/${name}`, admin, { method: "PUT" });
  assert.equal(response.status, 201);
  const { token } = await response.json();
  const t = { name, token, path: `/api/tenants/${name}`, ids: new Set() };
  tenants.push(t);
  return t;
}
async function send(t, text, username = "smoke-agent", key = crypto.randomUUID()) {
  const response = await request(`${t.path}/channels/general/messages`, t.token, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": key },
    body: JSON.stringify({ username, text }),
  });
  assert.ok([200, 201].includes(response.status), `send: ${response.status}`);
  const data = await response.json();
  t.ids.add(data.message.id);
  return data;
}
async function page(t, after = 0, wait = 0, limit = 100) {
  const response = await request(
    `${t.path}/channels/general/messages?after=${after}&wait=${wait}&limit=${limit}`,
    t.token,
  );
  assert.equal(response.status, 200);
  return response.json();
}

try {
  const health = await request("/api/health");
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true, service: "msn" });
  const home = await request("/");
  assert.equal(home.status, 200);
  assert.match(home.headers.get("Content-Security-Policy"), /frame-ancestors 'none'/);
  assert.ok((await home.text()).includes("Open your message boards"), "Message board home is deployed");
  // Static Assets canonicalizes .html URLs; keep credential-bearing API redirects forbidden.
  const guideRedirect = await request("/guide.html", undefined, { redirect: "manual" });
  assert.equal(guideRedirect.status, 307);
  assert.equal(guideRedirect.headers.get("Location"), "/guide");
  assert.equal((await request("/guide")).status, 200);
  console.log("PASS live assets, security headers and health");
  const [a, b] = await Promise.all([provision(), provision()]);
  for (const t of [a, b])
    assert.equal((await request(`${t.path}/channels/general`, t.token, { method: "PUT" })).status, 201);
  assert.equal((await request(`${b.path}/channels`, a.token)).status, 401);
  assert.equal((await request(`${a.path}/channels`)).status, 401);
  assert.equal(
    (await request(`/api/admin/tenants/${a.name}/token`, a.token, { method: "POST" })).status,
    403,
  );
  console.log("PASS live multi-tenant and admin capability isolation");

  const start = Date.now();
  const polls = [page(a, 0, 5), page(a, 0, 5)];
  await delay(700);
  const first = await send(a, "Hello agent", "smoke-human", "live-retry");
  const results = await Promise.all(polls);
  for (const result of results) assert.equal(result.messages[0].text, "Hello agent");
  assert.ok(Date.now() - start < 5000, "long polls woke before timeout");
  assert.deepEqual((await send(a, "Hello agent", "smoke-human", "live-retry")).message, first.message);
  await send(a, "Hello human", "smoke-agent");
  const history = await page(a);
  assert.deepEqual(await page(a), history);
  assert.deepEqual(
    history.messages.map((m) => m.username),
    ["smoke-human", "smoke-agent"],
  );
  assert.ok(
    history.messages.every(
      (m) =>
        m.tenant === a.name && m.channel === "general" && new Date(m.createdAt).toISOString() === m.createdAt,
    ),
  );
  const slice = await page(a, 0, 0, 1);
  assert.equal(slice.hasMore, true);
  assert.equal((await page(a, slice.nextCursor)).messages[0].text, "Hello human");
  const timed = Date.now();
  assert.deepEqual(await page(a, history.nextCursor, 1), {
    messages: [],
    nextCursor: history.nextCursor,
    hasMore: false,
  });
  assert.ok(Date.now() - timed >= 900);
  console.log(
    "PASS live bidirectional messaging, fan-out long-poll wake, timeout, single-poll, reread and pagination",
  );

  await Promise.all(Array.from({ length: 20 }, (_, i) => send(i % 2 ? a : b, `concurrent-${i}`)));
  assert.equal((await page(a)).messages.length, 12);
  assert.equal((await page(b)).messages.length, 10);
  const denial = `/api/admin/tenants/${a.name}/channels/general/messages/${first.message.id}`;
  assert.equal((await request(denial, a.token, { method: "DELETE" })).status, 403);
  assert.equal((await request(denial, undefined, { method: "DELETE" })).status, 401);
  assert.equal(
    (await request(`${a.path}/channels/general/messages/${first.message.id}`, a.token, { method: "DELETE" }))
      .status,
    404,
  );
  assert.equal((await request(denial, admin, { method: "DELETE" })).status, 204);
  a.ids.delete(first.message.id);
  assert.ok(!(await page(a)).messages.some((m) => m.id === first.message.id));
  console.log("PASS live 20 concurrent writes and restricted admin deletion");

  const after = (await page(a)).nextCursor;
  const revokedPoll = request(`${a.path}/channels/general/messages?after=${after}&wait=5`, a.token);
  await delay(500);
  const rotated = await request(`/api/admin/tenants/${a.name}/token`, admin, { method: "POST" });
  assert.equal(rotated.status, 200);
  const { token } = await rotated.json();
  assert.equal((await revokedPoll).status, 401);
  assert.equal((await request(`${a.path}/channels`, a.token)).status, 401);
  a.token = token;
  assert.equal((await request(`${a.path}/channels`, a.token)).status, 200);
  console.log("PASS live rotation revokes both old key and pending polls");
} finally {
  for (const t of tenants) {
    // Only delete messages created by this smoke run; tenant names are unique.
    for (const id of t.ids) {
      const response = await request(`/api/admin/tenants/${t.name}/channels/general/messages/${id}`, admin, {
        method: "DELETE",
      });
      assert.equal(response.status, 204);
    }
  }
  console.log("PASS live smoke content cleaned up (empty test tenants and retry tombstones retained)");
}
console.log("LIVE SMOKE PASSED");
