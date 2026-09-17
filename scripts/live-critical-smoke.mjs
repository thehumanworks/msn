// Opt-in production check. Creates a uniquely named test workspace, never uses
// existing user channels, and redacts only the messages it created.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const url = process.env.MSN_URL;
const admin = process.env.MSN_ADMIN_TOKEN;
assert.ok(url && admin, "Set MSN_URL and MSN_ADMIN_TOKEN explicitly.");
assert.equal(new URL(url).protocol, "https:");
assert.equal(new URL(url).origin, url, "MSN_URL must be a bare origin.");
const dir = await mkdtemp(join(tmpdir(), "msn-live-critical-"));
const tenant = `critical-${crypto.randomUUID()}`;
const channel = "verification";
const binary = fileURLToPath(new URL("../cli/target/debug/msn", import.meta.url));
const ids = new Set();
const base = {
  PATH: process.env.PATH,
  XDG_CONFIG_HOME: join(dir, "config"),
  XDG_STATE_HOME: join(dir, "state"),
  MSN_URL: url,
  MSN_WORKSPACE_TENANT: tenant,
};

async function cli(args, credentials) {
  const result = await exec(binary, args, { env: { ...base, ...credentials }, timeout: 45000 });
  const value = JSON.parse(result.stdout);
  if (value.message?.id && args[0] !== "show") ids.add(value.message.id);
  return value;
}

const adminEnv = { MSN_ADMIN_TOKEN: admin };
try {
  const leadKey = await cli(["provision", tenant, "--username", "smoke-lead"], adminEnv);
  const workerKey = await cli(["key-create", "worker", "--username", "smoke-worker"], adminEnv);
  const reviewerKey = await cli(["key-create", "reviewer", "--username", "smoke-reviewer"], adminEnv);
  const lead = { MSN_WORKSPACE_TOKEN: leadKey.token };
  const worker = { MSN_WORKSPACE_TOKEN: workerKey.token };
  const reviewer = { MSN_WORKSPACE_TOKEN: reviewerKey.token };
  await cli(["create", channel], lead);
  await cli(
    [
      "task",
      "open",
      channel,
      "smoke-task",
      "--title",
      "Verify deployed agent workflows",
      "--owner",
      "smoke-worker",
      "--reviewer",
      "smoke-reviewer",
      "--acceptance",
      "Evidence lookup and clean reviewed task closure",
      "--key",
      "open-task",
    ],
    lead,
  );
  const start = await cli(["start", channel, "--max-bytes", "8192"], worker);
  assert.equal(start.identity.username, "smoke-worker");
  assert.equal(start.identity.origin, url);
  assert.equal(start.protocolVersion, 1);
  const first = await cli(["peek", channel], worker);
  assert.equal(first.committedThrough, 0);
  assert.ok(first.messages.length > 0);
  const replay = await cli(["peek", channel], worker);
  assert.deepEqual(
    replay.messages.map((m) => m.id),
    first.messages.map((m) => m.id),
  );

  const evidence = await cli(
    ["send", channel, "--text", "Live evidence check completed", "--key", "evidence"],
    worker,
  );
  const shown = await cli(["show", channel, String(evidence.message.id)], reviewer);
  assert.equal(shown.message.id, evidence.message.id);
  assert.equal(shown.message.tenant, tenant);
  await cli(
    [
      "task",
      "ready",
      channel,
      "smoke-task",
      "--evidence",
      String(evidence.message.id),
      "--key",
      "ready-task",
    ],
    worker,
  );
  const closed = await cli(["task", "close", channel, "smoke-task", "--key", "close-task"], reviewer);
  const board = await cli(["task", "list", channel], lead);
  assert.equal(board.complete, true);
  assert.equal(board.tasks[0].state, "closed");
  assert.deepEqual(board.tasks[0].conflicts, []);
  const committed = await cli(["commit", channel, "--through", String(first.nextCursor)], worker);
  assert.equal(committed.committedThrough, first.nextCursor);

  await cli(
    [
      "snapshot",
      "publish",
      channel,
      "--text",
      "## Objective\nVerify deployed agent workflows\n## Evidence\nsmoke-task closed with cited evidence; this is an authored smoke checkpoint.",
      "--covers-through",
      String(closed.message.id),
      "--base-version",
      "0",
      "--history-revision",
      "0",
      "--key",
      "smoke-checkpoint",
    ],
    lead,
  );
  assert.equal((await cli(["start", channel], worker)).snapshot.version, 1);
  await cli(["delete", channel, String(evidence.message.id)], adminEnv);
  ids.delete(evidence.message.id);
  await assert.rejects(
    cli(["show", channel, String(evidence.message.id)], lead),
    (error) => error.code === 5 && /410/.test(error.stderr),
  );
  const redacted = await cli(["task", "list", channel], lead);
  assert.equal(redacted.tasks[0].state, "unknown");
  assert.ok(redacted.tasks[0].conflicts.includes("orphan-evidence"));
  assert.equal((await cli(["start", channel], worker)).snapshot, null);
  console.log(
    "PASS live critical workflows: inferred identity/start, peek replay/commit, evidence lookup, reviewed task closure, redaction invalidation and snapshot recovery.",
  );
} finally {
  let cleanupFailed = false;
  for (const id of ids) {
    try {
      await cli(["delete", channel, String(id)], adminEnv);
    } catch {
      cleanupFailed = true;
    }
  }
  await rm(dir, { recursive: true, force: true });
  assert.equal(cleanupFailed, false, "Could not redact all test-owned messages.");
}
