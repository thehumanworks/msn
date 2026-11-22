// Makes the local receiver reachable from the internet. Three providers:
//   cloudflared  a Cloudflare quick tunnel. It needs the cloudflared program and no account.
//   command      any program that prints a public https URL (ngrok, tailscale funnel, ...).
//   none         the user already forwards a public https address to the local port.
import { type ChildProcess, spawn as nodeSpawn } from "node:child_process";
import type { Config } from "./config.ts";

export type Tunnel = {
  provider: Config["tunnel"];
  /** The public https origin (and path prefix, if any), with no trailing slash. */
  url: string;
  /** False once the tunnel program has exited. Always true for "none". */
  alive(): boolean;
  /** The last lines the tunnel program printed, for an error message. */
  lastOutput(): string;
  stop(): Promise<void>;
};

export type Spawn = (command: string, args: string[]) => ChildProcess;

export class TunnelError extends Error {}

const QUICK_TUNNEL_URL = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;
const ANY_HTTPS_URL = /https:\/\/[^\s"'<>|]+/;

function trimUrl(url: string): string {
  return url.replace(/[).,;]+$/, "").replace(/\/+$/, "");
}

function stopChild(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    const force = setTimeout(() => child.kill("SIGKILL"), 2000);
    child.once("exit", () => {
      clearTimeout(force);
      resolve();
    });
    child.kill("SIGTERM");
  });
}

function runTunnel(
  provider: Config["tunnel"],
  command: string,
  args: string[],
  pattern: RegExp,
  timeoutMs: number,
  spawn: Spawn,
  missing: string,
): Promise<Tunnel> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(command, args);
    } catch (error) {
      return reject(new TunnelError(`Could not start ${command}: ${(error as Error).message}`));
    }
    let settled = false;
    let exited = false;
    let output = "";
    const fail = (message: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void stopChild(child);
      reject(new TunnelError(message));
    };
    const timer = setTimeout(
      () =>
        fail(
          `${command} printed no public URL within ${Math.round(timeoutMs / 1000)} seconds.${tail(output)}`,
        ),
      timeoutMs,
    );
    const read = (chunk: Buffer) => {
      // Keep a bounded tail: the URL comes early, and a tunnel can log for hours.
      output = (output + chunk.toString("utf8")).slice(-16_384);
      if (settled) return;
      const match = pattern.exec(output);
      if (!match) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        provider,
        url: trimUrl(match[0]),
        alive: () => !exited,
        lastOutput: () => tail(output),
        stop: () => stopChild(child),
      });
    };
    child.stdout?.on("data", read);
    child.stderr?.on("data", read);
    child.once("error", (error: NodeJS.ErrnoException) =>
      fail(error.code === "ENOENT" ? missing : `Could not start ${command}: ${error.message}`),
    );
    child.once("exit", (code) => {
      exited = true;
      fail(`${command} stopped (exit ${code ?? "by signal"}) before it printed a public URL.${tail(output)}`);
    });
  });
}

function tail(output: string): string {
  const lines = output.trim().split("\n").slice(-4).join("\n");
  return lines ? `\nLast output:\n${lines}` : "";
}

/** The process must not outlive Pi, whatever way Pi ends. */
function killOnExit(tunnel: Tunnel, kill: () => void): Tunnel {
  const onExit = () => kill();
  process.once("exit", onExit);
  return {
    ...tunnel,
    stop: async () => {
      process.off("exit", onExit);
      await tunnel.stop();
    },
  };
}

export async function startTunnel(
  config: Config,
  port: number,
  spawn: Spawn = defaultSpawn,
): Promise<Tunnel> {
  const local = `http://127.0.0.1:${port}`;
  if (config.tunnel === "none") {
    return {
      provider: "none",
      url: trimUrl(config.publicUrl ?? ""),
      alive: () => true,
      lastOutput: () => "",
      stop: async () => {},
    };
  }
  let started: ChildProcess | undefined;
  const tracking: Spawn = (command, args) => {
    started = spawn(command, args);
    return started;
  };
  const tunnel =
    config.tunnel === "cloudflared"
      ? await runTunnel(
          "cloudflared",
          "cloudflared",
          ["tunnel", "--no-autoupdate", "--url", local],
          QUICK_TUNNEL_URL,
          config.tunnelTimeoutMs,
          tracking,
          'The cloudflared program is not installed. Install it (no Cloudflare account is needed for a quick tunnel), or choose another way: set tunnel to "command" with tunnelCommand for ngrok, tailscale or similar, or to "none" with publicUrl for your own public address.',
        )
      : await runTunnel(
          "command",
          (config.tunnelCommand as string[])[0],
          (config.tunnelCommand as string[])
            .slice(1)
            .map((part) => part.replaceAll("{port}", String(port)).replaceAll("{url}", local)),
          config.tunnelUrlPattern ? new RegExp(config.tunnelUrlPattern) : ANY_HTTPS_URL,
          config.tunnelTimeoutMs,
          tracking,
          `The tunnel program ${(config.tunnelCommand as string[])[0]} was not found.`,
        );
  return killOnExit(tunnel, () => started?.kill("SIGKILL"));
}

const defaultSpawn: Spawn = (command, args) =>
  nodeSpawn(command, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });

/**
 * A quick tunnel prints its URL a few seconds before the name resolves. Ask the public address for
 * the receiver's health page until it answers, so the webhook is not set on a dead URL.
 */
export async function waitUntilPublic(
  url: string,
  timeoutMs: number,
  fetcher: typeof fetch = fetch,
  alive: () => boolean = () => true,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (!alive()) return false;
    try {
      const response = await fetcher(`${url}/healthz`, {
        redirect: "manual",
        signal: AbortSignal.timeout(Math.min(5000, Math.max(250, deadline - Date.now()))),
      });
      if (response.ok && (await response.text()).trim() === "ok") return true;
    } catch {
      // Not reachable yet.
    }
    if (Date.now() + 1000 >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}
