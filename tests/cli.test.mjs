import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { run } from "../scripts/msn.mjs";

const env = {
  MSN_URL: "https://msn.test",
  MSN_TENANT: "team",
  MSN_TOKEN: "tenant-secret",
  MSN_ADMIN_TOKEN: "admin-secret",
  MSN_USERNAME: "free name",
};
const noop = () => {};
function harness(argv, responses = [{}], extra = {}) {
  const calls = [];
  const output = [];
  const errors = [];
  const options = {
    argv,
    env,
    out: (s) => output.push(s),
    err: (s) => errors.push(s),
    fetcher: async (url, init) => {
      calls.push({ url, ...init });
      const item = responses.shift();
      if (item instanceof Error) throw item;
      return Response.json(item ?? {});
    },
    ...extra,
  };
  return { execute: () => run(options), calls, output, errors };
}

test("CLI help is credential-free and malformed commands/unsafe origins fail before network", async () => {
  const h = harness(["--help"], [], { env: {} });
  await h.execute();
  assert.match(h.output[0], /cursor-file/);
  for (const argv of [
    ["unknown"],
    ["poll"],
    ["send", "UPPER", "--text", "x"],
    ["poll", "general", "--after", "-1"],
    ["follow", "general", "--wait", "0"],
    ["poll", "general", "--limit", "0"],
    ["poll", "general", "--bogus"],
  ]) {
    const h = harness(argv);
    await assert.rejects(h.execute());
    assert.equal(h.calls.length, 0);
  }
  for (const MSN_URL of [
    "http://remote.test",
    "https://user:password@msn.test",
    "https://msn.test/path",
    "https://msn.test/?token=secret",
  ]) {
    const h = harness(["channels"], [], { env: { ...env, MSN_URL } });
    await assert.rejects(h.execute());
    assert.equal(h.calls.length, 0);
  }
});

test("CLI send preserves display username and explicit retry key; stdout stays JSON", async () => {
  const h = harness(["send", "general", "--text", "hello 👋", "--key", "same-key"], [{ message: { id: 1 } }]);
  await h.execute();
  assert.equal(h.calls[0].headers.Authorization, "Bearer tenant-secret");
  assert.equal(h.calls[0].headers["Idempotency-Key"], "same-key");
  assert.deepEqual(JSON.parse(h.calls[0].body), { username: "free name", text: "hello 👋" });
  assert.deepEqual(JSON.parse(h.output[0]), { message: { id: 1 } });
  assert.deepEqual(h.errors, ["Idempotency-Key: same-key"]);
  assert.equal(h.calls[0].redirect, "error");
});

test("CLI send forwards --reply-to and --correlation-id only when given, and rejects bad values offline", async () => {
  const h = harness(
    ["send", "general", "--text", "pong", "--reply-to", "42", "--correlation-id", "task-7"],
    [{ message: { id: 43, replyTo: 42, correlationId: "task-7" } }],
  );
  await h.execute();
  assert.deepEqual(JSON.parse(h.calls[0].body), {
    username: "free name",
    text: "pong",
    replyTo: 42,
    correlationId: "task-7",
  });
  assert.deepEqual(JSON.parse(h.output[0]), { message: { id: 43, replyTo: 42, correlationId: "task-7" } });
  const only = harness(["send", "general", "--text", "x", "--correlation-id", "only"], [{}]);
  await only.execute();
  assert.deepEqual(Object.keys(JSON.parse(only.calls[0].body)), ["username", "text", "correlationId"]);
  const plain = harness(["send", "general", "--text", "x"], [{}]);
  await plain.execute();
  assert.deepEqual(Object.keys(JSON.parse(plain.calls[0].body)), ["username", "text"]);
  for (const argv of [
    ["send", "general", "--text", "x", "--reply-to", "0"],
    ["send", "general", "--text", "x", "--reply-to", "-1"],
    ["send", "general", "--text", "x", "--reply-to", "1.5"],
    ["send", "general", "--text", "x", "--reply-to", "07"],
    ["send", "general", "--text", "x", "--correlation-id", " "],
    ["send", "general", "--text", "x", "--correlation-id", "x".repeat(129)],
    ["send", "general", "--text", "x", "--correlation-id", "🙂".repeat(33)],
  ]) {
    const bad = harness(argv);
    await assert.rejects(bad.execute());
    assert.equal(bad.calls.length, 0, argv.join(" "));
  }
  const max = harness(["send", "general", "--text", "x", "--correlation-id", "🙂".repeat(32)], [{}]);
  await max.execute();
  assert.equal(JSON.parse(max.calls[0].body).correlationId, "🙂".repeat(32));
});

