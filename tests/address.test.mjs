import assert from "node:assert/strict";
import { test } from "node:test";
import {
  addressees,
  isAddressedTo,
  MAX_RECIPIENTS,
  MAX_TO_TEXT_BYTES,
  namesProblem,
  namesText,
  parseNames,
  toField,
  withName,
} from "../public/address.js";
import { unchangedRetryFiles } from "../public/drafts.js";
import { summarize } from "../public/since.js";

// Address a message to several names (ADR 0067): the web's one helper for addressing.

test("addressees reads recipients, else to alone, else none", () => {
  assert.deepEqual(addressees({ to: "rev", recipients: ["rev", "ops"] }), ["rev", "ops"]);
  assert.deepEqual(addressees({ to: "rev" }), ["rev"]);
  assert.deepEqual(addressees({}), []);
  assert.deepEqual(addressees(null), []);
  // A malformed list falls back to `to`.
  assert.deepEqual(addressees({ to: "rev", recipients: ["rev", 4] }), ["rev"]);
});

test("isAddressedTo matches any name exactly or trimmed and ignoring case", () => {
  const message = { to: "Rev", recipients: ["Rev", " ops "] };
  assert.equal(isAddressedTo("rev", message), true);
  assert.equal(isAddressedTo("OPS", message), true);
  assert.equal(isAddressedTo("lead", message), false);
});

test("the To field splits on commas, trims, drops blanks and repeats", () => {
  assert.deepEqual(parseNames(" lead , worker,,Lead, "), ["lead", "worker"]);
  assert.deepEqual(parseNames(""), []);
  assert.equal(namesText(["lead", "worker"]), "lead, worker");
  assert.deepEqual(withName(["lead"], "LEAD"), ["lead"]);
  assert.deepEqual(withName(["lead"], "ops"), ["lead", "ops"]);
});

test("a send body keeps one name as text and sends several as a list", () => {
  assert.equal(toField([]), undefined);
  assert.equal(toField(["lead"]), "lead");
  assert.deepEqual(toField(["lead", "ops"]), ["lead", "ops"]);
});

test("more than 8 names or a name over 128 bytes cannot be sent", () => {
  const names = Array.from({ length: MAX_RECIPIENTS }, (_, i) => `agent-${i}`);
  assert.equal(namesProblem(names), null);
  assert.match(namesProblem([...names, "ninth"]), /at most 8 names/);
  assert.match(namesProblem(["x".repeat(129)]), /128 UTF-8 bytes/);
  assert.equal(MAX_TO_TEXT_BYTES, 8 * 128 + 7 * 2);
});

test("a kept retry with several names matches only the same names in the same order", () => {
  const attachments = [{ id: "a".repeat(64), name: "notes.txt", mediaType: "text/plain" }];
  const retry = {
    payload: JSON.stringify({ username: "Tomas", text: "see", to: ["lead", "ops"], attachments }),
    key: "k1",
  };
  const now = { username: "Tomas", content: "see", recipient: "lead, ops", replyTo: null };
  assert.deepEqual(unchangedRetryFiles(retry, now), attachments);
  assert.equal(unchangedRetryFiles(retry, { ...now, recipient: "ops, lead" }), null);
  assert.equal(unchangedRetryFiles(retry, { ...now, recipient: "lead" }), null);
});

test("since you left shows a message to you when you are any of its names", () => {
  const messages = [
    {
      id: 2,
      username: "lead",
      text: "Which region?",
      contentType: "text/plain",
      to: "rev",
      recipients: ["rev", "Tomas"],
    },
  ];
  const summary = summarize(messages, { after: 1, me: "tomas" });
  assert.deepEqual(
    summary.items.map((item) => item.text),
    ["lead to you: “Which region?”"],
  );
});
