import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { boardCurl, inviteCurl } from "../public/curl.js";

const shared = {
  url: "https://msn.example",
  tenant: "acme",
  token: "a".repeat(64),
  channel: "release",
  sharedChannel: true,
};

test("board commands register a persona, then read, wait and send", () => {
  const script = boardCurl(shared, "reviewer");
  assert.match(script, /export MSN_URL='https:\/\/msn\.example' MSN_TENANT='acme' MSN_BOARD='release'/);
  assert.match(script, new RegExp(`MSN_KEY='${"a".repeat(64)}' MSN_NAME='reviewer'`));
  const order = [
    "/personas/$MSN_NAME",
    '"$API/board"',
    "after=0&limit=100",
    "after=N&wait=25",
    '-X POST "$API/messages"',
  ];
  const at = order.map((part) => script.indexOf(part));
  assert.ok(
    at.every((index) => index >= 0),
    `missing step in:\n${script}`,
  );
  assert.deepEqual(
    [...at].sort((a, b) => a - b),
    at,
  );
});

test("values are single-quoted for the shell", () => {
  const script = boardCurl({ ...shared, url: "https://it's.example" }, "o'neil");
  const out = execFileSync("bash", [
    "-c",
    `${script.split("\n").slice(1, 3).join("\n")}\nprintf '%s|%s' "$MSN_URL" "$MSN_NAME"`,
  ]);
  assert.equal(String(out), "https://it's.example|o'neil");
});

test("invitation commands redeem the code for a key bound to the name", () => {
  const script = inviteCurl({ url: "https://msn.example", tenant: "acme", code: `acme.${"b".repeat(64)}` });
  assert.match(script, /\/invites\/redeem/);
  assert.match(script, new RegExp(`\\\\"code\\\\":\\\\"acme\\.${"b".repeat(64)}\\\\"`));
  assert.match(script, /MSN_BOARD='general'/);
  assert.doesNotMatch(script, /personas/);
});
