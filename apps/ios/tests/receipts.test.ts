import { test } from "./support/bounded.ts";
import assert from "node:assert/strict";
import type { ApiClient } from "../src/core/apiClient.ts";
import { ProtocolError } from "../src/core/errors.ts";
import { decodeReceipts, loadReceipts, receiptLine, type Receipt } from "../src/core/receipts.ts";

const receipt = (name: string, committedThrough: number | null): Receipt => ({
  name,
  reader: committedThrough === null ? null : name,
  personaId: null,
  committedThrough,
  updatedAt: null,
});

test("receiptLine counts only explicit commits at or past the message", () => {
  const all = [receipt("reviewer", 3), receipt("worker-2", null), receipt("lead", 0)];
  assert.equal(receiptLine(all, 2), "Processed by reviewer · not yet: worker-2, lead");
  assert.equal(receiptLine(all, 4), "Not yet processed by reviewer, worker-2, lead");
  assert.equal(receiptLine([receipt("reviewer", 3)], 3), "Processed by reviewer");
  assert.equal(receiptLine([], 1), null);
});

test("decodeReceipts checks the channel and every field", () => {
  const good = { channel: "work", receipts: [receipt("a", 2), receipt("b", null)] };
  assert.deepEqual(
    decodeReceipts(good, "work").map((r) => r.committedThrough),
    [2, null],
  );
  for (const bad of [
    { ...good, channel: "other" },
    { channel: "work", receipts: "x" },
    { channel: "work", receipts: [{ ...receipt("a", 1), committedThrough: -1 }] },
    { channel: "work", receipts: [{ ...receipt("a", 1), name: 5 }] },
    null,
  ])
    assert.throws(() => decodeReceipts(bad, "work"), ProtocolError);
});

test("loadReceipts asks for the channel's receipts and decodes them", async () => {
  const asked: string[] = [];
  const api = {
    channelReceipts: async (channel: string) => {
      asked.push(channel);
      return { channel, receipts: [receipt("reviewer", 1)] };
    },
  };
  const loaded = await loadReceipts(api as unknown as ApiClient, "work");
  assert.deepEqual(asked, ["work"]);
  assert.equal(receiptLine(loaded, 1), "Processed by reviewer");
});
