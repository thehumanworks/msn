#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
/** Persistent single-agent entry. No transport or model polling is implemented here. */
import { constants, realpathSync } from "node:fs";
import { access, lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { digest, HostError, slug, validateConfig } from "./host/protocol.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
class RunnerError extends Error {}
function need(ok, message) {
  if (!ok) throw new RunnerError(message);
}
export function parseArgs(args) {
  if (args[0] === "--saved-config") {
    need(
      args.length === 2 && isAbsolute(args[1]),
      "--saved-config requires one absolute private configuration path.",
    );
    return { savedConfig: args[1] };
  }
  const result = { channel: args[0], command: [], status: false, installService: false, prompt: false };
  need(
    slug(result.channel),
    "Usage: msn run CHANNEL [--status | --install-service] [--harness codex|claude|tny | --prompt -- COMMAND...]",
  );
  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--") {
      result.command = args.slice(i + 1);
      need(result.command.length, "Supply an executable after --.");
      break;
    }
    if (args[i] === "--status") result.status = true;
    else if (args[i] === "--install-service") result.installService = true;
    else if (args[i] === "--prompt") result.prompt = true;
    else if (args[i] === "--state-dir") {
      const value = args[++i];
      need(
        typeof value === "string" && value.length > 0 && !value.startsWith("--") && !/[\0\r\n]/.test(value),
        "--state-dir requires a private local directory.",
      );
      result.stateDir = resolve(value);
    } else if (args[i] === "--harness") {
      result.harness = args[++i];
      need(["codex", "claude", "tny"].includes(result.harness), "Supported harnesses: codex, claude, tny.");
    } else throw new RunnerError("Unknown listener option; put trusted executable arguments after --.");
  }
  need(
    !result.status || !(result.installService || result.prompt || result.harness || result.command.length),
    "--status is read-only; do not combine it with launch configuration.",
  );
  need(
    !result.harness || !(result.prompt || result.command.length),
    "Choose --harness or an explicit command, not both.",
  );
  need(!result.prompt || result.command.length, "--prompt requires -- COMMAND...");
  return result;
}
export function configPath(options, env = process.env) {
  if (options.stateDir) return join(options.stateDir, "listener.json");
  const base = env.XDG_CONFIG_HOME || (env.HOME && join(env.HOME, ".config"));
  need(
    base && isAbsolute(base),
    "Set an absolute XDG_CONFIG_HOME or HOME for persistent listener configuration.",
  );
  const identity = env.MSN_PROFILE
    ? ["profile", env.MSN_PROFILE]
    : ["connection", env.MSN_URL, env.MSN_WORKSPACE_TENANT, env.MSN_READER || env.MSN_USERNAME || "default"];
  return join(base, "msn", "listeners", digest(identity, options.channel).slice(0, 32), "listener.json");
}
export async function executable(binary, cwd, env = process.env) {
  need(
    typeof binary === "string" && binary.length > 0 && !/[\0\r\n]/.test(binary),
    "Executable path is invalid.",
  );
  const candidates = binary.includes("/")
    ? [resolve(cwd, binary)]
    : (env.PATH || "")
        .split(delimiter)
        .filter(Boolean)
        .map((p) => resolve(cwd, p, binary));
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      if ((await lstat(candidate)).isDirectory()) continue;
      return candidate;
    } catch {}
  }
  throw new RunnerError(
    "Trusted executable not found or not executable. Install it or provide an absolute executable path after --.",
  );
}
export function rejectSecrets(command, env) {
  const secrets = Object.entries(env)
    .filter(
      ([key, value]) => /TOKEN|SECRET|PASSWORD|API_KEY|ACCESS_KEY/i.test(key) && value && value.length >= 4,
    )
    .map(([, value]) => value);
  need(
    command.every(
      (arg) =>
        typeof arg === "string" &&
        !/[\0\r\n]/.test(arg) &&
        !secrets.some((secret) => arg.includes(secret)) &&
        !/^(?:--?(?:token|admin-token|api[-_]?key|password|secret|access[-_]?key))(?:=|$)/i.test(arg),
    ),
    "Credentials must not appear in executable arguments or saved configuration. Use a saved profile, environment, or the harness credential store.",
  );
}
async function privateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  need(
    stat.isDirectory() &&
      !stat.isSymbolicLink() &&
      (stat.mode & 0o077) === 0 &&
      (process.getuid === undefined || stat.uid === process.getuid()),
    "Listener directory must be owned by you, private (0700), and not a symlink.",
  );
}
export async function writePrivate(path, value) {
  await privateDirectory(dirname(path));
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(value);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}
async function readSaved(path) {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const stat = await handle.stat();
    need(
      stat.isFile() &&
        stat.size <= 131072 &&
        (stat.mode & 0o077) === 0 &&
        (process.getuid === undefined || stat.uid === process.getuid()),
      "Saved listener config must be a private user-owned regular file (0600).",
    );
    return validateConfig(JSON.parse(await handle.readFile("utf8")), dirname(path));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    if (error instanceof RunnerError) throw error;
    throw new RunnerError(
      "Saved listener configuration is invalid or unreadable. Check its ownership and permissions; do not delete durable state to repair launch settings.",
    );
  } finally {
    await handle?.close();
  }
}
export async function buildConfig(options, path, env = process.env, cwd = process.cwd()) {
  let command;
  if (options.harness) {
    const binary = await executable(options.harness, cwd, env);
    command = [
      process.execPath,
      join(HERE, "host/prompt-adapter.mjs"),
      "--harness",
      options.harness,
      "--binary",
      binary,
    ];
  } else {
    rejectSecrets(options.command, env);
    command = [await executable(options.command[0], cwd, env), ...options.command.slice(1)];
    if (options.prompt) command = [process.execPath, join(HERE, "host/prompt-adapter.mjs"), "--", ...command];
  }
  rejectSecrets(command, env);
  let connection;
  if (env.MSN_PROFILE) {
    need(slug(env.MSN_PROFILE), "Use a valid saved participant profile.");
    connection = { profile: env.MSN_PROFILE };
  } else {
    need(
      slug(env.MSN_WORKSPACE_TENANT) && env.MSN_URL,
      "Select --profile NAME, or provide MSN_URL and MSN_WORKSPACE_TENANT plus MSN_WORKSPACE_TOKEN in the environment.",
    );
    const origin = new URL(env.MSN_URL);
    need(
      !origin.username &&
        !origin.password &&
        origin.pathname === "/" &&
        !origin.search &&
        !origin.hash &&
        (origin.protocol === "https:" ||
          (origin.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname))),
      "MSN_URL must be a bare HTTPS origin (HTTP allowed only on localhost).",
    );
    connection = {
      connection: {
        origin: origin.origin,
        tenant: env.MSN_WORKSPACE_TENANT,
        tokenEnv: "MSN_WORKSPACE_TOKEN",
      },
    };
  }
  const config = validateConfig(
    {
      schema: "msn.host.v1",
      hostId: `listener-${digest(path).slice(0, 24)}`,
      stateDir: join(dirname(path), "state"),
      maxConcurrent: 1,
      replayHistory: false,
      agents: [
        {
          id: "listener",
          ...connection,
          command,
          cwd: resolve(cwd),
          channels: [options.channel],
          allowedChannels: [options.channel],
          permissionMode: "yolo",
          timeoutMs: null,
        },
      ],
    },
    dirname(path),
  );
  rejectSecrets([JSON.stringify(config)], env);
  return config;
}
// systemd parses its own quoting; never invoke a shell. Percent specifiers and ExecStart dollars
// must be escaped separately. Environment= does not expand dollars.
export function unitQuote(value, exec = false) {
  need(
    typeof value === "string" && !/[\0\r\n]/.test(value),
    "Service paths and environment cannot contain control line breaks.",
  );
  return `"${value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("%", "%%")
    .replaceAll("$", () => (exec ? "$$" : "$"))}"`;
}
export function workingDirectory(value) {
  // Unlike ExecStart/Environment, this directive takes the entire literal value, not
  // a quoted word list. Interior spaces and quotes are literal; only % is expanded.
  need(
    isAbsolute(value) &&
      !Array.from(value).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) &&
      !/[\s\\]$/.test(value),
    "Service working directory must be absolute, without control characters, trailing whitespace or a trailing backslash.",
  );
  return value.replaceAll("%", "%%");
}
export function serviceUnit(path, config, env = process.env) {
  need(
    config.agents.every((agent) => agent.profile),
    "--install-service requires a saved --profile; ambient credentials are never written to a unit. Save a participant profile first.",
  );
  const lines = [
    "[Unit]",
    "Description=MSN persistent channel listener",
    "StartLimitIntervalSec=0",
    "",
    "[Service]",
    "Type=simple",
    "Restart=on-failure",
    "RestartSec=5",
    "UMask=0077",
    "KillMode=control-group",
    "TimeoutStopSec=30",
    `WorkingDirectory=${workingDirectory(config.agents[0].cwd)}`,
    `ExecStart=${[process.execPath, join(HERE, "agent-runner.mjs"), "--saved-config", path].map((v) => unitQuote(v, true)).join(" ")}`,
  ];
  for (const key of ["HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_DATA_HOME", "PATH"]) {
    if (env[key]) lines.push(`Environment=${unitQuote(`${key}=${env[key]}`)}`);
  }
  lines.push("", "[Install]", "WantedBy=default.target", "");
  const unit = lines.join("\n");
  rejectSecrets([unit.replaceAll("\n", " ")], env);
  return unit;
}
export async function installService(path, config, env = process.env, run = spawnSync) {
  need(
    process.platform === "linux",
    "--install-service requires Linux and a systemd user manager. On macOS use a foreground listener or your own supervisor.",
  );
  const unit = serviceUnit(path, config, env);
  const home = env.XDG_CONFIG_HOME || join(env.HOME, ".config");
  const directory = join(home, "systemd", "user");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const name = `msn-listener-${digest(path).slice(0, 24)}.service`;
  // Do not require the shared systemd user directory to be private.
  const destination = join(directory, name);
  const handle = await open(
    destination,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
    0o600,
  ).catch((error) => {
    if (error.code === "EEXIST")
      throw new RunnerError(
        "Service unit already exists; inspect it and use systemctl --user restart for an existing installation. No unit was overwritten.",
      );
    throw error;
  });
  try {
    await handle.writeFile(unit);
    await handle.sync();
  } finally {
    await handle.close();
  }
  for (const args of [
    ["--user", "daemon-reload"],
    ["--user", "enable", "--now", name],
  ]) {
    const result = run("systemctl", args, { env, stdio: "ignore", shell: false });
    need(
      !result.error && result.status === 0,
      `Service unit saved but systemctl failed. Check the user manager, then run systemctl --user daemon-reload and systemctl --user enable --now ${name}.`,
    );
  }
  return {
    status: "service-installed",
    service: name,
    unit: destination,
    inspect: `systemctl --user status ${name}`,
    logs: `journalctl --user -u ${name}`,
  };
}
export async function main(args = process.argv.slice(2), env = process.env, dependencies = {}) {
  need(Number(process.versions.node.split(".")[0]) >= 24, "Persistent listeners require Node 24 or newer.");
  const options = parseArgs(args);
  const path = options.savedConfig || configPath(options, env);
  let config = await readSaved(path);
  if (options.command?.length || options.harness) {
    need(
      !options.installService || env.MSN_PROFILE,
      "--install-service requires a saved --profile; no ambient credentials are persisted.",
    );
    config = await buildConfig(options, path, env);
    await writePrivate(path, `${JSON.stringify(config, null, 2)}\n`);
  }
  if (!config) {
    const result = {
      status: "not-configured",
      config: path,
      next: "Configure once: msn [--profile NAME] run CHANNEL --harness codex (or -- COMMAND...). Subsequent identical profile/channel runs resume.",
    };
    if (options.status) return result;
    throw new RunnerError(result.next);
  }
  if (options.installService) return installService(path, config, env, dependencies.systemctl);
  if (options.status) {
    try {
      await access(join(config.stateDir, "state.sqlite"));
    } catch (error) {
      if (error.code === "ENOENT")
        return {
          status: "not-started",
          config: path,
          next: "Run msn with the same profile and run CHANNEL to start the saved listener.",
        };
      throw error;
    }
  }
  let host;
  try {
    host = dependencies.host || (await import("./host-runner.mjs"));
  } catch {
    throw new RunnerError(
      "Host runtime unavailable. Use Node 24+ and keep the complete scripts/host tree beside agent-runner.mjs.",
    );
  }
  if (options.status)
    return {
      status: "durable-state",
      liveProcessVerified: false,
      config: path,
      ...host.inspectState(config),
    };
  const controller = new AbortController();
  const stop = () => controller.abort();
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.once(signal, stop);
  try {
    await host.runHost(config, controller.signal, { env });
  } finally {
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.removeListener(signal, stop);
  }
  return { status: "stopped" };
}
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
    .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch((error) => {
      process.stderr.write(
        `${error instanceof RunnerError ? error.message : error instanceof HostError ? `Listener runtime error (${error.code}). Check your private profile, channel access, and msn run CHANNEL --status; repair launch settings without deleting durable state.` : "Listener failed. Check runtime files, private profile, channel access, and durable status; no credentials or provider output were logged."}\n`,
      );
      process.exitCode = error instanceof RunnerError ? 2 : 1;
    });
}
