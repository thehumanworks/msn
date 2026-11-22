import assert from "node:assert/strict";
import { test } from "node:test";
import { editMentionDraft as edit, emptyDraft, pickMention as pick } from "../src/lib/mentionDraft.ts";

test("tap inserts the canonical name at the caret, preserves surrounding text and addresses the member", () => {
  const draft = edit(emptyDraft, "Try (@al first)");
  assert.deepEqual(pick(draft, 8, "Alice Chen"), {
    draft: { text: "Try (@Alice Chen first)", recipients: ["Alice Chen"] }, caret: 17,
  });
});

test("email, unknown or pasted text does not silently wake a person", () => {
  const draft = edit(emptyDraft, "email x@al");
  assert.equal(pick(draft, draft.text.length, "Alice"), null);
  assert.deepEqual(edit(emptyDraft, "@Alice please").recipients, []);
});

test("multiple tags, repeats and deletion keep exactly the intended recipients", () => {
  let draft = emptyDraft;
  for (const name of ["Jo", "Jo Lee", "R&D, Inc.", "Jo"]) {
    draft = edit(draft, draft.text + "@");
    draft = pick(draft, draft.text.length, name)!.draft;
  }
  assert.deepEqual(draft.recipients, ["Jo", "Jo Lee", "R&D, Inc."]);
  assert.deepEqual(edit(draft, "@Jo Lee @R&D, Inc.").recipients, ["Jo Lee", "R&D, Inc."]);
  assert.deepEqual(edit(draft, "@Joanna or someone@Jo").recipients, []);
});

test("eight distinct recipients can be picked; the ninth does not silently insert an unaddressed tag", () => {
  const recipients = Array.from({ length: 8 }, (_, i) => "Member" + i);
  const draft = { text: recipients.map((n) => "@" + n).join(" ") + " @", recipients };
  assert.equal(pick(draft, draft.text.length, "Ninth"), null);
  assert.deepEqual(pick(draft, draft.text.length, recipients[0]!)!.draft.recipients, recipients);
});
