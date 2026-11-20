import { test } from "./support/bounded.ts";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import type { ApiClient } from "../src/core/apiClient.ts";
import { ProtocolError } from "../src/core/errors.ts";
import {
  decodeReceipts,
  loadReceipts,
  RECEIPTS_MEANING,
  receiptLine,
  type Receipt,
} from "../src/core/receipts.ts";

const receipt = (name: string, committedThrough: number | null): Receipt => ({
  name,
  reader: committedThrough === null ? null : name,
  personaId: null,
  committedThrough,
  updatedAt: null,
});

const msg = (id: number, username = "human", personaId?: string) => ({ id, username, personaId });

test("receiptLine names only readers with a server commit, never the sender", () => {
  const all = [receipt("reviewer", 3), receipt("worker-2", 0), receipt("silent", null)];
  assert.equal(receiptLine(all, msg(2)), "Processed by reviewer · not yet: worker-2");
  assert.equal(receiptLine(all, msg(4)), "Not yet processed by reviewer, worker-2");
  assert.equal(receiptLine(all, msg(2, "reviewer")), "Not yet processed by worker-2");
  assert.equal(receiptLine([{ ...receipt("reviewer/w1", 3), personaId: "p1" }], msg(2, "renamed", "p1")), null);
  assert.equal(receiptLine([receipt("silent", null)], msg(1)), null);
  assert.equal(receiptLine([], msg(1)), null);
});

test("receiptLine folds long lists into +N more", () => {
  const many = Array.from({ length: 12 }, (_, i) => receipt(`r${i}`, 5));
  assert.equal(receiptLine(many, msg(1)), `Processed by ${many.slice(0, 10).map((r) => r.name).join(", ")} +2 more`);
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
  assert.equal(receiptLine(loaded, msg(1)), "Processed by reviewer");
});

test("the receipts tooltip matches the CLI, desktop and web text (ADR 0053)", async () => {
  const root = new URL("../../../", import.meta.url);
  const cli = await readFile(new URL("cli/src/receipts.rs", root), "utf8");
  const web = await readFile(new URL("public/app.js", root), "utf8");
  const quoted = JSON.stringify(RECEIPTS_MEANING);
  assert.ok(cli.includes(`pub const MEANING: &str = ${quoted};`), "cli/src/receipts.rs MEANING differs");
  assert.ok(web.includes(quoted), "public/app.js RECEIPTS_MEANING differs");
  assert.doesNotMatch(RECEIPTS_MEANING, /--resumable/);
});
