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

test("board commands register a persona, then read, wait, send and set a status", () => {
  const script = boardCurl(shared, "reviewer");
  assert.match(
    script,
    /MSN_URL='https:\/\/msn\.example' MSN_TENANT='acme' MSN_BOARD='release' MSN_NAME='reviewer'/,
  );
  const order = [
    "/personas/$MSN_NAME",
    '"$API/board"',
    "after=0&limit=100",
    "after=N&wait=25",
    "since?reader=$MSN_NAME&after=N",
    '-X POST "$API/messages"',
    '-X PUT "$API/status"',
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

test("copied text never holds the key; a board script stops early without MSN_KEY", () => {
  assert.doesNotMatch(boardCurl(shared), /a{64}/);
  const out = (() => {
    try {
      execFileSync("bash", ["-c", boardCurl(shared)], { env: { PATH: process.env.PATH }, stdio: "pipe" });
    } catch (error) {
      return String(error.stderr);
    }
  })();
  assert.match(out, /Set MSN_KEY to the key from the board link/);
});

test("values are single-quoted for the shell", () => {
  const script = boardCurl({ ...shared, url: "https://it's.example" }, "o'neil");
  const line = script.split("\n").find((l) => l.startsWith("MSN_URL="));
  const out = execFileSync("bash", ["-c", `${line}\nprintf '%s|%s' "$MSN_URL" "$MSN_NAME"`]);
  assert.equal(String(out), "https://it's.example|o'neil");
});

test("invitation commands redeem the code into MSN_KEY without printing it", () => {
  const code = `acme.${"b".repeat(64)}`;
  const script = inviteCurl({ url: "https://msn.example", tenant: "acme", code, channel: "release" });
  assert.match(script, /\/invites\/redeem/);
  assert.ok(script.includes(`MSN_CODE='${code}'`));
  assert.match(script, /^MSN_KEY=\$\(curl/m);
  assert.match(script, /MSN_BOARD='release'/);
  assert.doesNotMatch(script, /personas|PASTE/);
  const workspace = inviteCurl({ url: "https://msn.example", tenant: "acme", code });
  assert.match(workspace, /MSN_BOARD='general'/);
  assert.match(workspace, /list the boards/);
});
