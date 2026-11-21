// Mention someone with @ (ADR 0055): when the list opens, who it suggests, and how a pick
// fills the To field.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  addressAfterEdit,
  addressAfterPick,
  hasMention,
  insertMention,
  MAX_SUGGESTIONS,
  mentionAt,
  people,
  suggest,
} from "../public/mention.js";

test("an @ at the start or after a space opens a mention", () => {
  assert.deepEqual(mentionAt("@", 1), { start: 0, query: "" });
  assert.deepEqual(mentionAt("hi @le", 6), { start: 3, query: "le" });
  assert.deepEqual(mentionAt("hi\n@le", 6), { start: 3, query: "le" });
  assert.deepEqual(mentionAt("(@le", 4), { start: 1, query: "le" });
  assert.deepEqual(mentionAt("@lead and more", 3), { start: 0, query: "le" }, "caret mid-word");
});

test("an e-mail, a space or no @ keeps the list closed", () => {
  assert.equal(mentionAt("mail a@b", 8), null);
  assert.equal(mentionAt("@lead ", 6), null, "a space ends the mention");
  assert.equal(mentionAt("@lead\n", 6), null);
  assert.equal(mentionAt("hello", 5), null);
  assert.equal(mentionAt("", 0), null);
  assert.equal(mentionAt("@@", 2), null);
  assert.equal(mentionAt("@x", 5), null, "caret past the end");
});

test("people: listening personas, then recent names newest first, then other personas", () => {
  const everyone = people({
    me: "human",
    personas: [
      { displayName: "idle-bot", listening: false },
      { displayName: "lead", listening: true },
      { displayName: "human", listening: true },
    ],
    messages: [
      { username: "reviewer", to: "lead" },
      { username: "human" },
      { username: "builder", to: "tester" },
    ],
  });
  assert.deepEqual(
    everyone.map((p) => p.name),
    ["lead", "builder", "tester", "reviewer", "idle-bot"],
  );
  assert.equal(everyone[0].listening, true);
  assert.equal(everyone.find((p) => p.name === "builder").listening, false);
});

test("people works with no personas (a plain channel)", () => {
  assert.deepEqual(people({ messages: [{ username: "a" }, { username: "a" }] }), [
    { name: "a", listening: false },
  ]);
  assert.deepEqual(people(), []);
});

test("suggest ranks prefix matches before other matches, ignoring case", () => {
  const everyone = ["Builder", "lead", "team-lead", "leader"].map((name) => ({ name, listening: false }));
  assert.deepEqual(
    suggest(everyone, "LEA").map((p) => p.name),
    ["lead", "leader", "team-lead"],
  );
  assert.equal(suggest(everyone, "").length, 4, "a bare @ lists everyone");
  assert.deepEqual(suggest(everyone, "zz"), []);
  const many = Array.from({ length: 20 }, (_, i) => ({ name: `bot${i}`, listening: false }));
  assert.equal(suggest(many, "bot").length, MAX_SUGGESTIONS);
});

test("insertMention replaces the typed @query with @name and a space", () => {
  assert.deepEqual(insertMention("hi @le", 3, 6, "lead"), { text: "hi @lead ", caret: 9 });
  assert.deepEqual(insertMention("@le please", 0, 3, "lead"), { text: "@lead please", caret: 6 });
  assert.deepEqual(insertMention("@lethere", 0, 3, "lead"), { text: "@lead there", caret: 6 });
});

test("hasMention finds whole @names only", () => {
  assert.equal(hasMention("ask @lead now", "lead"), true);
  assert.equal(hasMention("@lead, please", "lead"), true);
  assert.equal(hasMention("ask @leader", "lead"), false);
  assert.equal(hasMention("me@lead", "lead"), false);
  assert.equal(hasMention("lead", "lead"), false);
  assert.equal(hasMention("x @leader @lead", "lead"), true);
});

test("each mention picked addresses the message while To holds only picked names (ADR 0067)", () => {
  let address = addressAfterPick("", null, "lead");
  assert.deepEqual(address, { to: "lead", mentionTo: "lead" });
  address = addressAfterPick(address.to, address.mentionTo, "builder");
  assert.deepEqual(
    address,
    { to: "lead, builder", mentionTo: "lead, builder" },
    "a second pick adds its name",
  );
  address = addressAfterPick(address.to, address.mentionTo, "Lead");
  assert.deepEqual(
    address,
    { to: "lead, builder", mentionTo: "lead, builder" },
    "a name already there stays once",
  );
  assert.deepEqual(addressAfterPick("ops", null, "lead"), { to: "ops", mentionTo: null }, "a typed To stays");
  assert.deepEqual(
    addressAfterPick("lead, ops", "lead", "builder"),
    { to: "lead, ops", mentionTo: "lead" },
    "a To changed by hand stays",
  );
  const eight = Array.from({ length: 8 }, (_, i) => `a${i}`).join(", ");
  assert.deepEqual(
    addressAfterPick(eight, eight, "ninth"),
    { to: eight, mentionTo: eight },
    "at most 8 names",
  );
});

test("deleting the picked @name clears To; a typed To is never cleared", () => {
  assert.deepEqual(addressAfterEdit("lead", "lead", "hi @lead"), { to: "lead", mentionTo: "lead" });
  assert.deepEqual(addressAfterEdit("lead", "lead", "hi @lea"), { to: "", mentionTo: null });
  assert.deepEqual(addressAfterEdit("ops", "lead", "hi"), { to: "ops", mentionTo: null });
  assert.deepEqual(addressAfterEdit("ops", null, "hi"), { to: "ops", mentionTo: null });
  // With several picked names, only the one whose @name went away leaves To.
  assert.deepEqual(addressAfterEdit("lead, builder", "lead, builder", "hi @builder"), {
    to: "builder",
    mentionTo: "builder",
  });
});

test("people suggests every name a message was addressed to", () => {
  const everyone = people({ messages: [{ username: "lead", to: "rev", recipients: ["rev", "ops"] }] });
  assert.deepEqual(
    everyone.map((person) => person.name),
    ["lead", "rev", "ops"],
  );
});
