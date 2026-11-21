import { test } from "./support/bounded.ts";
import assert from "node:assert/strict";
import { addressees, namesLine } from "../src/core/address.ts";
import { decodeMessage } from "../src/core/decode.ts";

// Several names on one message (ADR 0067).
test("a message lists every name it is addressed to, in order", () => {
  assert.deepEqual(addressees({ to: "rev", recipients: ["rev", "ops"] }), ["rev", "ops"]);
  assert.deepEqual(addressees({ to: "rev" }), ["rev"]);
  assert.deepEqual(addressees({}), []);
  assert.equal(namesLine({ to: "rev", recipients: ["rev", "ops"] }), "rev, ops");
  assert.equal(namesLine({}), "");
});

test("the decoder keeps a list of names and drops a malformed one", () => {
  const base = { id: 1, tenant: "t", channel: "c", username: "lead", text: "hi", contentType: "text/plain", createdAt: "2026-11-21T10:00:00.000Z" };
  assert.deepEqual(decodeMessage({ ...base, to: "rev", recipients: ["rev", "ops"] }).recipients, ["rev", "ops"]);
  assert.equal(decodeMessage({ ...base, to: "rev", recipients: ["rev", 3] }).recipients, undefined);
  assert.equal(decodeMessage({ ...base, to: "rev" }).recipients, undefined);
});
