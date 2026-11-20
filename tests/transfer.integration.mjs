/**
 * Two independent local Workers: export A → archive → import B.
 * Proves both-direction copy is just "the selected profile is the destination".
 *
 * Invariants:
 *  I1 seed A with messages, a reply, a task thread and a snapshot; export is complete
 *  I2 import into a new B channel wraps msn.import.v1; dest username is the importer
 *  I3 replyTo remaps to the destination parent id; source ids stay in provenance
 *  I4 default trust leaves imported msn.task.v1 off B's live task board
 *  I5 re-import is idempotent (same dest ids, no new rows)
 *  I6 import writes no readers/ or processing/ cursor files
 */
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const cwd = fileURLToPath(new URL("..", import.meta.url));
const dir = await mkdtemp(join(tmpdir(), "msn-transfer-e2e-"));
const binary = process.env.CARGO_TARGET_DIR
  ? join(process.env.CARGO_TARGET_DIR, "debug/msn")
  : join(cwd, "cli/target/debug/msn");

async function reservePort() {
  const reservation = createServer();
  await new Promise((resolve, reject) => {
    reservation.once("error", reject);
    reservation.listen(0, "127.0.0.1", resolve);
  });
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  return port;
}

function startWorker(persistTo, port, inspectorPort, admin) {
  const log = { text: "" };
  const server = spawn(
    join(cwd, "node_modules/.bin/wrangler"),
    [
      "dev",
      "--ip",
      "127.0.0.1",
      "--port",
      String(port),
      "--inspector-port",
      String(inspectorPort),
      "--persist-to",
      persistTo,
      "--show-interactive-dev-session",
      "false",
    ],
    {
      cwd,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        ADMIN_TOKEN: admin,
        WRANGLER_SEND_METRICS: "false",
      },
    },
  );
  server.on("error", (error) => {
    log.text += error.message;
  });
  for (const stream of [server.stdout, server.stderr]) {
    stream.on("data", (chunk) => {
      log.text = (log.text + chunk).slice(-20000);
    });
  }
  return { server, log };
}

