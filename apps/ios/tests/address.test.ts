import { test } from "./support/bounded.ts";
import assert from "node:assert/strict";
import { addressees, exactSender, namesLine, outgoingAddress, senderActions, sentByViewer } from "../src/core/address.ts";
import { decodeMessage } from "../src/core/decode.ts";

// Several names on one message (ADR 0067).
test("a message lists every name it is addressed to, in order", () => {
  assert.deepEqual(addressees({ to: "rev", recipients: ["rev", "ops"] }), ["rev", "ops"]);
  assert.deepEqual(addressees({ to: "rev" }), ["rev"]);
  assert.deepEqual(addressees({}), []);
  assert.equal(namesLine({ to: "rev", recipients: ["rev", "ops"] }), "rev, ops");
  assert.equal(namesLine({}), "");
});

test("outgoing names keep the wire format and enforce the server's limits", () => {
  assert.deepEqual(outgoingAddress({}), {});
  assert.deepEqual(outgoingAddress({ to: "  " }), {});
  assert.deepEqual(outgoingAddress({ recipients: [" Rae "] }), { to: "Rae" });
  assert.deepEqual(outgoingAddress({ to: "Rae", recipients: [] }), { to: "Rae" });
  assert.deepEqual(outgoingAddress({ to: "Rae", recipients: ["Rae", "Dev, Ops"] }), { to: ["Rae", "Dev, Ops"] });
  for (const names of [["A", " a "], ["A", ""], ["✨".repeat(43)], Array.from({ length: 9 }, (_, i) => String(i))])
    assert.ok("error" in outgoingAddress({ recipients: names }));
});

test("given a slash in a username, when asking who sent it, then it is a different person for ticks and for controls", () => {
  assert.equal(exactSender("Ada", "Ada"), true);
  assert.equal(sentByViewer("Ada", "Ada"), true);
  assert.deepEqual(senderActions("Ada", "Ada"), { edit: true, replace: true });
  assert.equal(sentByViewer("Ada/worker", "Ada"), false);
  assert.equal(exactSender("Ada/worker", "Ada"), false);
  assert.deepEqual(senderActions("Ada/worker", "Ada"), { edit: false, replace: false });
  assert.equal(sentByViewer("Ada/worker", "Ada/worker"), true);
  assert.equal(sentByViewer("Ada", ""), false);
});

test("the decoder keeps a list of names and drops a malformed one", () => {
  const base = { id: 1, tenant: "t", channel: "c", username: "lead", text: "hi", contentType: "text/plain", createdAt: "2026-11-21T10:00:00.000Z" };
  assert.deepEqual(decodeMessage({ ...base, to: "rev", recipients: ["rev", "ops"] }).recipients, ["rev", "ops"]);
  assert.equal(decodeMessage({ ...base, to: "rev", recipients: ["rev", 3] }).recipients, undefined);
  assert.equal(decodeMessage({ ...base, to: "rev" }).recipients, undefined);
});
