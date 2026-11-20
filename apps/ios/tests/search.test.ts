import { test } from "./support/bounded.ts";
import assert from "node:assert/strict";
import { ApiClient } from "../src/core/apiClient.ts";
import { decodeSearchPage } from "../src/core/decode.ts";
import { ProtocolError } from "../src/core/errors.ts";
import { ChannelSearch, parseSearch, searchSummary } from "../src/core/search.ts";
import type { SearchPage } from "../src/core/types.ts";
import { startMockServer, TEST_TOKEN } from "./support/mockServer.ts";
import { nodeFetch } from "./support/util.ts";

const message = (id: number, channel = "general") => ({
  id,
  tenant: "acme",
  channel,
  username: "asha",
  text: `m${id}`,
  contentType: "text/plain",
  createdAt: "2026-11-19T00:00:00.000Z",
});

test("parseSearch takes the last from:name and keeps the rest as words", () => {
  assert.deepEqual(parseSearch('deploy from:ada  "on friday"'), { q: 'deploy "on friday"', from: "ada" });
  assert.deepEqual(parseSearch("from: plain"), { q: "from: plain", from: "" });
  assert.deepEqual(parseSearch("from:a from:b"), { q: "", from: "b" });
});

test("decodeSearchPage requires newest-first results from the asked channel", () => {
  const page = decodeSearchPage(
    { messages: [message(9), message(4)], hasMore: true, nextBefore: 4, complete: false },
    "general",
  );
  assert.deepEqual(
    [page.messages.map((m) => m.id), page.nextBefore, page.complete],
    [[9, 4], 4, false],
  );
  for (const bad of [
    { messages: [message(4), message(9)], hasMore: false },
    { messages: [message(9, "other")], hasMore: false },
    { messages: [], hasMore: true },
    { messages: "x", hasMore: false },
  ])
    assert.throws(() => decodeSearchPage(bad, "general"), ProtocolError);
});

test("searchMessages sends q, from and before and pages through the fixture", async () => {
  const server = await startMockServer();
  try {
    const api = new ApiClient(server.url, "acme", TEST_TOKEN, nodeFetch);
    await api.createChannel("general");
    for (let i = 0; i < 3; i++) server.post("general", "asha", `deploy ${i}`);
    server.post("general", "ben", "deploy by ben");
    const first = await api.searchMessages("general", { q: "deploy", from: "asha", limit: 2 });
    assert.deepEqual(first.messages.map((m) => m.text), ["deploy 2", "deploy 1"]);
    const query = new URLSearchParams(server.requests.at(-1)!.query);
    assert.deepEqual([query.get("q"), query.get("from"), query.get("before")], ["deploy", "asha", null]);
    const next = await api.searchMessages("general", { q: "deploy", from: "asha", before: first.nextBefore, limit: 2 });
    assert.deepEqual(next.messages.map((m) => m.text), ["deploy 0"]);
    assert.equal(next.hasMore, false);
  } finally {
    await server.close();
  }
});

test("ChannelSearch shows only the newest query's answer and pages older matches", async () => {
  const answers: Array<(page: SearchPage) => void> = [];
  const calls: Array<{ q?: string; from?: string; before?: number }> = [];
  const api = {
    searchMessages: (_channel: string, query: { q?: string; from?: string; before?: number }) => {
      calls.push(query);
      return new Promise<SearchPage>((resolve) => answers.push(resolve));
    },
  };
  const search = new ChannelSearch(api as unknown as ApiClient, "general");
  const stale = search.search("old");
  const fresh = search.search("deploy from:asha");
  answers[0]({ messages: [message(99) as never], hasMore: false, complete: true });
  answers[1]({ messages: [message(8) as never, message(5) as never], hasMore: true, nextBefore: 5, complete: true });
  await Promise.all([stale, fresh]);
  assert.deepEqual(
    search.state.get().results.map((m) => m.id),
    [8, 5],
  );
  assert.deepEqual(calls[1], { q: "deploy", from: "asha", before: undefined, limit: 20 });
  assert.equal(searchSummary(search.state.get()), "2+ messages matching “deploy” from asha, newest first");
  const older = search.older();
  assert.equal(calls[2].before, 5);
  answers[2]({ messages: [message(3) as never], hasMore: false, complete: false });
  await older;
  assert.deepEqual(
    search.state.get().results.map((m) => m.id),
    [8, 5, 3],
  );
  assert.match(searchSummary(search.state.get()), /3 messages .* still being indexed$/);
  await search.search("   ");
  assert.equal(search.state.get().active, false);
});
