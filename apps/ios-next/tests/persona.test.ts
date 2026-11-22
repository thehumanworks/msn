import assert from "node:assert/strict";
import { test } from "node:test";
import { randomBytes } from "node:crypto";
import { ensurePersona, validName } from "../src/lib/persona.ts";

const input = { origin: "https://msn.example", tenant: "acme", board: "launch", token: "t".repeat(40), name: " Dana " };
const random = (count: number) => new Uint8Array(randomBytes(count));
type Call = { url: string; init: RequestInit };

function fake(responses: Response[]) {
  const calls: Call[] = [];
  const fetchImpl = async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (!next) throw new Error("unexpected request");
    return next;
  };
  return { calls, fetchImpl };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("a name already on the board is reused, without registering again", async () => {
  const { calls, fetchImpl } = fake([json({ personas: [{ id: "persona-1", displayName: "Dana" }] })]);
  const persona = await ensurePersona(input, fetchImpl, random);
  assert.equal(persona.id, "persona-1");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, "https://msn.example/api/tenants/acme/channels/launch/personas");
  assert.equal(calls[0]?.init.redirect, "manual");
  assert.equal((calls[0]?.init.headers as Record<string, string>).Authorization, `Bearer ${input.token}`);
});

test("a new name is registered under a fresh persona id", async () => {
  const { calls, fetchImpl } = fake([json({ personas: [] }), json({ id: "persona-new", displayName: "Dana" }, 201)]);
  const persona = await ensurePersona(input, fetchImpl, random);
  assert.equal(persona.displayName, "Dana");
  assert.equal(calls[1]?.init.method, "PUT");
  assert.match(calls[1]?.url ?? "", /\/personas\/persona-[0-9a-f]{32}$/);
  assert.deepEqual(JSON.parse(String(calls[1]?.init.body)), { displayName: "Dana" });
});

test("a revoked key and a redirect stop the join before anything is sent", async () => {
  await assert.rejects(ensurePersona(input, fake([json({ error: { message: "no" } }, 401)]).fetchImpl, random), /no longer works/);
  const redirect = new Response(null, { status: 302, headers: { location: "https://evil.example" } });
  const { calls, fetchImpl } = fake([redirect]);
  await assert.rejects(ensurePersona(input, fetchImpl, random), /redirect/);
  assert.equal(calls.length, 1);
});

test("display names must be present and at most 128 bytes", () => {
  assert.equal(validName("Dana"), null);
  assert.ok(validName("   "));
  assert.ok(validName("é".repeat(65)));
  assert.equal(validName("é".repeat(64)), null);
});
