import assert from "node:assert/strict";
import { test } from "node:test";
import { answerBody, answeredBy, awaitedName, choiceState, choicesOf } from "../public/choices.js";

// Ask a question with buttons (ADR 0065): how the web app reads questions and answers.

test("only a message with two or more string choices is a question", () => {
  assert.deepEqual(choicesOf({ choices: ["yes", "no"] }), ["yes", "no"]);
  assert.equal(choicesOf({ choices: ["yes"] }), null);
  assert.equal(choicesOf({ choices: ["yes", 2] }), null);
  assert.equal(choicesOf({ choices: "yes,no" }), null);
  assert.equal(choicesOf({}), null);
  assert.equal(choicesOf(null), null);
});

test("an answer reply becomes the question's answered record", () => {
  assert.deepEqual(answeredBy({ id: 8, replyTo: 5, answer: "no", username: "tomas", createdAt: "t" }), {
    id: 8,
    choice: "no",
    username: "tomas",
    answeredAt: "t",
  });
  assert.equal(answeredBy({ id: 8, replyTo: 5, text: "no" }), null);
  assert.equal(answeredBy({ id: 8, answer: "no" }), null);
});

test("buttons are open only for the addressed name, until the first answer", () => {
  const question = { id: 5, to: "tomas", choices: ["yes", "no"] };
  assert.equal(choiceState(question, "tomas"), "open");
  assert.equal(choiceState(question, "agent"), "waiting");
  // `to` matches exactly, or trimmed and ignoring case, as on the server.
  assert.equal(choiceState({ ...question, to: " Tomas " }, "tomas"), "open");
  assert.equal(choiceState({ ...question, to: "tomasz" }, "tomas"), "waiting");
  // A resolved answerer is matched exactly: "bob" never answers a question for "Bob".
  const resolved = { ...question, to: "Bob", answerer: "Bob" };
  assert.equal(choiceState(resolved, "Bob"), "open");
  assert.equal(choiceState(resolved, "bob"), "waiting");
  assert.equal(awaitedName(resolved), "Bob");
  assert.equal(choiceState(question, undefined), "waiting");
  assert.equal(choiceState(question, "tomas", { interactive: false }), "waiting");
  assert.equal(choiceState({ ...question, answered: { id: 8, choice: "no" } }, "tomas"), "answered");
});

test("an answer posts the choice as both text and answer", () => {
  assert.deepEqual(answerBody("tomas", { id: 5 }, "yes"), {
    username: "tomas",
    text: "yes",
    replyTo: 5,
    answer: "yes",
  });
});
