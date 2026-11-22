import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  CALLBACK_PATH,
  offersCloudflare,
  parseCallback,
  SIGN_IN_HOSTS,
  signInWithCloudflare,
} from "../src/lib/cloudflareLogin.ts";

const origin = "https://msn.thehuman.sh";
const callbackUrl = `${origin}${CALLBACK_PATH}`;
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
  const opened: { url: string; callback: string; options: unknown }[] = [];
  return {
    opened,
    openAuthSession: async (url: string, callback: string, options: { preferUniversalLinks: true }) => {
      opened.push({ url, callback, options });
      return reply(url);
    },
  };
}

const answered = () => ({ type: "success", url: `${callbackUrl}#account=${account}&code=${code}` });

test("signs in: opens /login with a challenge, then trades the code and verifier for a key", async () => {
  const { calls, fetchImpl } = fake([json({ url: origin, tenant: account, username: "tomas@example.com", token })]);
  const auth = sheet(answered);
  const result = await signInWithCloudflare(` ${origin} `, { fetchImpl, randomBytes: random, sha256Hex, ...auth });
  assert.deepEqual(result, { account: { origin, tenant: account, username: "tomas@example.com", token } });
  assert.equal(auth.opened.length, 1);
  const challenge = new URL(auth.opened[0]?.url ?? "").searchParams.get("app");
  assert.match(auth.opened[0]?.url ?? "", /^https:\/\/msn\.thehuman\.sh\/login\?app=[a-f0-9]{64}$/);
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

test("the sheet waits for the server's https callback as a universal link, never a custom scheme", async () => {
  const auth = sheet(() => ({ type: "cancel" }));
  await signInWithCloudflare(origin, { fetchImpl: fake([]).fetchImpl, randomBytes: random, sha256Hex, ...auth });
  assert.equal(auth.opened[0]?.callback, "https://msn.thehuman.sh/app/signed-in");
  assert.deepEqual(auth.opened[0]?.options, { preferUniversalLinks: true });
});

test("the hosts the app signs in to are exactly its webcredentials associated domains", () => {
  const config = JSON.parse(readFileSync(new URL("../app.json", import.meta.url), "utf8"));
  const domains: string[] = config.expo.ios.associatedDomains;
  assert.deepEqual(
    domains.filter((d) => d.startsWith("webcredentials:")).map((d) => d.slice("webcredentials:".length)),
    [...SIGN_IN_HOSTS],
  );
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
    `${origin}/#account=${account}`,
    `msn://login?account=${account}&code=${code}`,
    `https://evil.example${CALLBACK_PATH}#account=${account}&code=${code}`,
    `${origin}/app/other#account=${account}&code=${code}`,
    `${callbackUrl}#account=workspace&code=${code}`,
    `${callbackUrl}#account=${account}&code=short`,
    `${callbackUrl}?account=${account}&code=${code}`,
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
    const result = await signInWithCloudflare(origin, { fetchImpl, randomBytes: random, sha256Hex, ...sheet(answered) });
    assert.deepEqual(result, { error: "The server's sign-in answer did not match this sign-in." });
  }
});

test("the server's refusal is shown, and servers the app is not associated with never open a sheet", async () => {
  const { fetchImpl } = fake([
    json({ error: { code: "invalid_app_login", message: "This sign-in expired or was already used. Sign in again." } }, 401),
  ]);
  const expired = await signInWithCloudflare(origin, { fetchImpl, randomBytes: random, sha256Hex, ...sheet(answered) });
  assert.deepEqual(expired, { error: "This sign-in expired or was already used. Sign in again." });
  for (const server of ["http://msn.thehuman.sh", "https://msn.example", "http://localhost:8787"]) {
    const auth = sheet(() => ({ type: "cancel" }));
    const refused = await signInWithCloudflare(server, { randomBytes: random, sha256Hex, ...auth });
    assert.ok("error" in refused, server);
    assert.equal(auth.opened.length, 0, server);
  }
});

test("the button shows only for an associated server whose Access sign-in is on the same origin", async () => {
  const config = (body: unknown) => fake([json(body)]).fetchImpl;
  const loginUrl = `${origin}/login`;
  assert.equal(await offersCloudflare(origin, config({ cloudflareAccess: true, loginUrl })), true);
  assert.equal(await offersCloudflare(origin, config({ cloudflareAccess: false, loginUrl })), false);
  assert.equal(await offersCloudflare(origin, config({ cloudflareAccess: true })), false);
  assert.equal(
    await offersCloudflare(origin, config({ cloudflareAccess: true, loginUrl: "https://other.example/login" })),
    false,
  );
  assert.equal(await offersCloudflare(origin, fake([json({}, 500)]).fetchImpl), false);
  for (const server of ["https://msn.example", "http://localhost:8787", "not a server"]) {
    const { calls, fetchImpl } = fake([json({ cloudflareAccess: true, loginUrl })]);
    assert.equal(await offersCloudflare(server, fetchImpl), false, server);
    assert.equal(calls.length, 0, server);
  }
});

test("parseCallback reads the account and code from the server's own callback path", () => {
  assert.deepEqual(parseCallback(`${callbackUrl}#account=${account}&code=${code}`, origin), { account, code });
  assert.equal(parseCallback(callbackUrl, origin), null);
  assert.equal(parseCallback(`${callbackUrl}#account=${account}&code=${code}`, "https://msn.example"), null);
});