test("CLI --text sends omit contentType; --json validates locally and marks application/json", async () => {
  const plain = harness(["send", "general", "--text", "hello"], [{ message: { id: 1 } }]);
  await plain.execute();
  assert.equal("contentType" in JSON.parse(plain.calls[0].body), false);
  const command = '{"op":"ping","task":42}';
  const typed = harness(["send", "general", "--json", command, "--key", "cmd-1"], [{ message: { id: 2 } }]);
  await typed.execute();
  assert.equal(typed.calls.length, 1);
  assert.deepEqual(JSON.parse(typed.calls[0].body), {
    username: "free name",
    text: command,
    contentType: "application/json",
  });
  assert.equal(typed.calls[0].headers["Idempotency-Key"], "cmd-1");
  assert.deepEqual(JSON.parse(typed.output[0]), { message: { id: 2 } });
  for (const json of ['{"op":', "not json", "{'op':'ping'}", "", "  "]) {
    const h = harness(["send", "general", "--json", json]);
    await assert.rejects(h.execute(), (error) => error.exitCode === 2);
    assert.equal(h.calls.length, 0, json);
    assert.equal(h.errors.length, 0, "no retry key is printed for a rejected payload");
  }
  const both = harness(["send", "general", "--text", "x", "--json", "{}"]);
  await assert.rejects(both.execute(), (error) => error.exitCode === 2 && /not both/.test(error.message));
  assert.equal(both.calls.length, 0);
  const neither = harness(["send", "general"]);
  await assert.rejects(neither.execute(), (error) => error.exitCode === 2);
  assert.equal(neither.calls.length, 0);
});

test("CLI poll supports single/long polling and rereads exactly the requested cursor", async () => {
  const h = harness(["poll", "general", "--after", "42", "--wait", "25", "--limit", "2"]);
  await h.execute();
  assert.match(h.calls[0].url, /messages\?after=42&wait=25&limit=2$/);
  const once = harness(["poll", "general"]);
  await once.execute();
  assert.match(once.calls[0].url, /wait=0/);
});

test("CLI admin commands use only the admin capability and restricted route", async () => {
  for (const [args, method, path] of [
    [["provision", "new"], "PUT", "/api/admin/tenants/new"],
    [["rotate", "new"], "POST", "/api/admin/tenants/new/token"],
    [["delete", "general", "5"], "DELETE", "/api/admin/tenants/team/channels/general/messages/5"],
  ]) {
    const h = harness(args);
    await h.execute();
    assert.equal(h.calls[0].method, method);
    assert.equal(h.calls[0].url, `https://msn.test${path}`);
    assert.equal(h.calls[0].headers.Authorization, "Bearer admin-secret");
  }
  await assert.rejects(
    run({ argv: ["delete", "general", "5"], env: { ...env, MSN_ADMIN_TOKEN: "" }, out: noop }),
    /MSN_ADMIN_TOKEN/,
  );
});

test("CLI follows JSON lines and resumes an atomically written context-bound cursor", async () => {
  const dir = await mkdtemp(join(tmpdir(), "msn-cli-"));
  const file = join(dir, "cursor.json");
  try {
    const controller = new AbortController();
    const h = harness(
      ["follow", "general", "--cursor-file", file],
      [{ messages: [{ id: 7 }, { id: 8 }], nextCursor: 8 }],
      {
        signal: controller.signal,
        out: (line) => {
          assert.ok(JSON.parse(line).id);
          if (JSON.parse(line).id === 8) controller.abort();
        },
      },
    );
    await h.execute();
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), {
      server: "https://msn.test",
      tenant: "team",
      channel: "general",
      after: 8,
    });
    const resumed = new AbortController();
    const again = harness(
      ["follow", "general", "--cursor-file", file],
      [{ messages: [{ id: 9 }], nextCursor: 9 }],
      { signal: resumed.signal, out: () => resumed.abort() },
    );
    await again.execute();
    assert.match(again.calls[0].url, /after=8/);
    await writeFile(
      file,
      JSON.stringify({ server: "https://other.test", tenant: "team", channel: "general", after: 9 }),
    );
    const wrong = harness(["follow", "general", "--cursor-file", file]);
    await assert.rejects(wrong.execute(), /different server/);
    assert.equal(wrong.calls.length, 0);
  } finally {
    await rm(dir, { recursive: true });
  }
});

test("CLI follow retries transient failures but stops on authentication failures", async () => {
  const controller = new AbortController();
  const h = harness(
    ["follow", "general"],
    [new TypeError("network failed"), { messages: [{ id: 1 }], nextCursor: 1 }],
    { signal: controller.signal, out: () => controller.abort() },
  );
  await h.execute();
  assert.equal(h.calls.length, 2);
  assert.match(h.errors[0], /cursor 0/);
  await assert.rejects(
    run({
      argv: ["follow", "general"],
      env,
      out: noop,
      err: noop,
      fetcher: async () => Response.json({ error: { message: "denied" } }, { status: 401 }),
    }),
    /401: denied/,
  );
});
