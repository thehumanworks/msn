import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const cwd = fileURLToPath(new URL("..", import.meta.url));
const dir = await mkdtemp(join(tmpdir(), "msn-swarm-e2e-"));
const reservation = createServer();
await new Promise((resolve, reject) => {
  reservation.once("error", reject);
  reservation.listen(0, "127.0.0.1", resolve);
});
const port = reservation.address().port;
await new Promise((resolve) => reservation.close(resolve));

const url = `http://127.0.0.1:${port}`;
const admin = "isolated-swarm-admin-token-000000000000";
const baseEnv = {
  PATH: process.env.PATH,
  HOME: dir,
  XDG_CONFIG_HOME: join(dir, "config"),
  XDG_STATE_HOME: join(dir, "state"),
  MSN_URL: url,
  MSN_WORKSPACE_TENANT: "swarm-team",
};
const server = spawn(
  join(cwd, "node_modules/.bin/wrangler"),
  ["dev", "--ip", "127.0.0.1", "--port", String(port), "--persist-to", join(dir, "worker")],
  {
    cwd,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ADMIN_TOKEN: admin, WRANGLER_SEND_METRICS: "false" },
  },
);
let serverLog = "";
server.on("error", (error) => {
  serverLog += error.message;
});
for (const stream of [server.stdout, server.stderr]) {
  stream.on("data", (chunk) => {
    serverLog = (serverLog + chunk).slice(-20000);
  });
}

async function rustOutput(args, overrides = {}) {
  const result = await exec(join(cwd, "cli/target/debug/msn"), args, {
    cwd,
    env: { ...baseEnv, ...overrides },
    timeout: 15000,
  });
  return { json: JSON.parse(result.stdout), stdout: result.stdout };
}

async function rust(args, overrides = {}) {
  return (await rustOutput(args, overrides)).json;
}

async function attempt(args, overrides = {}) {
  try {
    return { ok: true, value: await rust(args, overrides) };
  } catch (error) {
    return { ok: false, error };
  }
}

function snapshotArgs({ text, coversThrough, baseVersion, historyRevision, key }) {
  return [
    "snapshot",
    "publish",
    "long-run",
    "--text",
    text,
    "--covers-through",
    String(coversThrough),
    "--base-version",
    String(baseVersion),
    "--history-revision",
    String(historyRevision),
    "--key",
    key,
  ];
}

