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

test("CLI infers an exact-bound sender without MSN_USERNAME and preserves explicit names", async () => {
  const noName = { ...env, MSN_USERNAME: undefined };
  const h = harness(
    ["send", "general", "--text", "ready", "--key", "ready-1"],
    [{ tenant: "team", username: "planner", usernamePrefix: null }, { message: { id: 1 } }],
    { env: noName },
  );
  await h.execute();
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[0].url, "https://msn.test/api/tenants/team");
  assert.deepEqual(JSON.parse(h.calls[1].body), { username: "planner", text: "ready" });
  assert.equal(h.calls[1].headers["Idempotency-Key"], "ready-1");
  const explicit = harness(["send", "general", "--text", "ready", "--username", "chosen"], [{}], {
    env: noName,
  });
  await explicit.execute();
  assert.equal(explicit.calls.length, 1);
  assert.equal(JSON.parse(explicit.calls[0].body).username, "chosen");
});

test("CLI requires a chosen name for prefix/unbound keys and validates payload before identity lookup", async () => {
  const noName = { ...env, MSN_USERNAME: undefined };
  for (const usernamePrefix of [null, "agent-"]) {
    const h = harness(
      ["send", "general", "--text", "ready"],
      [{ tenant: "team", username: null, usernamePrefix }],
      {
        env: noName,
      },
    );
    await assert.rejects(h.execute(), /no exact username binding/);
    assert.equal(h.calls.length, 1);
  }
  for (const argv of [
    ["send", "general", "--json", "{"],
    ["send", "general", "--text", "ready", "--correlation-id", " "],
    ["send", "general", "--text", "ready", "--username", ""],
  ]) {
    const h = harness(argv, [], { env: noName });
    await assert.rejects(h.execute());
    assert.equal(h.calls.length, 0);
  }
  const denied = harness(["send", "general", "--text", "ready"], [], {
    env: noName,
    fetcher: async () => Response.json({ error: { message: "revoked" } }, { status: 401 }),
  });
  await assert.rejects(denied.execute(), /401: revoked/);
});

