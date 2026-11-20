// Mention someone with @ (ADR 0055): the same rules as the web and desktop clients.
import { test } from "./support/bounded.ts";
import assert from "node:assert/strict";
import {
  addressAfterEdit,
  addressAfterPick,
  decodePersonas,
  hasMention,
  insertMention,
  MAX_SUGGESTIONS,
  mentionAt,
  nextDismissed,
  people,
  suggest,
} from "../src/core/mention.ts";
import type { Message } from "../src/core/types.ts";

const message = (username: string, to?: string): Message => ({
  id: 1,
  tenant: "t",
  channel: "c",
  username,
  text: "hi",
  contentType: "text/plain",
  createdAt: "2026-11-20T00:00:00Z",
  ...(to ? { to } : {}),
});

test("an @ after a space opens a mention; an e-mail or a space does not", () => {
  assert.deepEqual(mentionAt("@", 1), { start: 0, query: "" });
  assert.deepEqual(mentionAt("hi @le", 6), { start: 3, query: "le" });
  assert.equal(mentionAt("mail a@b", 8), null);
  assert.equal(mentionAt("@lead ", 6), null);
  assert.equal(mentionAt("", 0), null);
});

test("people: listening personas, recent names newest first, then other personas; never me", () => {
  const names = people(
    [
      { displayName: "idle-bot", listening: false },
      { displayName: "lead", listening: true },
      { displayName: "human", listening: true },
    ],
    [message("reviewer", "lead"), message("human"), message("builder", "tester")],
    "human",
  ).map((p) => p.name);
  assert.deepEqual(names, ["lead", "builder", "tester", "reviewer", "idle-bot"]);
});

test("suggest ranks prefix matches first and caps the list", () => {
  const everyone = ["Builder", "lead", "team-lead", "leader"].map((name) => ({ name, listening: false }));
  assert.deepEqual(
    suggest(everyone, "LEA").map((p) => p.name),
    ["lead", "leader", "team-lead"],
  );
  const many = Array.from({ length: 20 }, (_, i) => ({ name: `bot${i}`, listening: false }));
  assert.equal(suggest(many, "").length, MAX_SUGGESTIONS);
});

test("a pick writes @name; the first pick fills To; deleting it clears To", () => {
  assert.deepEqual(insertMention("hi @le", 3, 6, "lead"), { text: "hi @lead ", caret: 9 });
  assert.deepEqual(insertMention("@le please", 0, 3, "lead"), { text: "@lead please", caret: 6 });
  assert.equal(hasMention("ask @lead, now", "lead"), true);
  assert.equal(hasMention("ask @leader", "lead"), false);
  let address = addressAfterPick("", null, "lead");
  assert.deepEqual(address, { to: "lead", mentionTo: "lead" });
  address = addressAfterPick(address.to, address.mentionTo, "builder");
  assert.deepEqual(address, { to: "lead", mentionTo: "lead" });
  assert.deepEqual(addressAfterEdit("lead", "lead", "hi @lea"), { to: "", mentionTo: null });
  assert.deepEqual(addressAfterEdit("ops", "lead", "hi"), { to: "ops", mentionTo: null });
});

test("a closed list stays closed for its @ only while that @ is being typed", () => {
  assert.equal(nextDismissed({ start: 0 }, 0), 0, "typing on after the closed @");
  assert.equal(nextDismissed(null, 0), -1, "the @ was deleted or ended: forget the close");
  assert.equal(nextDismissed(mentionAt("@b", 2), nextDismissed(null, 0)), -1, "a new @ in the same place opens");
});

test("decodePersonas keeps names and listening, and skips anything malformed", () => {
  assert.deepEqual(
    decodePersonas({
      personas: [{ displayName: "lead", listening: true }, { displayName: "x" }, { id: "p3" }, null],
    }),
    [
      { displayName: "lead", listening: true },
      { displayName: "x", listening: false },
    ],
  );
  assert.deepEqual(decodePersonas(null), []);
  assert.deepEqual(decodePersonas({ personas: "no" }), []);
});
