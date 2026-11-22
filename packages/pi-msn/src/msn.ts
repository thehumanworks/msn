// Calls the MSN CLI. The CLI owns profiles and keys, so this extension never reads or stores an
// MSN credential. The webhook's bearer key goes to the CLI through the environment, never argv.
// Every positional comes after "--", so a value can never be read as an option.
import { execFile } from "node:child_process";
import type { Config } from "./config.ts";

export type CliResult = { code: number; stdout: string; stderr: string };
export type RunCli = (args: string[], env?: Record<string, string>) => Promise<CliResult>;

/** The CLI's exit code for a refused key (401 or 403), such as a key that is not the owner's. */
export const EXIT_AUTH = 3;
export const BEARER_VARIABLE = "PI_MSN_NOTICE_KEY";

export class CliMissingError extends Error {}

export function cliRunner(bin: string, timeoutMs = 30_000): RunCli {
  return (args, env) =>
    new Promise((resolve, reject) => {
      execFile(
        bin,
        args,
        {
          env: { ...process.env, ...env },
          timeout: timeoutMs,
          maxBuffer: 4 * 1024 * 1024,
          windowsHide: true,
        },
        (error, stdout, stderr) => {
          if (error && (error as NodeJS.ErrnoException).code === "ENOENT")
            return reject(
              new CliMissingError(
                `The MSN CLI (${bin}) is not installed or not on PATH. Install it: curl -fsSL https://msn.thehuman.sh/install.sh | sh`,
              ),
            );
          const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
          resolve({ code, stdout: String(stdout), stderr: String(stderr) });
        },
      );
    });
}

function profileArgs(profile: string | undefined): string[] {
  return profile ? ["--profile", profile] : [];
}

/** Arguments of the MSN MCP server, which carries every MSN tool. */
export function mcpArgs(config: Config): string[] {
  return [...profileArgs(config.profile), "mcp", ...(config.board ? ["--channel", config.board] : [])];
}

function ownerArgs(config: Config): string[] {
  return profileArgs(config.ownerProfile ?? config.profile);
}

/** The last line of stderr is the CLI's own error sentence. */
export function cliError(result: CliResult): string {
  const lines = result.stderr.trim().split("\n");
  return lines[lines.length - 1] || `msn exited with code ${result.code}`;
}

export function setWebhook(
  run: RunCli,
  config: Config,
  board: string,
  persona: string,
  url: string,
  bearer: string,
) {
  return run(
    [
      ...ownerArgs(config),
      "persona",
      "webhook",
      "set",
      "--bearer-env",
      BEARER_VARIABLE,
      "--",
      board,
      persona,
      url,
    ],
    { [BEARER_VARIABLE]: bearer },
  );
}

export function removeWebhook(run: RunCli, config: Config, board: string, persona: string) {
  return run([...ownerArgs(config), "persona", "webhook", "remove", "--", board, persona]);
}

export function testWebhook(run: RunCli, config: Config, board: string, persona: string) {
  return run([...ownerArgs(config), "persona", "webhook", "test", "--", board, persona]);
}

export function showWebhook(run: RunCli, config: Config, board: string, persona: string) {
  return run([...ownerArgs(config), "persona", "webhook", "show", "--", board, persona]);
}

export type BoardMessage = {
  id: number;
  channel: string;
  username?: string;
  text?: string;
  to?: string | null;
  recipients?: string[];
  replyTo?: number | null;
  kind?: string;
  contentType?: string;
  createdAt?: string;
  replacedBy?: number | null;
};

/** Reads one message with the agent's own key. Null when it cannot be read (deleted, no access, CLI error). */
export async function showMessage(
  run: RunCli,
  config: Config,
  board: string,
  id: number,
): Promise<BoardMessage | null> {
  const result = await run([...profileArgs(config.profile), "show", "--", board, String(id)]);
  if (result.code !== 0) return null;
  try {
    const message = (JSON.parse(result.stdout) as { message?: BoardMessage }).message;
    return message && message.id === id ? message : null;
  } catch {
    return null;
  }
}