async function waitHealth(url, log) {
  for (let i = 0; i < 200; i++) {
    try {
      if ((await fetch(`${url}/api/health`)).ok) {
        return;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`local worker failed to start at ${url}: ${log.text.slice(-2000)}`);
}

async function rust(url, tenant, token, args, extras = {}) {
  const result = await exec(binary, args, {
    cwd,
    env: {
      PATH: process.env.PATH,
      HOME: extras.home ?? dir,
      XDG_CONFIG_HOME: extras.config ?? join(dir, "config"),
      XDG_STATE_HOME: extras.state ?? join(dir, "state"),
      MSN_URL: url,
      MSN_WORKSPACE_TENANT: tenant,
      MSN_WORKSPACE_TOKEN: token,
      MSN_USERNAME: extras.username ?? "importer",
      ...extras.env,
    },
    timeout: 20000,
  });
  const trimmed = result.stdout.trim();
  return {
    json: trimmed ? JSON.parse(trimmed) : null,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

async function rustFail(url, tenant, token, args, extras = {}) {
  try {
    await rust(url, tenant, token, args, extras);
    return { ok: true };
  } catch (error) {
    return { ok: false, error };
  }
}

function stopWorker(server) {
  try {
    process.kill(-server.pid, "SIGTERM");
  } catch {
    server.kill("SIGTERM");
  }
}

const portA = await reservePort();
const portB = await reservePort();
const inspectorA = await reservePort();
const inspectorB = await reservePort();
const urlA = `http://127.0.0.1:${portA}`;
const urlB = `http://127.0.0.1:${portB}`;
const adminA = "isolated-transfer-admin-a-000000000000";
const adminB = "isolated-transfer-admin-b-000000000000";
const workerA = startWorker(join(dir, "worker-a"), portA, inspectorA, adminA);
const workerB = startWorker(join(dir, "worker-b"), portB, inspectorB, adminB);

try {
  await Promise.all([waitHealth(urlA, workerA.log), waitHealth(urlB, workerB.log)]);

  const aAdmin = { username: "bootstrap", env: { MSN_ADMIN_TOKEN: adminA, MSN_WORKSPACE_TOKEN: "" } };
  await rust(urlA, "site-a", "", ["provision", "site-a", "--username", "bootstrap"], {
    ...aAdmin,
    env: { MSN_ADMIN_TOKEN: adminA },
  });
  const alice = (
    await rust(urlA, "site-a", "", ["key-create", "alice", "--username", "alice"], {
      env: { MSN_ADMIN_TOKEN: adminA },
    })
  ).json;
  const planner = (
    await rust(urlA, "site-a", "", ["key-create", "planner", "--username", "planner"], {
      env: { MSN_ADMIN_TOKEN: adminA },
    })
  ).json;
  const aToken = alice.token;
  await rust(urlA, "site-a", aToken, ["create", "source"], { username: "alice" });
  const hello = (
    await rust(urlA, "site-a", aToken, ["send", "source", "--text", "hello from A", "--key", "a-hello"], {
      username: "alice",
    })
  ).json;
  await rust(
    urlA,
    "site-a",
    aToken,
    ["send", "source", "--text", "reply from A", "--reply-to", String(hello.message.id), "--key", "a-reply"],
    { username: "alice" },
  );
  await rust(
    urlA,
    "site-a",
    planner.token,
    ["task", "open", "source", "xfer", "--title", "Copy me", "--reviewer", "planner", "--key", "a-open"],
    { username: "planner" },
  );
  const evidence = (
    await rust(urlA, "site-a", aToken, ["send", "source", "--text", "evidence body", "--key", "a-ev"], {
      username: "alice",
    })
  ).json;
  await rust(
    urlA,
    "site-a",
    planner.token,
    ["task", "ready", "source", "xfer", "--evidence", String(evidence.message.id), "--key", "a-ready"],
    { username: "planner" },
  );
  const catchup = (await rust(urlA, "site-a", aToken, ["catchup", "source"], { username: "alice" })).json;
  await rust(
    urlA,
    "site-a",
    planner.token,
    [
      "snapshot",
      "publish",
      "source",
      "--text",
      "# Checkpoint A",
      "--covers-through",
      String(catchup.headCursor),
      "--base-version",
      String(catchup.snapshotVersion),
      "--history-revision",
      String(catchup.historyRevision),
      "--key",
      "a-snap",
    ],
    { username: "planner" },
  );

  const archive = join(dir, "source.msnarchive.jsonl");
  const exported = (
    await rust(urlA, "site-a", aToken, ["export", "source", "--out", archive], { username: "alice" })
  ).json;
  assert.equal(exported.status, "complete");
  assert.ok(exported.messageCount >= 4);

  // ADR 0048: the same pinned pages as a Markdown transcript, on stdout or into a 0600 file.
  const printed = await exec(binary, ["export", "source", "--format", "md"], {
    cwd,
    env: {
      PATH: process.env.PATH,
      HOME: dir,
      MSN_URL: urlA,
      MSN_WORKSPACE_TENANT: "site-a",
      MSN_WORKSPACE_TOKEN: aToken,
    },
    timeout: 20000,
  });
  assert.match(printed.stdout, /^# Transcript of #source\n/);
  assert.match(printed.stdout, new RegExp(`### #${hello.message.id} · .* UTC · alice\\n`));
  assert.ok(printed.stdout.includes(`- Reply to: [#${hello.message.id}](#msg-${hello.message.id})`));
  assert.ok(printed.stdout.includes("```text\nhello from A\n```"));
  const transcriptPath = join(dir, "source.md");
  const written = (
    await rust(urlA, "site-a", aToken, ["export", "source", "--format", "md", "--out", transcriptPath], {
      username: "alice",
    })
  ).json;
  assert.equal(written.format, "md");
  assert.equal(written.messageCount, exported.messageCount);
  const { readFile, stat } = await import("node:fs/promises");
  assert.equal((await stat(transcriptPath)).mode & 0o777, 0o600);
  assert.equal(
    (await readFile(transcriptPath, "utf8")).replace(/- Exported: .*\n/, ""),
    printed.stdout.replace(/- Exported: .*\n/, ""),
  );
  const refused = await rustFail(urlA, "site-a", aToken, [
    "export",
    "source",
    "--format",
    "md",
    "--out",
    transcriptPath,
  ]);
  assert.equal(refused.ok, false);
  assert.equal(refused.error.code, 2);
  const noOut = await rustFail(urlA, "site-a", aToken, ["export", "source"]);
  assert.equal(noOut.ok, false);
  assert.equal(noOut.error.code, 2);

  const bProvision = (
    await rust(urlB, "site-b", "", ["provision", "site-b", "--username", "importer"], {
      env: { MSN_ADMIN_TOKEN: adminB },
    })
  ).json;
  const bToken = bProvision.token;

  const dry = (
    await rust(urlB, "site-b", bToken, ["import", archive, "--channel", "dest", "--dry-run"], {
      username: "importer",
    })
  ).json;
  assert.equal(dry.dryRun, true);
  assert.equal(dry.writes, false);
  assert.equal(dry.trust, "provenance");
  const before = (
    await rustFail(urlB, "site-b", bToken, ["poll", "dest", "--after", "0", "--wait", "0"], {
      username: "importer",
    })
  ).ok;
  assert.equal(before, false, "dry-run must not create dest");

  const imported = (
    await rust(urlB, "site-b", bToken, ["import", archive, "--channel", "dest"], {
      username: "importer",
    })
  ).json;
  assert.equal(imported.status, "complete");
  assert.equal(imported.destination.username, "importer");

  const page = (
    await rust(urlB, "site-b", bToken, ["poll", "dest", "--after", "0", "--limit", "100"], {
      username: "importer",
    })
  ).json;
  const rows = page.messages;
  assert.ok(rows.length >= 4);
  assert.ok(rows.every((row) => row.username === "importer"));
  const envelopes = rows
    .filter((row) => row.contentType === "application/json")
    .map((row) => ({ row, body: JSON.parse(row.text) }))
    .filter((item) => item.body.schema === "msn.import.v1");
  assert.ok(envelopes.some((item) => item.body.payload?.kind === "import-begin"));
  assert.ok(envelopes.some((item) => item.body.payload?.kind === "import-complete"));
  const helloImport = envelopes.find((item) => item.body.payload?.text === "hello from A");
  const replyImport = envelopes.find((item) => item.body.payload?.text === "reply from A");
  assert.ok(helloImport, "hello provenance missing");
  assert.ok(replyImport, "reply provenance missing");
  assert.equal(helloImport.body.source.username, "alice");
  assert.equal(replyImport.body.provenance.replyTo, hello.message.id);
  assert.equal(replyImport.row.replyTo, helloImport.row.id);
  const taskWrapped = envelopes.some(
    (item) =>
      item.body.payload?.contentType === "application/json" &&
      String(item.body.payload?.text ?? "").includes("msn.task.v1"),
  );
  assert.equal(taskWrapped, true);
  const board = (await rust(urlB, "site-b", bToken, ["task", "list", "dest"], { username: "importer" })).json;
  const live = (board.tasks ?? board.items ?? []).filter(
    (task) => task.task === "xfer" || task.id === "xfer",
  );
  assert.equal(live.length, 0, "provenance import must not project tasks");

  const destSnaps = (
    await rust(urlB, "site-b", bToken, ["snapshot", "list", "dest"], { username: "importer" })
  ).json;
  assert.ok((destSnaps.snapshots ?? []).length >= 1);
  const shown = (
    await rust(urlB, "site-b", bToken, ["snapshot", "show", "dest", "1"], { username: "importer" })
  ).json;
  assert.equal(shown.snapshot.text, "# Checkpoint A");
  assert.equal(shown.snapshot.username, "importer");
  const covered = envelopes.find((item) => item.body.source?.messageId === catchup.headCursor);
  assert.ok(covered);
  assert.equal(shown.snapshot.coversThrough, covered.row.id);

  const again = (
    await rust(urlB, "site-b", bToken, ["import", archive, "--channel", "dest"], {
      username: "importer",
    })
  ).json;
  assert.equal(again.status, "complete");
  const page2 = (
    await rust(urlB, "site-b", bToken, ["poll", "dest", "--after", "0", "--limit", "100"], {
      username: "importer",
    })
  ).json;
  assert.equal(page2.messages.length, rows.length);
  assert.deepEqual(
    page2.messages.map((row) => row.id),
    rows.map((row) => row.id),
  );

  async function hasCursorDir(name) {
    const stack = [join(dir, "state")];
    while (stack.length) {
      const current = stack.pop();
      let entries = [];
      try {
        entries = await readdir(current, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (entry.name === name) {
          return true;
        }
        if (entry.isDirectory()) {
          stack.push(join(current, entry.name));
        }
      }
    }
    return false;
  }
  assert.equal(await hasCursorDir("readers"), false);
  assert.equal(await hasCursorDir("processing"), false);
  assert.equal(await hasCursorDir("imports"), true);

  const reverse = join(dir, "dest.msnarchive.jsonl");
  await rust(urlB, "site-b", bToken, ["export", "dest", "--out", reverse], { username: "importer" });
  const back = (
    await rust(urlA, "site-a", aToken, ["import", reverse, "--channel", "copy-of-b"], {
      username: "alice",
    })
  ).json;
  assert.equal(back.status, "complete");
  const copied = (
    await rust(urlA, "site-a", aToken, ["poll", "copy-of-b", "--after", "0", "--limit", "100"], {
      username: "alice",
    })
  ).json;
  assert.ok(copied.messages.every((row) => row.username === "alice"));
  assert.ok(
    copied.messages.some((row) => String(row.text).includes("hello from A")),
    "B→A copy must carry A's hello as nested provenance",
  );

  console.log(
    "PASS: two local Workers copy A→B (remap, provenance, inert tasks, idempotent re-import) and B→A.",
  );
} finally {
  stopWorker(workerA.server);
  stopWorker(workerB.server);
  await Promise.all(
    [workerA.server, workerB.server].map(
      (server) =>
        new Promise((resolve) =>
          server.exitCode !== null || server.signalCode !== null || !server.pid
            ? resolve()
            : server.once("exit", resolve),
        ),
    ),
  );
  await rm(dir, { recursive: true, force: true });
}
