// Settings for pi-msn. Read from two optional JSON files, then from environment variables, which
// win. Nothing here touches Pi, so it can be tested with plain Node.
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const CONFIG_FILE = "pi-msn.json";

export type ToolExposure = "direct" | "deferred" | "codemode" | "off";
export type DeliverAs = "steer" | "followUp" | "nextTurn";
export type Subscribe = "addressed" | "board" | "workspace";
export type TunnelProvider = "cloudflared" | "command" | "none";

export type Config = {
  /** The MSN CLI executable. */
  msnBin: string;
  /** Saved MSN profile the agent reads and writes with. Unset: the CLI's own selection (MSN_PROFILE or MSN_* variables). */
  profile?: string;
  /** Saved MSN profile of the workspace owner, used only to set and remove the webhook. Unset: same as `profile`. */
  ownerProfile?: string;
  /** Default board (channel) for the tools and the webhook. */
  board?: string;
  /** Persona id whose addressed messages wake this agent. */
  persona?: string;
  /** What the webhook is told about: messages addressed to the persona, every message on its board, or on every board. */
  subscribe: Subscribe;
  /** How the MSN tools reach the model; "off" registers none. */
  tools: ToolExposure;
  /** How a board message enters the session. */
  deliverAs: DeliverAs;
  /** What makes the local receiver public. */
  tunnel: TunnelProvider;
  /** For tunnel "command": argv, with {port} and {url} replaced by the local port and URL. */
  tunnelCommand?: string[];
  /** For tunnel "command": a regular expression whose first match in the output is the public URL. */
  tunnelUrlPattern?: string;
  /** For tunnel "none": the public https origin that already forwards to the local receiver. */
  publicUrl?: string;
  /** How long to wait for the tunnel to print its URL. */
  tunnelTimeoutMs: number;
  /** Local port of the receiver; 0 picks a free one. */
  port: number;
  /** Path the notices are posted to. */
  path: string;
  /** Set and remove the webhook on the board. False when the owner sets it by hand. */
  register: boolean;
  /** A fixed bearer key. Unset: a new random key for every start. Environment only, never a file. */
  bearer?: string;
  /** Start the webhook when a session starts. */
  autoStart: boolean;
};

export const DEFAULTS: Config = {
  msnBin: "msn",
  subscribe: "addressed",
  tools: "direct",
  deliverAs: "steer",
  tunnel: "cloudflared",
  tunnelTimeoutMs: 30_000,
  port: 0,
  path: "/msn-wake",
  register: true,
  autoStart: false,
};

const TOOLS: ToolExposure[] = ["direct", "deferred", "codemode", "off"];
const SUBSCRIBE: Subscribe[] = ["addressed", "board", "workspace"];
const DELIVER: DeliverAs[] = ["steer", "followUp", "nextTurn"];
const TUNNELS: TunnelProvider[] = ["cloudflared", "command", "none"];

export class ConfigError extends Error {}

function text(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new ConfigError(`${name} must be a string.`);
  return value;
}

function oneOf<T extends string>(value: unknown, allowed: T[], name: string): T | undefined {
  const given = text(value, name);
  if (given === undefined) return undefined;
  if (!allowed.includes(given as T)) throw new ConfigError(`${name} must be one of: ${allowed.join(", ")}.`);
  return given as T;
}

function flag(value: unknown, name: string): boolean | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "boolean") return value;
  if (value === "1" || value === "true") return true;
  if (value === "0" || value === "false") return false;
  throw new ConfigError(`${name} must be true or false.`);
}

function integer(value: unknown, name: string, min: number, max: number): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(number) || number < min || number > max)
    throw new ConfigError(`${name} must be a whole number from ${min} to ${max}.`);
  return number;
}

function argv(value: unknown, name: string): string[] | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  let list = value;
  if (typeof value === "string") {
    try {
      list = JSON.parse(value);
    } catch {
      throw new ConfigError(`${name} must be a JSON array of strings, such as ["ngrok","http","{port}"].`);
    }
  }
  if (!Array.isArray(list) || list.length === 0 || list.some((part) => typeof part !== "string" || !part))
    throw new ConfigError(`${name} must be a non-empty array of strings.`);
  return list as string[];
}

/** Keys a settings file may hold. `bearer` is left out on purpose: a key does not belong in a file. */
function fromObject(raw: Record<string, unknown>, where: string): Partial<Config> {
  const name = (key: string) => `${key} in ${where}`;
  return clean({
    msnBin: text(raw.msnBin, name("msnBin")),
    profile: text(raw.profile, name("profile")),
    ownerProfile: text(raw.ownerProfile, name("ownerProfile")),
    board: text(raw.board, name("board")),
    persona: text(raw.persona, name("persona")),
    subscribe: oneOf(raw.subscribe, SUBSCRIBE, name("subscribe")),
    tools: oneOf(raw.tools, TOOLS, name("tools")),
    deliverAs: oneOf(raw.deliverAs, DELIVER, name("deliverAs")),
    tunnel: oneOf(raw.tunnel, TUNNELS, name("tunnel")),
    tunnelCommand: argv(raw.tunnelCommand, name("tunnelCommand")),
    tunnelUrlPattern: text(raw.tunnelUrlPattern, name("tunnelUrlPattern")),
    publicUrl: text(raw.publicUrl, name("publicUrl")),
    tunnelTimeoutMs: integer(raw.tunnelTimeoutMs, name("tunnelTimeoutMs"), 1000, 600_000),
    port: integer(raw.port, name("port"), 0, 65535),
    path: text(raw.path, name("path")),
    register: flag(raw.register, name("register")),
    autoStart: flag(raw.autoStart, name("autoStart")),
  });
}

