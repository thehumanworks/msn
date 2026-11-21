import { test } from "./support/bounded.ts";
import assert from "node:assert/strict";
import { ChannelController } from "../src/core/channelController.ts";
import { decodeMessage } from "../src/core/decode.ts";
import { answeredBy, choiceMode, choiceNote } from "../src/core/questions.ts";
import { SessionController } from "../src/core/sessionController.ts";
import { track } from "./support/bounded.ts";
import { startMockServer, TEST_TOKEN, type MockServerHandle } from "./support/mockServer.ts";
import { nodeFetch, waitFor } from "./support/util.ts";

// Ask a question with buttons (ADR 0065).

const fast = { stream: { waitSeconds: 1, backoff: { baseMs: 5, maxMs: 20 } }, connectBackoff: { baseMs: 5, maxMs: 20 } };

async function open(server: MockServerHandle, channel = "general") {
  server.createChannel(channel);
  const ctl = track(
    new SessionController(
      { origin: server.url, tenant: "acme", token: TEST_TOKEN, username: "tomas", usernamePrefix: null },
      { ...fast, fetchImpl: nodeFetch },
    ),
  );
  await ctl.start();
  const channelCtl = track(new ChannelController(ctl, channel, { baseMs: 5, maxMs: 20 }));
  channelCtl.start();
  await waitFor(() => channelCtl.state.get().phase === "ready", "channel ready");
  return { ctl, channelCtl };
}

const base = { id: 4, tenant: "acme", channel: "general", username: "lead", text: "Ship?", contentType: "text/plain", createdAt: "t" };

test("decode keeps choices, answer and answered, and refuses malformed ones", () => {
  const question = decodeMessage({
    ...base,
    to: "tomas",
    choices: ["yes", "no"],
    answered: { id: 5, choice: "no", username: "tomas", answeredAt: "t5" },
    answerer: "tomas",
  });
  assert.deepEqual(question.choices, ["yes", "no"]);
  assert.equal(question.answerer, "tomas");
  assert.equal(question.answered?.choice, "no");
  assert.equal(decodeMessage({ ...base, id: 5, replyTo: 4, answer: "no" }).answer, "no");
  for (const bad of [
    { choices: ["only"] },
    { choices: ["a", 2] },
    { answer: 3 },
    { answered: { id: 5, choice: "no" } },
    { answerer: 7 },
  ])
    assert.throws(() => decodeMessage({ ...base, ...bad }));
});

test("buttons are open only for the addressed name until the first answer", () => {
  const question = decodeMessage({ ...base, to: "tomas", choices: ["yes", "no"] });
  assert.equal(choiceMode(question, "tomas", true), "open");
  assert.equal(choiceMode(question, "tomas", false), "waiting");
  assert.equal(choiceMode(question, "asha", true), "waiting");
  assert.equal(choiceMode({ ...question, to: " Tomas " }, "tomas", true), "open");
  assert.equal(choiceMode({ ...question, to: "tomasz" }, "tomas", true), "waiting");
  // A resolved answerer is matched exactly: "bob" never answers a question for "Bob".
  const resolved = { ...question, to: "Bob", answerer: "Bob" };
  assert.equal(choiceMode(resolved, "Bob", true), "open");
  assert.equal(choiceMode(resolved, "bob", true), "waiting");
  assert.equal(choiceNote(resolved, "waiting"), "Waiting for Bob");
  assert.equal(choiceNote(question, "waiting"), "Waiting for tomas");
  const reply = decodeMessage({ ...base, id: 5, username: "tomas", replyTo: 4, answer: "no", createdAt: "t5" });
  const answered = answeredBy(reply);
  assert.deepEqual(answered, { id: 5, choice: "no", username: "tomas", answeredAt: "t5" });
  const locked = { ...question, answered: answered ?? undefined };
  assert.equal(choiceMode(locked, "tomas", true), "answered");
  assert.equal(choiceNote(locked, "answered"), "tomas answered no");
});

test("one tap answers; the question locks, and an answer from elsewhere locks it too", async () => {
  const server = await startMockServer();
  try {
    const mine = server.ask("general", "lead", "Ship it?", "tomas", ["yes", "no"]);
    const later = server.ask("general", "lead", "Tag it?", "tomas", ["tag", "skip"]);
    const { ctl, channelCtl } = await open(server);
    const find = (id: number) => channelCtl.state.get().messages.find((m) => m.id === id);
    assert.deepEqual(find(mine.id)?.choices, ["yes", "no"]);
    assert.equal(await channelCtl.answer(mine.id, "no"), null);
    assert.equal(find(mine.id)?.answered?.choice, "no");
    const reply = channelCtl.state.get().messages.find((m) => m.replyTo === mine.id);
    assert.equal(reply?.answer, "no");
    assert.equal(reply?.text, "no");
    // Answered from another device: the reply arrives and locks the loaded question.
    server.answer("general", "tomas", later.id, "skip");
    await waitFor(() => find(later.id)?.answered?.choice === "skip", "answer from elsewhere");
    // A second tap loses: the server says so and the first answer stays shown.
    const again = await channelCtl.answer(mine.id, "yes");
    assert.match(again ?? "", /already answered/);
    assert.equal(find(mine.id)?.answered?.choice, "no");
    channelCtl.dispose();
    ctl.dispose();
  } finally {
    await server.close();
  }
});

test("a second tap while the first answer is in flight sends nothing", async () => {
  const server = await startMockServer();
  try {
    const asked = server.ask("general", "lead", "Ship it?", "tomas", ["yes", "no"]);
    const { ctl, channelCtl } = await open(server);
    const posts = () =>
      server.requests.filter((r) => r.method === "POST" && r.path.endsWith("/channels/general/messages")).length;
    const before = posts();
    const [first, second] = await Promise.all([channelCtl.answer(asked.id, "yes"), channelCtl.answer(asked.id, "no")]);
    assert.equal(first, null);
    assert.equal(second, null);
    assert.equal(posts() - before, 1);
    assert.equal(channelCtl.state.get().messages.find((m) => m.id === asked.id)?.answered?.choice, "yes");
    channelCtl.dispose();
    ctl.dispose();
  } finally {
    await server.close();
  }
});

test("deleting the answer reopens the question's buttons", async () => {
  const server = await startMockServer();
  try {
    const asked = server.ask("general", "lead", "Ship it?", "tomas", ["yes", "no"]);
    const reply = server.answer("general", "tomas", asked.id, "no");
    const { ctl, channelCtl } = await open(server);
    const find = () => channelCtl.state.get().messages.find((m) => m.id === asked.id);
    assert.equal(find()?.answered?.choice, "no");
    server.remove(reply.id);
    await waitFor(() => find() !== undefined && find()?.answered === undefined, "question reopened");
    assert.equal(choiceMode(find()!, "tomas", true), "open");
    channelCtl.dispose();
    ctl.dispose();
  } finally {
    await server.close();
  }
});

test("only the addressed name can answer", async () => {
  const server = await startMockServer();
  try {
    const theirs = server.ask("general", "lead", "Merge?", "asha", ["merge", "hold"]);
    const { ctl, channelCtl } = await open(server);
    assert.match((await channelCtl.answer(theirs.id, "merge")) ?? "", /Only "asha"/);
    assert.equal(channelCtl.state.get().messages.find((m) => m.id === theirs.id)?.answered, undefined);
    assert.equal(await channelCtl.answer(999, "x"), "That question is no longer loaded.");
    channelCtl.dispose();
    ctl.dispose();
  } finally {
    await server.close();
  }
});
