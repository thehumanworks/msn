import assert from "node:assert/strict";
import { test } from "node:test";
import {
  draftsFor,
  hasContent,
  MAX_DRAFT_BYTES,
  MAX_DRAFTS,
  parseDrafts,
  putDraft,
  restoreDraft,
} from "../public/drafts.js";
import { markId } from "../public/since.js";

const memory = (fields = {}) => ({
  content: "",
  recipient: "",
  replyTo: null,
  quote: null,
  replaces: null,
  files: [],
  missingFiles: 0,
  retry: null,
  sending: false,
  ...fields,
});

test("a draft round-trips with its recipient, reply target and retry key, never its files", () => {
  const key = markId("Tomas", "general");
  const file = { name: "a.txt", size: 3 };
  const retry = { payload: '{"username":"Tomas","text":"hi"}', key: "4b1d0c2e-1f7a-4c1b-9b9a-0e0f6e0d1c2b" };
  const stored = putDraft(
    {},
    key,
    memory({ content: "hi", recipient: "worker", replyTo: 7, files: [file], retry }),
    123,
  );
  const text = JSON.stringify(stored);
  assert.ok(!text.includes("a.txt"), "file names and contents are not stored");
  const parsed = parseDrafts(text);
  assert.deepEqual(parsed[key], {
    content: "hi",
    recipient: "worker",
    replyTo: 7,
    quote: null,
    replaces: null,
    files: 1,
    retry,
    at: 123,
  });
  assert.deepEqual(
    restoreDraft(parsed[key]),
    memory({ content: "hi", recipient: "worker", replyTo: 7, missingFiles: 1, retry }),
  );
});

test("an emptied draft is removed; a lone retry key or reply target keeps it", () => {
  const key = markId("Tomas", "general");
  let stored = putDraft({}, key, memory({ content: "draft" }));
  stored = putDraft(stored, key, memory());
  assert.deepEqual(stored, {});
  stored = putDraft({}, key, memory({ retry: { payload: "{}", key: "k1" } }));
  assert.ok(stored[key]);
  stored = putDraft({}, key, memory({ replyTo: 3 }));
  assert.equal(stored[key].replyTo, 3);
  // Files lost on a reload still mark the draft until they are attached again or sent.
  stored = putDraft({}, key, memory({ missingFiles: 2 }));
  assert.equal(stored[key].files, 2);
});

test("a draft too long to send is kept in memory only", () => {
  const key = markId("Tomas", "general");
  const before = putDraft({}, key, memory({ content: "short" }));
  const after = putDraft(before, key, memory({ content: "x".repeat(MAX_DRAFT_BYTES + 1) }));
  assert.deepEqual(after, {});
  assert.ok(putDraft({}, key, memory({ content: "é".repeat(MAX_DRAFT_BYTES / 2) }))[key]);
  assert.deepEqual(putDraft({}, key, memory({ content: "é".repeat(MAX_DRAFT_BYTES / 2 + 1) })), {});
});

test("the least recently changed drafts go first past the cap", () => {
  let stored = {};
  for (let i = 0; i < MAX_DRAFTS + 5; i++)
    stored = putDraft(stored, markId("Tomas", `b${i}`), memory({ content: `${i}` }));
  assert.equal(Object.keys(stored).length, MAX_DRAFTS);
  assert.ok(!stored[markId("Tomas", "b0")]);
  // Changing an old draft moves it to the newest end.
  stored = putDraft(stored, markId("Tomas", "b5"), memory({ content: "again" }));
  stored = putDraft(stored, markId("Tomas", "new"), memory({ content: "new" }));
  assert.ok(stored[markId("Tomas", "b5")]);
  assert.ok(!stored[markId("Tomas", "b6")]);
  assert.equal(Object.keys(parseDrafts(JSON.stringify(stored))).length, MAX_DRAFTS);
});

