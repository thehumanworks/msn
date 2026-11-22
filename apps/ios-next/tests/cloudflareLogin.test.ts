import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { test } from "node:test";
import { CALLBACK, offersCloudflare, parseCallback, signInWithCloudflare } from "../src/lib/cloudflareLogin.ts";

const origin = "https://msn.example";
const account = `account-${"a".repeat(48)}`;
const code = "c".repeat(64);
const token = "k".repeat(64);
const sha256Hex = async (text: string) => createHash("sha256").update(text).digest("hex");
const random = (count: number) => new Uint8Array(randomBytes(count));
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function fake(responses: Response[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = async (url: string, init?: RequestInit) => {
    calls.push({ url, init: init ?? {} });
    const next = responses.shift();
    if (!next) throw new Error("unexpected request");
    return next;
  };
  return { calls, fetchImpl };
}

/** A sign-in sheet that records what it opened and answers with `reply`. */
function sheet(reply: (url: string) => { type: string; url?: string }) {
  const opened: { url: string; callback: string }[] = [];
  return {
    opened,
    openAuthSession: async (url: string, callback: string) => {
      opened.push({ url, callback });
      return reply(url);
    },
  };
}

test("signs in: opens /login with a challenge, then trades the code and verifier for a key", async () => {
  const { calls, fetchImpl } = fake([json({ url: origin, tenant: account, username: "tomas@example.com", token })]);
  const auth = sheet(() => ({ type: "success", url: `${CALLBACK}?account=${account}&code=${code}` }));
  const result = await signInWithCloudflare(` ${origin} `, { fetchImpl, randomBytes: random, sha256Hex, ...auth });
  assert.deepEqual(result, { account: { origin, tenant: account, username: "tomas@example.com", token } });
  assert.equal(auth.opened.length, 1);
  assert.equal(auth.opened[0]?.callback, "msn://login");
  const challenge = new URL(auth.opened[0]?.url ?? "").searchParams.get("app");
  assert.match(auth.opened[0]?.url ?? "", /^https:\/\/msn\.example\/login\?app=[a-f0-9]{64}$/);
  assert.equal(calls[0]?.url, `${origin}/api/account/app-login`);
  assert.equal(calls[0]?.init.method, "POST");
  assert.equal(calls[0]?.init.redirect, "manual");
  const sent = JSON.parse(String(calls[0]?.init.body));
  assert.equal(sent.account, account);
  assert.equal(sent.code, code);
  // The verifier travels only in the exchange, and hashes to the challenge in the URL.
  assert.equal(await sha256Hex(sent.verifier), challenge);
  assert.ok(!(auth.opened[0]?.url ?? "").includes(sent.verifier));
});

test("closing the sheet is a cancel, not an error, and sends nothing", async () => {
  const { calls, fetchImpl } = fake([]);
  const result = await signInWithCloudflare(origin, {
    fetchImpl,
    randomBytes: random,
    sha256Hex,
    ...sheet(() => ({ type: "cancel" })),
  });
  assert.deepEqual(result, { cancelled: true });
  assert.equal(calls.length, 0);
});

test("a callback that is not the server's answer is refused before any request", async () => {
  for (const url of [
    `https://msn.example/#account=${account}`,
    `msn://board?account=${account}&code=${code}`,
    `other://login?account=${account}&code=${code}`,
    `msn://login?account=workspace&code=${code}`,
    `msn://login?account=${account}&code=short`,
  ]) {
    const { calls, fetchImpl } = fake([]);
    const result = await signInWithCloudflare(origin, {
      fetchImpl,
      randomBytes: random,
      sha256Hex,
      ...sheet(() => ({ type: "success", url })),
    });
    assert.ok("error" in result, url);
    assert.equal(calls.length, 0, url);
  }
});

test("a key for another server or account is refused", async () => {
  for (const answer of [
    { url: "https://evil.example", tenant: account, username: "tomas", token },
    { url: origin, tenant: `account-${"b".repeat(48)}`, username: "tomas", token },
    { url: origin, tenant: account, username: "tomas" },
  ]) {
    const { fetchImpl } = fake([json(answer)]);
    const result = await signInWithCloudflare(origin, {
      fetchImpl,
      randomBytes: random,
      sha256Hex,
      ...sheet(() => ({ type: "success", url: `${CALLBACK}?account=${account}&code=${code}` })),
    });
    assert.deepEqual(result, { error: "The server's sign-in answer did not match this sign-in." });
  }
});

test("the server's refusal is shown, and plain http is refused for any server but this machine", async () => {
  const { fetchImpl } = fake([
    json({ error: { code: "invalid_app_login", message: "This sign-in expired or was already used. Sign in again." } }, 401),
  ]);
  const expired = await signInWithCloudflare(origin, {
    fetchImpl,
    randomBytes: random,
    sha256Hex,
    ...sheet(() => ({ type: "success", url: `${CALLBACK}?account=${account}&code=${code}` })),
  });
  assert.deepEqual(expired, { error: "This sign-in expired or was already used. Sign in again." });
  const auth = sheet(() => ({ type: "cancel" }));
  const insecure = await signInWithCloudflare("http://msn.example", { randomBytes: random, sha256Hex, ...auth });
  assert.ok("error" in insecure);
  assert.equal(auth.opened.length, 0);
});

test("the button shows only when the server says it uses Cloudflare Access", async () => {
  assert.equal(await offersCloudflare(origin, fake([json({ cloudflareAccess: true })]).fetchImpl), true);
  assert.equal(await offersCloudflare(origin, fake([json({ cloudflareAccess: false })]).fetchImpl), false);
  assert.equal(await offersCloudflare(origin, fake([json({}, 500)]).fetchImpl), false);
  assert.equal(await offersCloudflare("not a server", fake([]).fetchImpl), false);
});

test("parseCallback reads the account and code from msn://login", () => {
  assert.deepEqual(parseCallback(`msn://login?account=${account}&code=${code}`), { account, code });
  assert.equal(parseCallback("msn://login"), null);
});