function fromEnv(env: Record<string, string | undefined>): Partial<Config> {
  return clean({
    msnBin: text(env.PI_MSN_BIN, "PI_MSN_BIN"),
    profile: text(env.PI_MSN_PROFILE, "PI_MSN_PROFILE"),
    ownerProfile: text(env.PI_MSN_OWNER_PROFILE, "PI_MSN_OWNER_PROFILE"),
    board: text(env.PI_MSN_BOARD, "PI_MSN_BOARD"),
    persona: text(env.PI_MSN_PERSONA, "PI_MSN_PERSONA"),
    subscribe: oneOf(env.PI_MSN_SUBSCRIBE, SUBSCRIBE, "PI_MSN_SUBSCRIBE"),
    tools: oneOf(env.PI_MSN_TOOLS, TOOLS, "PI_MSN_TOOLS"),
    deliverAs: oneOf(env.PI_MSN_DELIVER_AS, DELIVER, "PI_MSN_DELIVER_AS"),
    tunnel: oneOf(env.PI_MSN_TUNNEL, TUNNELS, "PI_MSN_TUNNEL"),
    tunnelCommand: argv(env.PI_MSN_TUNNEL_COMMAND, "PI_MSN_TUNNEL_COMMAND"),
    tunnelUrlPattern: text(env.PI_MSN_TUNNEL_URL_PATTERN, "PI_MSN_TUNNEL_URL_PATTERN"),
    publicUrl: text(env.PI_MSN_PUBLIC_URL, "PI_MSN_PUBLIC_URL"),
    tunnelTimeoutMs: integer(env.PI_MSN_TUNNEL_TIMEOUT_MS, "PI_MSN_TUNNEL_TIMEOUT_MS", 1000, 600_000),
    port: integer(env.PI_MSN_PORT, "PI_MSN_PORT", 0, 65535),
    path: text(env.PI_MSN_PATH, "PI_MSN_PATH"),
    register: flag(env.PI_MSN_REGISTER, "PI_MSN_REGISTER"),
    bearer: text(env.PI_MSN_WEBHOOK_BEARER, "PI_MSN_WEBHOOK_BEARER"),
    autoStart: flag(env.PI_MSN_WEBHOOK, "PI_MSN_WEBHOOK"),
  });
}

function clean<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}

function readFile(path: string): Partial<Config> {
  let body: string;
  try {
    body = readFileSync(path, "utf8");
  } catch {
    return {};
  }
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    throw new ConfigError(`${path} is not valid JSON.`);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    throw new ConfigError(`${path} must hold a JSON object.`);
  return fromObject(raw as Record<string, unknown>, path);
}

/** Checks that the pieces fit together, and normalises the path and the public URL. */
export function validate(config: Config): Config {
  if (!config.path.startsWith("/") || /[?#\s]/.test(config.path))
    throw new ConfigError('path must start with "/" and hold no query, fragment or space.');
  if (config.bearer !== undefined && !/^[\x21-\x7e]{8,1024}$/.test(config.bearer))
    throw new ConfigError("PI_MSN_WEBHOOK_BEARER must be 8 to 1024 visible ASCII characters without spaces.");
  if (config.tunnel === "command" && !config.tunnelCommand)
    throw new ConfigError('tunnel "command" needs tunnelCommand, such as ["ngrok","http","{port}"].');
  if (config.tunnelUrlPattern !== undefined) {
    try {
      new RegExp(config.tunnelUrlPattern);
    } catch {
      throw new ConfigError("tunnelUrlPattern is not a valid regular expression.");
    }
  }
  if (config.tunnel === "none") {
    if (!config.publicUrl)
      throw new ConfigError('tunnel "none" needs publicUrl: the public https address that forwards here.');
    if (config.port === 0)
      throw new ConfigError('tunnel "none" needs a fixed port, so your own proxy knows where to forward.');
  }
  if (config.publicUrl !== undefined) {
    let url: URL;
    try {
      url = new URL(config.publicUrl);
    } catch {
      throw new ConfigError("publicUrl must be an absolute https URL.");
    }
    if (url.protocol !== "https:" || url.search || url.hash || url.username || url.password)
      throw new ConfigError("publicUrl must be https with no query, fragment, user name or password.");
  }
  return config;
}

export type ConfigSources = {
  /** Pi's agent directory (~/.pi/agent). */
  agentDir?: string;
  /** The project's Pi directory (<cwd>/.pi); pass it only for a trusted project. */
  projectDir?: string;
  env?: Record<string, string | undefined>;
};

/** Defaults, then the user's file, then the trusted project's file, then the environment. */
export function loadConfig(sources: ConfigSources): Config {
  return validate({
    ...DEFAULTS,
    ...(sources.agentDir ? readFile(join(sources.agentDir, CONFIG_FILE)) : {}),
    ...(sources.projectDir ? readFile(join(sources.projectDir, CONFIG_FILE)) : {}),
    ...fromEnv(sources.env ?? {}),
  });
}
