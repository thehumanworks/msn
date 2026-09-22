import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  buildConfig,
  configPath,
  installService,
  main,
  parseArgs,
  rejectSecrets,
  serviceUnit,
  unitQuote,
} from "../scripts/agent-runner.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "msn-listener-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = {
    HOME: root,
    XDG_CONFIG_HOME: join(root, "config"),
    PATH: dirname(process.execPath),
    MSN_PROFILE: "tester",
  };
  const options = parseArgs(["work", "--", process.execPath, "-e", "process.exit(0)"]);
  const path = configPath(options, env);
  return { root, env, options, path };
}

test("bare run is persistent resume, never a one-shot model command", () => {
  assert.deepEqual(parseArgs(["work"]), {
    channel: "work",
    command: [],
    status: false,
    installService: false,
    prompt: false,
  });
});
test("argv separator preserves shell metacharacters literally", () => {
  assert.deepEqual(parseArgs(["work", "--prompt", "--", "/some path/agent", "$HOME", "a;echo hi"]).command, [
    "/some path/agent",
    "$HOME",
    "a;echo hi",
  ]);
});
test("adapter and service flags parse", () => {
  for (const harness of ["codex", "claude", "tny"])
    assert.equal(parseArgs(["work", "--harness", harness, "--install-service"]).harness, harness);
});
test("invalid or ambiguous launch options fail closed", () => {
  for (const args of [
    [],
    ["BAD"],
    ["work", "--"],
    ["work", "--prompt"],
    ["work", "--harness", "other"],
    ["work", "--status", "--", "agent"],
    ["work", "--status", "--install-service"],
    ["work", "--harness", "codex", "--", "agent"],
    ["work", "--once"],
    ["--saved-config", "relative"],
  ])
    assert.throws(() => parseArgs(args));
});
test("config identity isolates profiles/channels but survives token rotation", async (t) => {
  const { env, options, path } = await fixture(t);
  assert.equal(configPath(options, { ...env, MSN_WORKSPACE_TOKEN: "rotated" }), path);
  assert.notEqual(configPath(options, { ...env, MSN_PROFILE: "other" }), path);
  assert.notEqual(configPath({ ...options, channel: "other" }, env), path);
  assert.throws(() => configPath(options, { XDG_CONFIG_HOME: "relative" }));
});
test("unconfigured status is read-only and actionable", async (t) => {
  const { env, path } = await fixture(t);
  const status = await main(["work", "--status"], env);
  assert.equal(status.status, "not-configured");
  assert.match(status.next, /Configure once/);
  await assert.rejects(stat(dirname(path)), { code: "ENOENT" });
  await assert.rejects(main(["work"], env), /Configure once/);
});
test("first explicit command persists; subsequent run reuses cwd and durable state", async (t) => {
  const { env, options, path } = await fixture(t);
  const calls = [];
  const host = {
    async runHost(config, signal, received) {
      calls.push(config);
      assert.equal(signal.aborted, false);
      assert.equal(received.env, env);
    },
  };
  await main(["work", "--", ...options.command], env, { host });
  const persisted = JSON.parse(await readFile(path, "utf8"));
  assert.equal(persisted.agents[0].profile, "tester");
  assert.equal(persisted.agents[0].timeoutMs, null);
  assert.equal(persisted.replayHistory, false);
  assert.deepEqual(persisted.agents[0].allowedChannels, ["work"]);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal((await stat(dirname(path))).mode & 0o777, 0o700);
  await main(["work"], env, { host });
  assert.deepEqual(calls[0], calls[1]);
  assert.equal(calls.length, 2);
});
test("configured but never started status does not import host or read credentials", async (t) => {
  const { env, options } = await fixture(t);
  await main(["work", "--", ...options.command], env, { host: { async runHost() {} } });
  const status = await main(["work", "--status"], env, {
    host: {
      inspectState() {
        assert.fail("no database");
      },
    },
  });
  assert.equal(status.status, "not-started");
});
test("durable status delegates read-only inspection, never runHost", async (t) => {
  const { env, options, path } = await fixture(t);
  await main(["work", "--", ...options.command], env, { host: { async runHost() {} } });
  const config = JSON.parse(await readFile(path, "utf8"));
  await mkdir(config.stateDir, { mode: 0o700 });
  await writeFile(join(config.stateDir, "state.sqlite"), "fake");
  const result = await main(["work", "--status"], env, {
    host: {
      inspectState() {
        return { jobs: [] };
      },
      runHost() {
        assert.fail("status started runtime");
      },
    },
  });
  assert.equal(result.liveProcessVerified, false);
  assert.deepEqual(result.jobs, []);
});
test("saved config entry bypasses ambient profile selection for service", async (t) => {
  const { env, options, path } = await fixture(t);
  await main(["work", "--", ...options.command], env, { host: { async runHost() {} } });
  let calls = 0;
  await main(
    ["--saved-config", path],
    { ...env, MSN_PROFILE: "other" },
    {
      host: {
        async runHost(config) {
          assert.equal(config.agents[0].profile, "tester");
          calls++;
        },
      },
    },
  );
  assert.equal(calls, 1);
});
test("ambient connection stores only named environment reference", async (t) => {
  const { env, options, path } = await fixture(t);
  const ambient = {
    ...env,
    MSN_PROFILE: undefined,
    MSN_URL: "https://msn.example",
    MSN_WORKSPACE_TENANT: "team",
    MSN_WORKSPACE_TOKEN: "private-token-value",
  };
  const config = await buildConfig(options, path, ambient);
  assert.equal(config.agents[0].connection.tokenEnv, "MSN_WORKSPACE_TOKEN");
  assert.ok(!JSON.stringify(config).includes(ambient.MSN_WORKSPACE_TOKEN));
  assert.throws(() => serviceUnit(path, config, ambient), /saved --profile/);
});
test("credentials and credential flags are refused in command argv", () => {
  for (const argv of [
    ["agent", "--token", "xxx"],
    ["agent", "--api-key=xxx"],
    ["agent", "prefix-sensitive-value-suffix"],
    ["agent", "line\nbreak"],
  ])
    assert.throws(() => rejectSecrets(argv, { PROVIDER_TOKEN: "sensitive-value" }), /Credentials/);
  rejectSecrets(["agent", "--safe", "$TOKEN"], { PROVIDER_TOKEN: "sensitive-value" });
});
test("unsafe connection origins are not saved", async (t) => {
  const { env, options, path } = await fixture(t);
  for (const origin of [
    "https://user:secret@example.com",
    "https://example.com/path",
    "https://example.com?token=x",
    "http://example.com",
  ])
    await assert.rejects(
      buildConfig(options, path, {
        ...env,
        MSN_PROFILE: undefined,
        MSN_WORKSPACE_TENANT: "team",
        MSN_URL: origin,
      }),
    );
});
test("native and generic prompt commands reuse existing adapter", async (t) => {
  const { env, options, path } = await fixture(t);
  const config = await buildConfig({ ...options, prompt: true }, path, env);
  assert.match(config.agents[0].command[1], /host\/prompt-adapter\.mjs$/);
  assert.equal(config.agents[0].command[2], "--");
  assert.equal(config.agents[0].command[3], process.execPath);
});
test("missing executable fails before creating config", async (t) => {
  const { env, path } = await fixture(t);
  await assert.rejects(main(["work", "--", "definitely-no-such-agent"], env), /not found/);
  await assert.rejects(stat(path), { code: "ENOENT" });
});
test("symlink and public config files are refused", async (t) => {
  const { env, options, path, root } = await fixture(t);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const target = join(root, "target.json");
  await writeFile(target, JSON.stringify(await buildConfig(options, path, env)), { mode: 0o600 });
  await symlink(target, path);
  await assert.rejects(main(["work", "--status"], env), /invalid or unreadable/);
  await rm(path);
  await writeFile(path, await readFile(target), { mode: 0o644 });
  // The test must create a public file even under a service umask of 0077.
  await chmod(path, 0o644);
  await assert.rejects(main(["work", "--status"], env), /private/);
});
test("systemd quoting neutralises specifiers, dollars, quotes, and backslashes", () => {
  assert.equal(unitQuote('/a %n/$HOME/"x"\\y', true), '"/a %%n/$$HOME/\\"x\\"\\\\y"');
  assert.equal(unitQuote("PATH=/a/$literal/%n"), '"PATH=/a/$literal/%%n"');
  assert.throws(() => unitQuote("x\nExecStart=bad"));
});
test("service stores absolute launch paths, profile reference, and no tokens", async (t) => {
  const { env, options, path } = await fixture(t);
  const config = await buildConfig(options, path, env);
  const unit = serviceUnit(path, config, {
    ...env,
    MSN_WORKSPACE_TOKEN: "do-not-persist-this",
    OPENAI_API_KEY: "nor-this-key",
  });
  assert.match(unit, /Restart=on-failure/);
  assert.match(unit, /KillMode=control-group/);
  assert.match(unit, /--saved-config/);
  assert.match(unit, /WantedBy=default.target/);
  assert.ok(!unit.includes("do-not-persist-this") && !unit.includes("nor-this-key"));
  assert.ok(!unit.includes("MSN_WORKSPACE_TOKEN="));
});
test("service install uses shell-free systemctl reload and enable/start (mock only)", async (t) => {
  const { env, options, path } = await fixture(t);
  const config = await buildConfig(options, path, env);
  const calls = [];
  const result = await installService(path, config, env, (bin, args, opts) => {
    calls.push({ bin, args, opts });
    return { status: 0 };
  });
  assert.equal(result.status, "service-installed");
  assert.deepEqual(
    calls.map((c) => c.args),
    [
      ["--user", "daemon-reload"],
      ["--user", "enable", "--now", result.service],
    ],
  );
  assert.ok(calls.every((c) => c.bin === "systemctl" && c.opts.shell === false));
  assert.equal((await stat(result.unit)).mode & 0o777, 0o600);
  await assert.rejects(
    installService(path, config, env, () => assert.fail("existing unit")),
    /already exists/,
  );
});
test("service manager failure leaves actionable recovery and saved unit", async (t) => {
  const { env, options, path } = await fixture(t);
  const config = await buildConfig(options, path, env);
  await assert.rejects(
    installService(path, config, env, () => ({ status: 1 })),
    /unit saved but systemctl failed/,
  );
});
test("service refuses ambient secret mode before writing launch configuration", async (t) => {
  const { env, options } = await fixture(t);
  await assert.rejects(
    main(["work", "--install-service", "--", ...options.command], { ...env, MSN_PROFILE: undefined }),
    /saved --profile/,
  );
});
test("CLI script errors do not echo arbitrary invalid options or credential values", async (t) => {
  const { env } = await fixture(t);
  const script = fileURLToPath(new URL("../scripts/agent-runner.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [script, "work", "--private-secret"], { env, encoding: "utf8" });
  assert.equal(result.status, 2);
  assert.ok(!result.stderr.includes("--private-secret"));
});
test("abort handlers reach runtime and are removed after shutdown", async (t) => {
  const { env, options } = await fixture(t);
  const before = process.listenerCount("SIGTERM");
  await main(["work", "--", ...options.command], env, {
    host: {
      async runHost(_config, signal) {
        process.emit("SIGTERM");
        assert.equal(signal.aborted, true);
      },
    },
  });
  assert.equal(process.listenerCount("SIGTERM"), before);
});

test("WorkingDirectory is a literal path, not an ExecStart quoted argument", async (t) => {
  const { env, options, path } = await fixture(t);
  const config = await buildConfig(options, path, env);
  config.agents[0].cwd = '/tmp/a space %n $HOME "quote"';
  const unit = serviceUnit(path, config, env);
  assert.ok(unit.includes('WorkingDirectory=/tmp/a space %%n $HOME "quote"\n'));
  for (const cwd of ["/tmp/trailing ", "/tmp/trailing\\", "/tmp/control\tpath", "relative"]) {
    config.agents[0].cwd = cwd;
    assert.throws(() => serviceUnit(path, config, env), /working directory/);
  }
});
test("real systemd parser accepts generated unit with special path characters (never starts it)", async (t) => {
  const available = spawnSync("systemd-analyze", ["--version"], { encoding: "utf8" });
  if (process.platform !== "linux" || available.error?.code === "ENOENT") {
    t.skip("systemd-analyze is unavailable on this platform");
    return;
  }
  const { root, env, options, path } = await fixture(t);
  const config = await buildConfig(options, path, env);
  const cwd = join(root, 'working space %n $HOME "quote"');
  await mkdir(cwd);
  config.agents[0].cwd = cwd;
  const unit = join(root, "verify-listener.service");
  await writeFile(unit, serviceUnit(`${path} space %n $HOME "quote"`, config, env), { mode: 0o600 });
  const result = spawnSync("systemd-analyze", ["--user", "verify", unit], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
});
test("service rejects multi-agent configs with any ambient-only identity", async (t) => {
  const { env, options, path } = await fixture(t);
  const config = await buildConfig(options, path, env);
  config.agents.push({ ...config.agents[0], profile: undefined, connection: { tokenEnv: "OTHER_TOKEN" } });
  assert.throws(() => serviceUnit(path, config, env), /saved --profile/);
});

test("explicit state-dir persists launch and durable state under its private root", async (t) => {
  const { root, env } = await fixture(t);
  const options = parseArgs(["work", "--state-dir", join(root, "custom"), "--", process.execPath]);
  const path = configPath(options, env);
  assert.equal(path, join(root, "custom/listener.json"));
  assert.equal((await buildConfig(options, path, env)).stateDir, join(root, "custom/state"));
  for (const argv of [
    ["work", "--state-dir"],
    ["work", "--state-dir", "--status"],
  ])
    assert.throws(() => parseArgs(argv));
});
