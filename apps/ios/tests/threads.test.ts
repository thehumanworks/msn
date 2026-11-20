import { test } from "./support/bounded.ts";
import assert from "node:assert/strict";
import { ApiError } from "../src/core/errors.ts";
import { arrivedUnseen, firstUnseen, ParentLoader, threadLabel, threadRoots, threadRows } from "../src/core/threads.ts";
import type { Message } from "../src/core/types.ts";

const message = (id: number, replyTo?: number, username = "asha"): Message => ({
  id,
  tenant: "acme",
  channel: "general",
  username,
  text: `m${id}`,
  contentType: "text/plain",
  createdAt: "2026-11-19T00:00:00.000Z",
  ...(replyTo === undefined ? {} : { replyTo }),
});

const shape = (rows: ReturnType<typeof threadRows>) =>
  rows.map((row) => (row.kind === "message" ? `${row.message.id}:${row.replies}${row.open ? "+" : ""}` : `  ${row.message.id}`));

test("replies fold under their root in id order; a reply to a reply joins the same thread", () => {
  // 5 replies to 99, which is not loaded: it stays in the log and 6 folds under it.
  const messages = [message(1), message(2, 1), message(3), message(4, 2), message(5, 99), message(6, 5)];
  assert.deepEqual(shape(threadRows(messages, new Set())), ["1:2", "3:0", "5:1"]);
  assert.deepEqual(shape(threadRows(messages, new Set([1, 3]))), ["1:2+", "  2", "  4", "3:0", "5:1"]);
  // Input is never changed.
  assert.deepEqual(
    messages.map((m) => m.id),
    [1, 2, 3, 4, 5, 6],
  );
});

test("toggle labels count replies", () => {
  assert.equal(threadLabel(1, false), "Show 1 reply");
  assert.equal(threadLabel(3, true), "Hide 3 replies");
  assert.equal(threadLabel(3, false, 1), "Show 3 replies · 1 new");
});

test("a reply from someone else that lands in a folded thread is unseen until it opens", () => {
  const before = [message(1), message(2, 1)];
  const after = [...before, message(3), message(4, 2, "bob"), message(5, 1, "me"), message(6, 3, "bob")];
  const known = new Set(before.map((m) => m.id));
  // 4 joins 1's folded thread; 5 is your own; 6 joins 3's thread, which is open.
  const unseen = new Set(arrivedUnseen(known, after, new Set([3]), "me"));
  assert.deepEqual([...unseen], [4]);
  assert.deepEqual(firstUnseen(after, unseen), { root: 1, id: 4 });
  const root = threadRows(after, new Set([3]), unseen)[0];
  assert.equal(root.kind === "message" && root.unseen, 1);
  // Opening the thread shows it: an open root counts nothing as unseen.
  const open = threadRows(after, new Set([1, 3]), unseen)[0];
  assert.equal(open.kind === "message" && open.unseen, 0);
  assert.equal(threadRoots(after).get(4), 1);
});

test("a missing parent is fetched once; a deleted one reads as gone; a failure can be retried", async () => {
  const calls: number[] = [];
  let fail = true;
  const loader = new ParentLoader(
    {
      async getMessage(_channel: string, id: number) {
        calls.push(id);
        if (id === 7) throw new ApiError(404, "message_not_found", "Message not found.");
        if (id === 9) throw new ApiError(410, "message_deleted", "This message was deleted.");
        if (id === 8 && fail) throw new ApiError(503, "unavailable", "Try later.");
        return { message: message(id), historyRevision: 0 };
      },
    },
    "general",
  );
  await loader.load(2);
  await loader.load(2);
  assert.deepEqual(calls, [2]);
  assert.equal(loader.state.get().get(2)?.status, "loaded");
  await loader.load(7);
  assert.deepEqual(loader.state.get().get(7), { status: "loaded", message: null });
  await loader.load(9);
  assert.deepEqual(loader.state.get().get(9), { status: "loaded", message: null });
  await loader.load(8);
  assert.equal(loader.state.get().get(8)?.status, "error");
  fail = false;
  await loader.load(8);
  assert.equal(loader.state.get().get(8)?.status, "loaded");
});
