import assert from "node:assert/strict";
import { test } from "node:test";
import { randomBytes } from "node:crypto";
import { join, type JoinDeps } from "../src/lib/join.ts";
import type { JoinLink } from "../src/lib/joinLink.ts";

const KEY = "k".repeat(40);
const random = (count: number) => new Uint8Array(randomBytes(count));

function deps(responses: Response[] = [], answer: string | null = null) {
  const calls: { method: string; input: Record<string, unknown> }[] = [];
  const urls: string[] = [];
  const d: JoinDeps = {
    model: {
      signInWithKey: async (input) => (calls.push({ method: "key", input }), answer),
      redeemInvitation: async (input) => (calls.push({ method: "invite", input }), answer),
    },
    fetchImpl: async (url) => {
      urls.push(url);
      const next = responses.shift();
      if (!next) throw new Error("unexpected request");
      return next;
    },
    randomBytes: random,
  };
  return { calls, urls, d };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("an account connection signs in as its own user, ignoring the typed name", async () => {
  const { calls, urls, d } = deps();
  const link: JoinLink = {
    kind: "account",
    origin: "https://msn.example",
    tenant: "acme",
    token: KEY,
    username: "dana",
  };
  assert.deepEqual(await join(link, "someone else", "", d), { board: null });
  assert.equal(calls[0]?.method, "key");
  assert.equal(calls[0]?.input.username, "dana");
  assert.equal(urls.length, 0);
});

test("an invitation is redeemed on its own server, or on the typed one for a bare code", async () => {
  const { calls, d } = deps();
  const code = `acme.${"ab".repeat(32)}`;
  await join(
    { kind: "invite", origin: "https://msn.example", tenant: "acme", code },
    " Dana ",
    "https://other.example",
    d,
  );
  await join({ kind: "invite", origin: null, tenant: "acme", code }, "Dana", "https://other.example", d);
  assert.deepEqual(
    calls.map((c) => [c.method, c.input.origin, c.input.username]),
    [
      ["invite", "https://msn.example", "Dana"],
      ["invite", "https://other.example", "Dana"],
    ],
  );
});

test("a board link registers the name on the board, then signs in and opens that board", async () => {
  const { calls, urls, d } = deps([json({ personas: [] }), json({ id: "persona-new", displayName: "Dana" }, 201)]);
  const link: JoinLink = { kind: "board", origin: "https://msn.example", tenant: "acme", board: "launch", token: KEY };
  assert.deepEqual(await join(link, "Dana", "https://ignored.example", d), { board: "launch" });
  assert.ok(urls.every((url) => url.startsWith("https://msn.example/api/tenants/acme/channels/launch/personas")));
  assert.equal(calls[0]?.input.origin, "https://msn.example");
});

test("a missing name or a refused sign-in comes back as an error, not a throw", async () => {
  const link: JoinLink = { kind: "board", origin: "https://msn.example", tenant: "acme", board: "launch", token: KEY };
  assert.deepEqual(await join(link, "  ", "", deps().d), { error: "Choose a display name." });
  const refused = deps([json({ personas: [{ id: "persona-1", displayName: "Dana" }] })], "That key was revoked.");
  assert.deepEqual(await join(link, "Dana", "", refused.d), { error: "That key was revoked." });
  const insecure: JoinLink = { ...link, origin: "http://msn.example" };
  const result = await join(insecure, "Dana", "", deps().d);
  assert.ok("error" in result && /https/.test(result.error));
});