test("CLI help is credential-free and malformed commands/unsafe origins fail before network", async () => {
  const h = harness(["--help"], [], { env: {} });
  await h.execute();
  assert.match(h.output[0], /cursor-file/);
  const profile = harness(["channels"], [], { env: { ...env, MSN_PROFILE: "planner" } });
  await assert.rejects(profile.execute(), /Rust CLI profile/);
  assert.equal(profile.calls.length, 0);
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

test("CLI addresses a username independently of reply and correlation annotations", async () => {
  const h = harness(
    [
      "send",
      "general",
      "--text",
      "review this",
      "--to",
      "reviewer",
      "--reply-to",
      "42",
      "--correlation-id",
      "task-7",
    ],
    [{}],
  );
  await h.execute();
  assert.deepEqual(JSON.parse(h.calls[0].body), {
    username: "free name",
    text: "review this",
    to: "reviewer",
    replyTo: 42,
    correlationId: "task-7",
  });
  for (const to of ["", " ", "😀".repeat(33)]) {
    const bad = harness(["send", "general", "--text", "review", "--to", to], [], {
      env: { ...env, MSN_USERNAME: undefined },
    });
    await assert.rejects(bad.execute(), /--to/);
    assert.equal(bad.calls.length, 0);
  }
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

test("CLI send forwards --quote with --reply-to and refuses it alone (ADR 0059)", async () => {
  const h = harness(
    ["send", "general", "--text", "Done", "--reply-to", "42", "--quote", "Then tag it."],
    [{}],
  );
  await h.execute();
  assert.deepEqual(JSON.parse(h.calls[0].body), {
    username: "free name",
    text: "Done",
    replyTo: 42,
    quote: "Then tag it.",
  });
  for (const argv of [
    ["send", "general", "--text", "x", "--quote", "alone"],
    ["send", "general", "--text", "x", "--reply-to", "4", "--quote", " "],
    ["send", "general", "--text", "x", "--reply-to", "4", "--quote", "x".repeat(2049)],
  ]) {
    const bad = harness(argv);
    await assert.rejects(bad.execute(), /--quote/);
    assert.equal(bad.calls.length, 0, argv.join(" "));
  }
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

test("CLI binds a token only through explicit flags; rotate keeps, clears or replaces the bind", async () => {
  const bound = harness(["provision", "thehuman", "--username", "thehuman"]);
  await bound.execute();
  assert.equal(bound.calls[0].method, "PUT");
  assert.equal(bound.calls[0].url, "https://msn.test/api/admin/tenants/thehuman");
  assert.equal(bound.calls[0].headers["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(bound.calls[0].body), { username: "thehuman" });
  const prefixed = harness(["provision", "agents", "--username-prefix", "agent-"]);
  await prefixed.execute();
  assert.deepEqual(JSON.parse(prefixed.calls[0].body), { usernamePrefix: "agent-" });
  // MSN_USERNAME is set in the shared env fixture and must not produce a body.
  const plain = harness(["provision", "plain"]);
  await plain.execute();
  assert.equal(plain.calls[0].body, undefined);
  assert.equal(plain.calls[0].headers["Content-Type"], undefined);
  const kept = harness(["rotate", "team"]);
  await kept.execute();
  assert.equal(kept.calls[0].body, undefined);
  const cleared = harness(["rotate", "team", "--unbind"]);
  await cleared.execute();
  assert.deepEqual(JSON.parse(cleared.calls[0].body), { username: null });
  const rebound = harness(["rotate", "team", "--username", "other"]);
  await rebound.execute();
  assert.deepEqual(JSON.parse(rebound.calls[0].body), { username: "other" });
  for (const argv of [
    ["provision", "team", "--username", "a", "--username-prefix", "b"],
    ["provision", "team", "--unbind"],
    ["rotate", "team", "--unbind", "--username", "a"],
  ]) {
    const h = harness(argv);
    await assert.rejects(h.execute(), /only one of/);
    assert.equal(h.calls.length, 0);
  }
  const overridden = harness(["send", "general", "--text", "hi", "--username", "flag name"], [{}]);
  await overridden.execute();
  assert.equal(JSON.parse(overridden.calls[0].body).username, "flag name");
  await assert.rejects(
    run({
      argv: ["send", "general", "--text", "hi"],
      env,
      out: noop,
      err: noop,
      fetcher: async () =>
        Response.json(
          { error: { code: "username_bound", message: 'This access key may only send as "thehuman".' } },
          { status: 403 },
        ),
    }),
    /403: This access key may only send as "thehuman"/,
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
    // A thread cursor written by the Rust CLI (ADR 0063) is never read or rewritten as a board cursor.
    await writeFile(
      file,
      JSON.stringify({ server: "https://msn.test", tenant: "team", channel: "general", after: 9, thread: 4 }),
    );
    const thread = harness(["follow", "general", "--cursor-file", file]);
    await assert.rejects(thread.execute(), /follows one thread/);
    assert.equal(thread.calls.length, 0);
    assert.equal(JSON.parse(await readFile(file, "utf8")).thread, 4);
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

test("CLI participant keys use admin routes and explicit bindings, never the ambient display name", async () => {
  for (const [args, method, path] of [
    [["keys"], undefined, "/keys"],
    [["key-create", "planner", "--username", "planner-agent"], "PUT", "/keys/planner"],
    [["key-create", "agents", "--username-prefix", "agent-"], "PUT", "/keys/agents"],
    [["key-revoke", "planner"], "DELETE", "/keys/planner"],
  ]) {
    const h = harness(args);
    await h.execute();
    assert.equal(h.calls[0].method, method);
    assert.equal(h.calls[0].url, `https://msn.test/api/admin/tenants/team${path}`);
    assert.equal(h.calls[0].headers.Authorization, "Bearer admin-secret");
    if (args[0] === "key-create") {
      assert.deepEqual(
        JSON.parse(h.calls[0].body),
        args[2] === "--username" ? { username: args[3] } : { usernamePrefix: args[3] },
      );
    }
  }
  for (const args of [
    ["key-create", "planner"],
    ["key-create", "planner", "--unbind"],
    ["key-create", "planner", "--username", ""],
    ["key-create", "planner", "--username", " "],
    ["key-create", "planner", "--username", "a", "--username-prefix", "agent-"],
    ["key-create", "UPPER", "--username", "a"],
    ["key-revoke", "UPPER"],
  ]) {
    const h = harness(args);
    await assert.rejects(h.execute());
    assert.equal(h.calls.length, 0);
  }
  const denied = harness(["keys"], [], { env: { ...env, MSN_ADMIN_TOKEN: "" } });
  await assert.rejects(denied.execute(), /MSN_ADMIN_TOKEN/);
  assert.equal(denied.calls.length, 0);
});

test("CLI whoami uses member credentials and canonical workspace env takes precedence over legacy aliases", async () => {
  const identity = { tenant: "canonical", username: "planner", usernamePrefix: null };
  const h = harness(["whoami"], [identity], {
    env: { ...env, MSN_WORKSPACE_TENANT: "canonical", MSN_WORKSPACE_TOKEN: "canonical-key" },
  });
  await h.execute();
  assert.equal(h.calls[0].url, "https://msn.test/api/tenants/canonical");
  assert.equal(h.calls[0].headers.Authorization, "Bearer canonical-key");
  assert.deepEqual(JSON.parse(h.output[0]), identity);
  const legacy = harness(["whoami"]);
  await legacy.execute();
  assert.equal(legacy.calls[0].url, "https://msn.test/api/tenants/team");
  assert.equal(legacy.calls[0].headers.Authorization, "Bearer tenant-secret");
  const missing = harness(["whoami"], [], { env: { ...env, MSN_WORKSPACE_TOKEN: "" } });
  await assert.rejects(missing.execute(), /MSN_WORKSPACE_TOKEN/);
  assert.equal(missing.calls.length, 0);
});

test("CLI follow locks its cursor before reading, refuses concurrent readers, and releases on abort", async () => {
  const dir = await mkdtemp(join(tmpdir(), "msn-cli-lock-"));
  const file = join(dir, "cursor.json");
  const controller = new AbortController();
  let ready;
  const started = new Promise((resolve) => {
    ready = resolve;
  });
  const first = harness(["follow", "general", "--cursor-file", file], [], {
    signal: controller.signal,
    fetcher: async () => {
      ready();
      return new Promise((_, reject) => {
        controller.signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
      });
    },
  });
  const running = first.execute();
  try {
    await started;
    const competitor = harness(["follow", "general", "--cursor-file", file]);
    await assert.rejects(competitor.execute(), /Cursor is locked/);
    assert.equal(competitor.calls.length, 0);
    const owner = JSON.parse(await readFile(`${file}.lock`, "utf8"));
    assert.equal(owner.pid, process.pid);
    controller.abort();
    await running;
    await assert.rejects(readFile(`${file}.lock`), { code: "ENOENT" });
    await assert.rejects(readFile(file), { code: "ENOENT" });
    // A stale lock is never guessed away, even if its PID looks impossible.
    await writeFile(`${file}.lock`, '{"pid":999999999}');
    await assert.rejects(competitor.execute(), /confirming the owner/);
    assert.equal(await readFile(`${file}.lock`, "utf8"), '{"pid":999999999}');
  } finally {
    controller.abort();
    await running;
    await rm(dir, { recursive: true, force: true });
  }
});

test("CLI follow releases locks on local/output/auth errors without advancing or retrying output", async () => {
  const dir = await mkdtemp(join(tmpdir(), "msn-cli-lock-error-"));
  const file = join(dir, "cursor.json");
  try {
    const original = { server: env.MSN_URL, tenant: env.MSN_TENANT, channel: "general", after: 3 };
    await writeFile(file, JSON.stringify(original));
    const h = harness(
      ["follow", "general", "--cursor-file", file],
      [{ messages: [{ id: 4 }], nextCursor: 4 }],
      {
        out: () => {
          throw new Error("output failed");
        },
      },
    );
    await assert.rejects(h.execute(), /output failed/);
    assert.equal(h.calls.length, 1);
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), original);
    await assert.rejects(readFile(`${file}.lock`), { code: "ENOENT" });
    const denied = harness(["follow", "general", "--cursor-file", file], [], {
      fetcher: async () => Response.json({ error: { message: "revoked" } }, { status: 401 }),
    });
    await assert.rejects(denied.execute(), /401/);
    await assert.rejects(readFile(`${file}.lock`), { code: "ENOENT" });
    await writeFile(file, "malformed");
    const corrupt = harness(["follow", "general", "--cursor-file", file]);
    await assert.rejects(corrupt.execute());
    assert.equal(corrupt.calls.length, 0);
    await assert.rejects(readFile(`${file}.lock`), { code: "ENOENT" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("wait --all needs a cursor file and matches every addressee ignoring case (ADR 0069)", async () => {
  const { addressedTo } = await import("../scripts/msn.mjs");
  assert.equal(addressedTo({ username: "lead", to: "a", recipients: ["a", " Tester "] }, "tester"), true);
  assert.equal(addressedTo({ username: "lead", to: "Bob" }, "bob"), true);
  assert.equal(addressedTo({ username: "lead" }, "bob"), false);
  assert.equal(addressedTo({ username: "bob", to: "bob" }, "bob"), false);
  await assert.rejects(harness(["wait", "general"]).execute(), /--all/);
  await assert.rejects(harness(["wait", "--all"]).execute(), /--cursor-file/);
  const dir = await mkdtemp(join(tmpdir(), "msn-wait-all-"));
  try {
    await assert.rejects(
      harness(["wait", "--all", "--cursor-file", join(dir, "c.json"), "--after", "3"]).execute(),
      /--after and --limit/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("wait --all retries every read, folds the sender and moves only the woken board (ADR 0069)", async () => {
  const { addressedTo } = await import("../scripts/msn.mjs");
  assert.equal(addressedTo({ username: " Reviewer", to: "reviewer" }, "REVIEWER"), false);
  const dir = await mkdtemp(join(tmpdir(), "msn-wait-all-"));
  const file = join(dir, "boards.json");
  const hit = { id: 5, username: "lead", to: "x", recipients: ["x", "Tester"], text: "check" };
  const replies = [
    [503, { error: { message: "busy" } }],
    [200, { head: 9 }],
    [200, { channels: [{ name: "alpha" }, { name: "beta" }], hasMore: false }],
    [200, { messages: [{ id: 2, username: "lead", text: "hi" }], nextCursor: 2, hasMore: false }],
    [500, { error: { message: "oops" } }],
    [200, { messages: [{ id: 4, username: "lead", text: "context" }, hit], nextCursor: 5, hasMore: false }],
    [200, { messages: [{ id: 4, username: "lead", text: "context" }, hit], nextCursor: 5, hasMore: false }],
  ];
  const calls = [];
  const output = [];
  try {
    await run({
      argv: ["wait", "--all", "--cursor-file", file, "--username", "tester", "--wait", "0"],
      env: { ...env, MSN_USERNAME: undefined },
      out: (s) => output.push(s),
      err: () => {},
      fetcher: async (url) => {
        calls.push(url);
        const [status, body] = replies.shift();
        return Response.json(body, { status });
      },
    });
    const printed = JSON.parse(output[0]);
    assert.equal(printed.channel, "beta");
    assert.equal(printed.message.id, 5);
    assert.deepEqual(
      printed.messages.map((m) => m.id),
      [4, 5],
    );
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")).boards, { beta: 5 });
    assert.equal(calls.filter((url) => url.endsWith("/events/head")).length, 2, "the 503 was retried");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
