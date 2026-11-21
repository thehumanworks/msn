import assert from "node:assert/strict";
import { test } from "node:test";
import { failureText, webhookHost, webhookSummary } from "../public/webhook.js";

// Wake an agent with a webhook (ADR 0062): the web Agents panel's one-line webhook status.

const now = Date.parse("2026-11-21T12:00:00Z");
const hook = (lastDelivery) => ({ url: "https://agent.example.com/wake?x=1", lastDelivery });

test("no webhook shows nothing; a new one says nothing was sent", () => {
  assert.equal(webhookSummary(null, now), null);
  assert.equal(webhookSummary(hook(null), now), "Wakes agent.example.com · nothing sent yet");
});

test("each delivery outcome reads as words", () => {
  assert.equal(
    webhookSummary(hook({ status: "delivered", at: "2026-11-21T11:57:00Z", error: null }), now),
    "Wakes agent.example.com · delivered 3 min ago",
  );
  assert.equal(
    webhookSummary(hook({ status: "retrying", at: "2026-11-21T11:59:59Z", error: "http_503" }), now),
    "Wakes agent.example.com · retrying: it answered HTTP 503",
  );
  assert.equal(
    webhookSummary(hook({ status: "failed", at: "2026-11-21T10:00:00Z", error: "timeout" }), now),
    "Wakes agent.example.com · failed 2 h ago: no answer within 5 seconds",
  );
  assert.equal(
    webhookSummary(hook({ status: "dropped", at: "2026-11-21T12:00:00Z", error: "backlog_full" }), now),
    "Wakes agent.example.com · 50 notices were already waiting, so a new one was dropped",
  );
});

test("unknown errors and hosts fall back to their raw text", () => {
  assert.equal(failureText({ error: "something_new" }), "something_new");
  assert.equal(failureText({ error: null }), "");
  assert.equal(
    failureText({ error: "redirect_refused" }),
    "it answered with a redirect, which is not followed",
  );
  assert.equal(webhookHost("not a url"), "not a url");
});
