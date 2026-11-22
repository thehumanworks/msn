import assert from "node:assert/strict";
import { test } from "node:test";
import { describeJoin, parseJoinLink } from "../src/lib/joinLink.ts";

const CODE = `acme.${"ab".repeat(32)}`;
const KEY = "k".repeat(40);

test("an invitation link names its server, tenant and code", () => {
  const parsed = parseJoinLink(`  https://msn.example/#invite=${CODE}\n`);
  assert.deepEqual(parsed, { ok: true, link: { kind: "invite", origin: "https://msn.example", tenant: "acme", code: CODE } });
});

test("a bare invitation code leaves the server to the person", () => {
  const parsed = parseJoinLink(CODE);
  assert.ok(parsed.ok);
  assert.deepEqual(parsed.link, { kind: "invite", origin: null, tenant: "acme", code: CODE });
  assert.equal(describeJoin(parsed.link), "Invitation to acme");
});

test("a board link carries the board and its shared key", () => {
  const parsed = parseJoinLink(`http://localhost:8787/#board=acme/launch&key=${KEY}`);
  assert.ok(parsed.ok);
  assert.deepEqual(parsed.link, { kind: "board", origin: "http://localhost:8787", tenant: "acme", board: "launch", token: KEY });
  assert.equal(describeJoin(parsed.link), "Board # launch in acme");
});

test("a message link is refused: it carries no credential", () => {
  const parsed = parseJoinLink("https://msn.example/#board=acme/launch&msg=12");
  assert.equal(parsed.ok, false);
});

test("a board link without a key, or with a malformed one, is refused", () => {
  assert.equal(parseJoinLink("https://msn.example/#board=acme/launch").ok, false);
  assert.equal(parseJoinLink("https://msn.example/#board=acme/launch&key=short").ok, false);
  assert.equal(parseJoinLink(`https://msn.example/#board=acme/launch/extra&key=${KEY}`).ok, false);
  assert.equal(parseJoinLink(`https://msn.example/#board=ACME/launch&key=${KEY}`).ok, false);
});

test("only plain web links at the root are accepted", () => {
  assert.equal(parseJoinLink(`ftp://msn.example/#invite=${CODE}`).ok, false);
  assert.equal(parseJoinLink(`https://msn.example/other#invite=${CODE}`).ok, false);
  assert.equal(parseJoinLink(`https://msn.example/?x=1#invite=${CODE}`).ok, false);
  assert.equal(parseJoinLink("https://msn.example/#invite=acme.notacode").ok, false);
  assert.equal(parseJoinLink("hello").ok, false);
  assert.equal(parseJoinLink("").ok, false);
  assert.equal(parseJoinLink("x".repeat(70000)).ok, false);
});

test("an exported account connection signs in as its user", () => {
  const data = { url: "https://msn.example", tenant: "acme", token: KEY, username: "dana" };
  const parsed = parseJoinLink(JSON.stringify(data));
  assert.ok(parsed.ok);
  assert.deepEqual(parsed.link, { kind: "account", origin: "https://msn.example", tenant: "acme", token: KEY, username: "dana" });

  const link = `https://msn.example/#account=${encodeURIComponent(JSON.stringify(data))}`;
  assert.ok(parseJoinLink(link).ok);
  const elsewhere = `https://other.example/#account=${encodeURIComponent(JSON.stringify(data))}`;
  assert.equal(parseJoinLink(elsewhere).ok, false);
  assert.equal(parseJoinLink(JSON.stringify({ ...data, token: "x" })).ok, false);
  assert.equal(parseJoinLink("{not json").ok, false);
});
