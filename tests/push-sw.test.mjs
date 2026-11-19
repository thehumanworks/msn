import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../public/sw.js", import.meta.url), "utf8");

/** Run the service worker against a minimal fake of its global scope. */
function worker({ windows = [] } = {}) {
  const listeners = {};
  const shown = [];
  const opened = [];
  const self = {
    location: new URL("https://msn.test/sw.js"),
    addEventListener: (type, fn) => {
      listeners[type] = fn;
    },
    skipWaiting: () => {},
    registration: { showNotification: async (title, options) => shown.push({ title, options }) },
    clients: {
      claim: async () => {},
      matchAll: async () => windows,
      openWindow: async (url) => opened.push(url),
    },
  };
  vm.runInNewContext(source, { self, URL });
  const fire = async (type, event) => {
    let pending = Promise.resolve();
    listeners[type]({ ...event, waitUntil: (p) => (pending = p) });
    await pending;
  };
  return { fire, shown, opened };
}
/** Objects built inside the vm context come from another realm; compare their JSON. */
const plain = (value) => JSON.parse(JSON.stringify(value));
const push = (payload) => ({
  data: { json: () => (typeof payload === "string" ? JSON.parse(payload) : payload) },
});

test("shows a board notification as plain text, tagged per board", async () => {
  const sw = worker();
  await sw.fire(
    "push",
    push({
      schema: "msn.push.v1",
      tenant: "acme",
      channel: "release",
      messageId: 7,
      reason: "question",
      title: "#release",
      body: `lead: ${"<b>x</b>".repeat(60)}`,
    }),
  );
  assert.equal(sw.shown.length, 1);
  assert.equal(sw.shown[0].title, "#release");
  assert.equal(sw.shown[0].options.tag, "acme/release");
  assert.equal(sw.shown[0].options.body.length, 200);
  assert.deepEqual(plain(sw.shown[0].options.data), { tenant: "acme", channel: "release" });
});

test("an unexpected or malformed payload still shows a generic notification", async () => {
  for (const payload of [
    "{not json",
    { schema: "other" },
    { schema: "msn.push.v1", tenant: "../x", channel: "a" },
  ]) {
    const sw = worker();
    await sw.fire("push", push(payload));
    assert.deepEqual(plain(sw.shown), [{ title: "msn", options: { body: "An agent needs you." } }]);
  }
});

test("a click focuses an open app and asks it to open the board, or opens a new window", async () => {
  const messages = [];
  let focused = false;
  const open = {
    url: "https://msn.test/",
    focus: async () => {
      focused = true;
    },
    postMessage: (m) => messages.push(m),
  };
  const notification = { close: () => {}, data: { tenant: "acme", channel: "release" } };
  const withApp = worker({ windows: [open] });
  await withApp.fire("notificationclick", { notification });
  assert.ok(focused);
  assert.deepEqual(plain(messages), [{ type: "msn.open", tenant: "acme", channel: "release" }]);
  const closed = worker();
  await closed.fire("notificationclick", { notification });
  assert.deepEqual(plain(closed.opened), ["/?channel=release"]);
  const hostile = worker();
  await hostile.fire("notificationclick", { notification: { close: () => {}, data: { channel: "//evil" } } });
  assert.deepEqual(plain(hostile.opened), ["/"]);
});
