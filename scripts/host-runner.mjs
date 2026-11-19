#!/usr/bin/env node
import { constants, realpathSync } from "node:fs";
import { open } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { HostError, requireValue, validateConfig } from "./host/protocol.mjs";
import { HostRuntime } from "./host/runtime.mjs";
import { HostStore } from "./host/store.mjs";
import { connectionsFor } from "./host/transport.mjs";

const HELP = `Usage: node scripts/host-runner.mjs --config FILE [--status]

Run trusted local agents against one remote MSN workspace. Node 24+; Linux/macOS.
Each agent requires an exact-name participant profile (or named credential env var),
local command argv, channel memberships, and permissionMode: "yolo".
No inbound listener; remote browser/desktop/iOS/CLI clients use the existing Worker.
--status reads durable queue metadata without loading credentials or making requests.
See docs/host-runtime.md and examples/host/host.example.json.
`;
export async function loadConfig(path) {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await handle.stat();
    requireValue(stat.isFile() && stat.size <= 131072, "invalid_config_file");
    return validateConfig(JSON.parse(await handle.readFile("utf8")), dirname(resolve(path)));
  } finally {
    await handle.close();
  }
}
export function inspectState(config) {
  const db = new DatabaseSync(join(config.stateDir, "state.sqlite"), { readOnly: true, timeout: 0 });
  try {
    return {
      hostId: config.hostId,
      agents: db
        .prepare("SELECT id, username, cursor, initialized, channels, waiting FROM agents ORDER BY id")
        .all()
        .map((row) => {
          const waiting = row.waiting ? JSON.parse(row.waiting) : null;
          return {
            ...row,
            channels: JSON.parse(row.channels),
            waiting: waiting
              ? { for: waiting.for, deadline: waiting.deadline, channel: waiting.channel }
              : null,
          };
        }),
      jobs: db.prepare("SELECT status, COUNT(*) AS count FROM jobs GROUP BY status").all(),
      outbox: db.prepare("SELECT status, COUNT(*) AS count FROM outbox GROUP BY status").all(),
      failures: db
        .prepare("SELECT id, agent, channel, error FROM jobs WHERE status='failed' ORDER BY id DESC LIMIT 20")
        .all(),
      failedOutputs: db
        .prepare(
          "SELECT id, agent, channel, error FROM outbox WHERE status='failed' ORDER BY id DESC LIMIT 20",
        )
        .all(),
    };
  } finally {
    db.close();
  }
}
export async function runHost(config, signal, options = {}) {
  requireValue(["linux", "darwin"].includes(process.platform), "unsupported_host_platform");
  const { connections, binding } = await connectionsFor(config, options.env ?? process.env, signal);
  const store = new HostStore(config, binding);
  try {
    await new HostRuntime(config, store, connections, options).run(signal);
  } finally {
    store.close();
  }
}
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const controller = new AbortController();
  for (const signal of ["SIGTERM", "SIGINT"]) process.once(signal, () => controller.abort());
  try {
    const args = process.argv.slice(2);
    if (args.length === 1 && ["--help", "-h"].includes(args[0])) process.stdout.write(HELP);
    else {
      requireValue(
        args[0] === "--config" &&
          typeof args[1] === "string" &&
          (args.length === 2 || (args.length === 3 && args[2] === "--status")),
        "usage_node_host_runner_config_file",
      );
      const config = await loadConfig(args[1]);
      if (args[2] === "--status") process.stdout.write(`${JSON.stringify(inspectState(config), null, 2)}\n`);
      else await runHost(config, controller.signal);
    }
  } catch (error) {
    // Never log config/credentials, arbitrary server bodies, child stderr, or thrown provider text.
    process.stderr.write(
      `${JSON.stringify({ type: "host.error", reason: error instanceof HostError ? error.code : "host_start_or_runtime_failed" })}\n`,
    );
    process.exitCode = controller.signal.aborted ? 130 : 1;
  }
}