try {
  let ready = false;
  for (let i = 0; i < 200; i++) {
    try {
      if ((await fetch(`${url}/api/health`)).ok) {
        ready = true;
        break;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(ready, `local worker failed to start: ${serverLog.slice(-1200)}`);

  const adminEnv = { MSN_ADMIN_TOKEN: admin };
  await rust(["provision", "swarm-team", "--username", "bootstrap"], adminEnv);
  const author = await rust(["key-create", "author", "--username", "snapshot-author"], adminEnv);
  const reader = await rust(["key-create", "reader", "--username", "returning-agent"], adminEnv);
  const authorEnv = { MSN_WORKSPACE_TOKEN: author.token };
  const readerEnv = { MSN_WORKSPACE_TOKEN: reader.token };

  const first = await rust(
    ["send", "long-run", "--text", "initial objective", "--key", "message-initial"],
    authorEnv,
  );
  const firstId = first.message.id;

  // Establish an ordinary reader cursor. Snapshot and catchup commands must never touch it.
  assert.deepEqual(
    (await rust(["read", "long-run"], readerEnv)).messages.map((message) => message.id),
    [firstId],
  );
  const withoutSnapshot = await rust(["catchup", "long-run"], readerEnv);
  assert.equal(withoutSnapshot.snapshot, null);
  assert.equal(withoutSnapshot.snapshotDue, true);
  assert.ok(withoutSnapshot.snapshotDueReasons.includes("no_snapshot"));

  // The summary is authored from firstId while a new message arrives. It must remain in the tail.
  const appended = await rust(
    ["send", "long-run", "--text", "arrived while summary was authored", "--key", "message-appended"],
    authorEnv,
  );
  const appendedId = appended.message.id;
  const version1Args = snapshotArgs({
    text: "# Checkpoint one\nCovers the initial objective.",
    coversThrough: firstId,
    baseVersion: 0,
    historyRevision: 0,
    key: "snapshot-v1",
  });
  const version1 = await rust(version1Args, authorEnv);
  assert.equal(version1.snapshot.version, 1);
  const afterVersion1 = await rust(["catchup", "long-run", "--limit", "1"], readerEnv);
  assert.equal(afterVersion1.snapshot.version, 1);
  assert.deepEqual(
    afterVersion1.messages.map((message) => message.id),
    [appendedId],
  );

  // Two writers race on one base. Exactly one advances the immutable version chain.
  const competitors = [
    {
      text: "# Competing checkpoint A",
      coversThrough: appendedId,
      baseVersion: 1,
      historyRevision: 0,
      key: "snapshot-race-a",
    },
    {
      text: "# Competing checkpoint B",
      coversThrough: appendedId,
      baseVersion: 1,
      historyRevision: 0,
      key: "snapshot-race-b",
    },
  ];
  const race = await Promise.all(competitors.map((candidate) => attempt(snapshotArgs(candidate), authorEnv)));
  assert.equal(race.filter((result) => result.ok).length, 1);
  assert.equal(race.filter((result) => !result.ok).length, 1);
  assert.match(race.find((result) => !result.ok).error.stderr, /409:.*baseVersion is stale/i);
  const winnerIndex = race.findIndex((result) => result.ok);
  const winner = competitors[winnerIndex];
  assert.equal(race[winnerIndex].value.snapshot.version, 2);

  const version3 = await rust(
    snapshotArgs({
      text: "# Checkpoint three",
      coversThrough: appendedId,
      baseVersion: 2,
      historyRevision: 0,
      key: "snapshot-v3",
    }),
    authorEnv,
  );
  assert.equal(version3.snapshot.version, 3);
  const replayAfterNewer = await rust(snapshotArgs(winner), authorEnv);
  assert.equal(replayAfterNewer.replayed, true);
  assert.equal(replayAfterNewer.snapshot.version, 2);

  // Redaction invalidates every derived checkpoint and blocks an author with a stale revision.
  await rust(["delete", "long-run", String(appendedId)], adminEnv);
  const invalidatedList = await rust(["snapshot", "list", "long-run"], authorEnv);
  assert.equal(invalidatedList.historyRevision, 1);
  assert.equal(invalidatedList.snapshotVersion, 3);
  assert.ok(invalidatedList.snapshots.every((snapshot) => snapshot.invalidated));
  assert.ok(invalidatedList.snapshots.every((snapshot) => !("text" in snapshot)));
  const invalidatedShow = await attempt(["snapshot", "show", "long-run", "3"], authorEnv);
  assert.equal(invalidatedShow.ok, false);
  assert.match(invalidatedShow.error.stderr, /410:.*invalidated/i);
  const invalidatedReplay = await attempt(snapshotArgs(winner), authorEnv);
  assert.equal(invalidatedReplay.ok, false);
  assert.match(invalidatedReplay.error.stderr, /410:.*invalidated/i);
  const stalePublish = await attempt(
    snapshotArgs({
      text: "# Stale redaction view",
      coversThrough: appendedId,
      baseVersion: 3,
      historyRevision: 0,
      key: "snapshot-stale-after-delete",
    }),
    authorEnv,
  );
  assert.equal(stalePublish.ok, false);
  assert.match(stalePublish.error.stderr, /409:.*History changed/i);
  const afterRedaction = await rust(["catchup", "long-run"], readerEnv);
  assert.equal(afterRedaction.snapshot, null);
  assert.equal(afterRedaction.snapshotVersion, 3);
  assert.equal(afterRedaction.historyRevision, 1);
  assert.ok(afterRedaction.messages.every((message) => message.id !== appendedId));

  // A fresh revision may repair the chain at the redacted positional watermark.
  const repaired = await rust(
    snapshotArgs({
      text: "# Repaired checkpoint\nRedacted content is absent.",
      coversThrough: appendedId,
      baseVersion: 3,
      historyRevision: 1,
      key: "snapshot-v4-repair",
    }),
    authorEnv,
  );
  assert.equal(repaired.snapshot.version, 4);
  assert.equal(repaired.snapshot.historyRevision, 1);

  // Build a long tail large enough to trigger both measured checkpoint reminders.
  const longMessages = await Promise.all(
    Array.from({ length: 20 }, (_, index) =>
      rust(
        [
          "send",
          "long-run",
          "--text",
          `long-horizon-${String(index).padStart(2, "0")}:${"x".repeat(900)}`,
          "--key",
          `long-horizon-${index}`,
        ],
        authorEnv,
      ),
    ),
  );
  const longIds = longMessages.map((result) => result.message.id).sort((a, b) => a - b);
  const bounded = await rustOutput(["catchup", "long-run", "--limit", "3", "--max-bytes", "4096"], readerEnv);
  assert.ok(Buffer.byteLength(bounded.stdout.trim(), "utf8") <= 4096);
  assert.equal(bounded.json.snapshot.version, 4);
  assert.deepEqual(
    bounded.json.messages.map((message) => message.id),
    longIds.slice(0, 3),
  );
  assert.equal(bounded.json.hasMore, true);
  assert.equal(bounded.json.incomplete, true);
  assert.equal(bounded.json.pendingMessages, 20);
  assert.ok(bounded.json.pendingBytes >= 16384);
  assert.deepEqual(
    new Set(bounded.json.snapshotDueReasons),
    new Set(["message_threshold", "byte_threshold"]),
  );
  assert.deepEqual(bounded.json.snapshotPolicy, {
    messageThreshold: 20,
    byteThreshold: 16384,
    maxAgeSeconds: 86400,
  });

  // Publish a newer checkpoint over unseen rows, then continue from the old page cursor.
  const churned = await rust(
    snapshotArgs({
      text: "# Checkpoint after tail churn",
      coversThrough: longIds.at(-1),
      baseVersion: 4,
      historyRevision: 1,
      key: "snapshot-v5-churn",
    }),
    authorEnv,
  );
  assert.equal(churned.snapshot.version, 5);
  const continuedIds = [...bounded.json.messages.map((message) => message.id)];
  let after = bounded.json.nextCursor;
  while (continuedIds.length < longIds.length) {
    const page = await rust(
      ["catchup", "long-run", "--after", String(after), "--limit", "3", "--max-bytes", "4096"],
      readerEnv,
    );
    assert.equal(page.snapshot, null);
    assert.ok(page.nextCursor >= after);
    continuedIds.push(...page.messages.map((message) => message.id));
    after = page.nextCursor;
    if (!page.hasMore) break;
  }
  assert.deepEqual(continuedIds, longIds);

  // An oversized first row produces an actionable failure, never an empty successful page.
  const oversized = await rust(
    ["send", "long-run", "--text", `oversized:${"z".repeat(1800)}`, "--key", "oversized-tail"],
    authorEnv,
  );
  const tooSmall = await attempt(
    ["catchup", "long-run", "--after", String(longIds.at(-1)), "--max-bytes", "1024"],
    readerEnv,
  );
  assert.equal(tooSmall.ok, false);
  assert.match(tooSmall.error.stderr, /413:.*Increase maxBytes/i);
  const budgetResponse = await fetch(
    `${url}/api/tenants/swarm-team/channels/long-run/catchup?after=${longIds.at(-1)}&maxBytes=1024`,
    { headers: { Authorization: `Bearer ${reader.token}` } },
  );
  assert.equal(budgetResponse.status, 413);
  const budgetError = await budgetResponse.json();
  assert.equal(budgetError.error.code, "catchup_budget_too_small");
  assert.ok(Number.isSafeInteger(budgetError.error.requiredBytes));
  assert.ok(budgetError.error.requiredBytes > 1024);
  assert.match(tooSmall.error.stderr, new RegExp(`at least ${budgetError.error.requiredBytes}\\b`));
  const exactBudget = await rustOutput(
    [
      "catchup",
      "long-run",
      "--after",
      String(longIds.at(-1)),
      "--max-bytes",
      String(budgetError.error.requiredBytes),
    ],
    readerEnv,
  );
  assert.ok(Buffer.byteLength(exactBudget.stdout.trim(), "utf8") <= budgetError.error.requiredBytes);
  assert.deepEqual(
    exactBudget.json.messages.map((message) => message.id),
    [oversized.message.id],
  );
  const fits = await rustOutput(
    ["catchup", "long-run", "--after", String(longIds.at(-1)), "--max-bytes", "4096"],
    readerEnv,
  );
  assert.ok(Buffer.byteLength(fits.stdout.trim(), "utf8") <= 4096);
  assert.deepEqual(
    fits.json.messages.map((message) => message.id),
    [oversized.message.id],
  );

  // Every snapshot/catchup operation above was independent of the ordinary read cursor.
  const unread = await rust(["read", "long-run"], readerEnv);
  assert.deepEqual(
    unread.messages.map((message) => message.id),
    [...longIds, oversized.message.id],
  );
  assert.deepEqual((await rust(["read", "long-run", "--wait", "0"], readerEnv)).messages, []);

  console.log(
    "PASS: real local Worker + Rust snapshots cover append races, competing CAS/replay, bounded exact continuation through snapshot churn, redaction repair, and independent read cursors.",
  );
} finally {
  try {
    process.kill(-server.pid, "SIGTERM");
  } catch {
    server.kill("SIGTERM");
  }
  await new Promise((resolve) =>
    server.exitCode !== null || server.signalCode !== null || !server.pid
      ? resolve()
      : server.once("exit", resolve),
  );
  await rm(dir, { recursive: true, force: true });
}