test("malformed stored values are dropped entry by entry", () => {
  assert.deepEqual(parseDrafts(null), {});
  assert.deepEqual(parseDrafts("not json"), {});
  assert.deepEqual(parseDrafts("[1,2]"), {});
  const good = { content: "ok", recipient: "", replyTo: null, files: 0, retry: null, at: 1 };
  const parsed = parseDrafts(
    JSON.stringify({
      "a\ngood": good,
      "a\nbad-reply": { ...good, replyTo: 0 },
      "a\nbad-files": { ...good, files: 11 },
      "a\nbad-key": { ...good, retry: { payload: "{}", key: "has space" } },
      "a\nbad-type": { ...good, content: 5 },
      "a\nempty": { ...good, content: "" },
      "a\ntoken": { ...good, token: "secret" },
      "a\nbad-quote": { ...good, replyTo: 3, quote: 7 },
      "a\nlong-quote": { ...good, replyTo: 3, quote: "x".repeat(2049) },
    }),
  );
  assert.deepEqual(Object.keys(parsed), ["a\ngood", "a\ntoken"]);
  assert.ok(!("token" in parsed["a\ntoken"]), "unknown fields are not carried over");
});

test("only the connected name's drafts come back", () => {
  let stored = putDraft({}, markId("Tomas", "general"), memory({ content: "mine" }));
  stored = putDraft(stored, markId("Tom", "general"), memory({ content: "other name" }));
  assert.deepEqual(
    draftsFor(stored, "Tomas").map(([board, entry]) => [board, entry.content]),
    [["general", "mine"]],
  );
  assert.equal(hasContent(memory()), false);
});

test("an unchanged uncertain send keeps its uploaded files; any change does not", async () => {
  const { unchangedRetryFiles } = await import("../public/drafts.js");
  const attachments = [{ id: "a".repeat(64), name: "notes.txt", mediaType: "text/plain" }];
  const retry = {
    payload: JSON.stringify({ username: "Tomas", text: "see file", to: "lead", replyTo: 4, attachments }),
    key: "k1",
  };
  const now = { username: "Tomas", content: "see file", recipient: "lead", replyTo: 4 };
  assert.deepEqual(unchangedRetryFiles(retry, now), attachments);
  assert.equal(unchangedRetryFiles(retry, { ...now, content: "see file!" }), null);
  assert.equal(unchangedRetryFiles(retry, { ...now, recipient: "" }), null);
  assert.equal(unchangedRetryFiles(retry, { ...now, replyTo: null }), null);
  assert.equal(unchangedRetryFiles(retry, { ...now, username: "Tom" }), null);
  assert.equal(unchangedRetryFiles(retry, { ...now, quote: "a line" }), null);
  assert.equal(unchangedRetryFiles(retry, { ...now, replaces: 3 }), null);
  assert.equal(unchangedRetryFiles(null, now), null);
  assert.equal(unchangedRetryFiles({ payload: "nope", key: "k" }, now), null);
  const noFiles = {
    payload: JSON.stringify({ username: "Tomas", text: "see file", to: "lead", replyTo: 4 }),
    key: "k",
  };
  assert.equal(unchangedRetryFiles(noFiles, now), null);
});

test("a reply's quote is kept with its reply target (ADR 0059)", () => {
  const key = markId("Tomas", "general");
  const stored = putDraft({}, key, memory({ content: "yes", replyTo: 7, quote: "Ship it?" }));
  const parsed = parseDrafts(JSON.stringify(stored));
  assert.equal(parsed[key].quote, "Ship it?");
  assert.equal(restoreDraft(parsed[key]).quote, "Ship it?");
  // Drafts kept before quotes existed have no quote field and still load.
  const old = { content: "ok", recipient: "", replyTo: 7, files: 0, retry: null, at: 1 };
  assert.equal(parseDrafts(JSON.stringify({ [key]: old }))[key].quote, null);
  // A quote without a reply target is dropped, not sent on its own.
  assert.equal(putDraft({}, key, memory({ content: "x", quote: "orphan" }))[key].quote, null);
});

test("a replacement draft keeps the id it replaces (ADR 0068)", () => {
  const key = markId("Tomas", "general");
  const stored = putDraft({}, key, memory({ replaces: 5 }));
  // Replacing is something to come back to even before any text is typed.
  assert.ok(stored[key]);
  const parsed = parseDrafts(JSON.stringify(stored));
  assert.equal(parsed[key].replaces, 5);
  assert.equal(restoreDraft(parsed[key]).replaces, 5);
  // Drafts kept before replacements existed have no field and still load.
  const old = { content: "ok", recipient: "", replyTo: null, files: 0, retry: null, at: 1 };
  assert.equal(parseDrafts(JSON.stringify({ [key]: old }))[key].replaces, null);
  assert.deepEqual(parseDrafts(JSON.stringify({ [key]: { ...old, replaces: 0 } })), {});
});
