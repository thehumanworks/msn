// Shared stand-ins for the unit tests.
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import type { Config } from "../src/config.ts";
import { DEFAULTS } from "../src/config.ts";
import type { CliResult, RunCli } from "../src/msn.ts";
import type { Spawn } from "../src/tunnel.ts";

export function config(overrides: Partial<Config> = {}): Config {
  return { ...DEFAULTS, tunnelTimeoutMs: 1000, ...overrides };
}

export type FakeChild = ChildProcess & {
  print(text: string): void;
  exit(code: number): void;
  killed_with: string[];
};

/** A tunnel program that prints what the test tells it to. */
export function fakeSpawn(script: (child: FakeChild) => void = () => {}) {
  const calls: Array<{ command: string; args: string[] }> = [];
  const children: FakeChild[] = [];
  const spawn: Spawn = (command, args) => {
    calls.push({ command, args });
    const child = new EventEmitter() as FakeChild;
    const out = new EventEmitter();
    Object.assign(child, {
      stdout: new EventEmitter(),
      stderr: out,
      exitCode: null,
      signalCode: null,
      killed_with: [],
    });
    child.print = (text) => out.emit("data", Buffer.from(text));
    child.exit = (code) => {
      Object.assign(child, { exitCode: code });
      child.emit("exit", code);
    };
    child.kill = (signal) => {
      child.killed_with.push(String(signal));
      if (child.exitCode === null) queueMicrotask(() => child.exit(0));
      return true;
    };
    children.push(child);
    queueMicrotask(() => script(child));
    return child;
  };
  return { spawn, calls, children };
}

export type CliCall = { args: string[]; env?: Record<string, string> };

/** An MSN CLI whose answers come from `answer`; every call is recorded. */
export function fakeCli(answer: (call: CliCall) => Partial<CliResult> | undefined = () => undefined) {
  const calls: CliCall[] = [];
  const run: RunCli = async (args, env) => {
    calls.push({ args, env });
    return { code: 0, stdout: "{}", stderr: "", ...answer({ args, env }) };
  };
  return { run, calls };
}

export const okFetch = (async () => new Response("ok\n")) as unknown as typeof fetch;
