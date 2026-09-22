#!/usr/bin/env node
/**
 * Participant onboarding check: can this key read the named channel on the advertised origin?
 *
 * Manual:
 *   bun run onboarding-check -- --origin https://YOUR-WORKER.workers.dev \
 *     --tenant team --channel collaboration --profile planner
 *   MSN_URL=https://YOUR-WORKER.workers.dev MSN_WORKSPACE_TENANT=team \
 *     MSN_CHANNEL=collaboration MSN_WORKSPACE_TOKEN=… bun run onboarding-check
 *
 * The script prints pass/fail. It never prints tokens, Authorization headers, or profile file contents.
 */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SLUG = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export function parseArgs(argv, env = process.env) {
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      flags.help = true;
      continue;
    }
    if (!arg.startsWith("--")) {
      throw usage(`Unexpected argument: ${arg}`);
    }
    const key = arg.slice(2);
    if (!["origin", "url", "tenant", "channel", "profile"].includes(key)) {
      throw usage(`Unknown flag --${key}`);
    }
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) {
      throw usage(`--${key} requires a value`);
    }
    flags[key] = value;
    i += 1;
  }
  return {
    help: Boolean(flags.help),
    origin: flags.origin ?? flags.url ?? env.MSN_URL,
    tenant: flags.tenant ?? env.MSN_WORKSPACE_TENANT ?? env.MSN_TENANT,
    channel: flags.channel ?? env.MSN_CHANNEL,
    profile: flags.profile ?? env.MSN_PROFILE,
    token: env.MSN_WORKSPACE_TOKEN || env.MSN_TOKEN || "",
  };
}

export function usage(message) {
  const error = new Error(message);
  error.exitCode = 2;
  return error;
}

export function fail(message) {
  const error = new Error(message);
  error.exitCode = 1;
  return error;
}

export function normalizeOrigin(raw) {
  if (!raw || !String(raw).trim()) {
    throw usage("Set --origin / --url or MSN_URL (or pass --profile).");
  }
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw usage("Origin must be a bare server URL without credentials, path, query or fragment.");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw usage("Origin must be a bare server URL without credentials, path, query or fragment.");
  }
  if (parsed.pathname !== "/" && parsed.pathname !== "") {
    throw usage("Origin must be a bare server URL without credentials, path, query or fragment.");
  }
  const host = parsed.hostname;
  const localhost = host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";
  if (parsed.protocol === "http:") {
    if (!localhost) {
      throw usage("Use HTTPS (HTTP is allowed only on localhost).");
    }
  } else if (parsed.protocol !== "https:") {
    throw usage("Origin must be a bare server URL without credentials, path, query or fragment.");
  }
  return parsed.origin;
}

function requireSlug(value, label) {
  if (!value || !SLUG.test(value)) {
    throw usage(`${label} must be a lowercase slug (1–64 letters, digits, _ or -).`);
  }
  return value;
}

export function redact(text, secrets) {
  let out = String(text ?? "");
  for (const secret of secrets) {
    if (secret && secret.length > 0) {
      out = out.split(secret).join("<redacted>");
    }
  }
  return out;
}

function profilePath(name, env) {
  const xdg = env.XDG_CONFIG_HOME;
  const root = xdg && String(xdg) ? String(xdg) : join(env.HOME || homedir(), ".config");
  return join(root, "msn/profiles", `${name}.json`);
}

export async function loadProfile(name, env = process.env) {
  if (!SLUG.test(name)) {
    throw usage("Profile names use 1–64 lowercase letters, digits, _ or -, starting with a letter or digit.");
  }
  const path = profilePath(name, env);
  let raw;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    throw fail(`Profile "${name}" does not exist or cannot be read.`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw fail(`Profile "${name}" is not valid JSON.`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw fail(`Profile "${name}" is not a connection object.`);
  }
  return {
    origin: normalizeOrigin(parsed.url),
    tenant: requireSlug(String(parsed.tenant ?? ""), "profile tenant"),
    token: typeof parsed.token === "string" ? parsed.token : "",
    username: typeof parsed.username === "string" ? parsed.username : "",
    ...(typeof parsed.reader === "string" ? { reader: parsed.reader } : {}),
  };
}

export async function resolveInputs(flags, env = process.env, load = loadProfile) {
  let origin = flags.origin;
  let tenant = flags.tenant;
  let token = flags.token;
  const profileName = flags.profile || "";
  if (profileName) {
    const profile = await load(profileName, env);
    if (origin) {
      const advertised = normalizeOrigin(origin);
      if (advertised !== profile.origin) {
        throw fail(
          `Profile "${profileName}" origin ${profile.origin} does not match advertised origin ${advertised}.`,
        );
      }
    }
    if (tenant && tenant !== profile.tenant) {
      throw fail(
        `Profile "${profileName}" tenant ${profile.tenant} does not match advertised tenant ${tenant}.`,
      );
    }
    origin = profile.origin;
    tenant = profile.tenant;
    token = profile.token;
  }
  if (!flags.channel) {
    throw usage("Set --channel or MSN_CHANNEL.");
  }
  const channel = requireSlug(flags.channel, "channel");
  origin = normalizeOrigin(origin);
  tenant = requireSlug(tenant, "tenant");
  if (!token) {
    throw usage("Set MSN_WORKSPACE_TOKEN or pass --profile with a saved participant key.");
  }
  return { origin, tenant, channel, token, profileName };
}

async function readJson(response) {
  const text = await response.text();
  try {
    return { text, json: JSON.parse(text) };
  } catch {
    return { text, json: null };
  }
}

export async function checkOnboarding(inputs, fetchImpl = fetch) {
  const secrets = [inputs.token];
  const request = async (path, withToken) => {
    const headers = {};
    if (withToken) {
      headers.Authorization = `Bearer ${inputs.token}`;
    }
    return fetchImpl(`${inputs.origin}${path}`, {
      redirect: "error",
      signal: AbortSignal.timeout(20000),
      headers,
    });
  };

  let health;
  try {
    health = await request("/api/health", false);
  } catch (error) {
    throw fail(`Health request failed: ${redact(error.message, secrets)}`);
  }
  if (health.status !== 200) {
    throw fail(`Health check returned HTTP ${health.status}.`);
  }
  const healthBody = await readJson(health);
  if (healthBody.json?.ok !== true || healthBody.json.service !== "msn") {
    throw fail('Health response was not {ok:true,service:"msn"}.');
  }

  let identityResponse;
  try {
    identityResponse = await request(`/api/tenants/${inputs.tenant}`, true);
  } catch (error) {
    throw fail(`Identity request failed: ${redact(error.message, secrets)}`);
  }
  if (identityResponse.status === 401 || identityResponse.status === 403) {
    throw fail("Identity binding failed (unauthorized for this origin/tenant).");
  }
  if (identityResponse.status !== 200) {
    throw fail(`Identity request returned HTTP ${identityResponse.status}.`);
  }
  const identityBody = await readJson(identityResponse);
  const identity = identityBody.json;
  if (!identity || identity.tenant !== inputs.tenant) {
    throw fail("Identity response did not match the advertised workspace.");
  }

  let page;
  try {
    page = await request(
      `/api/tenants/${inputs.tenant}/channels/${inputs.channel}/messages?after=0&limit=1`,
      true,
    );
  } catch (error) {
    throw fail(`Channel read failed: ${redact(error.message, secrets)}`);
  }
  if (page.status === 401 || page.status === 403) {
    throw fail("Channel is not readable with this key.");
  }
  if (page.status === 404) {
    throw fail(`Channel "${inputs.channel}" was not found on ${inputs.origin}.`);
  }
  if (page.status !== 200) {
    const body = redact(await page.text(), secrets);
    throw fail(`Channel read returned HTTP ${page.status}: ${body.slice(0, 160)}`);
  }
  const pageBody = await readJson(page);
  if (!pageBody.json || !Array.isArray(pageBody.json.messages)) {
    throw fail("Channel read response was not a message page.");
  }

  return {
    origin: inputs.origin,
    tenant: inputs.tenant,
    channel: inputs.channel,
    username: identity.username ?? identity.usernamePrefix ?? "(unbound)",
    readable: true,
    empty: pageBody.json.messages.length === 0,
    profile: inputs.profileName || null,
  };
}

export function formatReport(result) {
  const lines = [
    "onboarding-check: PASS",
    `  origin    ${result.origin}`,
    `  tenant    ${result.tenant}`,
    `  username  ${result.username}`,
    `  channel   ${result.channel}${result.empty ? " (readable, empty)" : " (readable)"}`,
  ];
  if (result.profile) {
    lines.push(`  profile   ${result.profile}`);
  }
  return lines.join("\n");
}

export const HELP = `Usage:
  bun run onboarding-check -- --origin ORIGIN --tenant TENANT --channel CHANNEL [--profile NAME]
  MSN_URL ORIGIN, MSN_WORKSPACE_TENANT, MSN_CHANNEL, MSN_WORKSPACE_TOKEN or MSN_PROFILE

Checks health, the key's workspace binding, and that CHANNEL is readable on ORIGIN.
Never prints tokens. HTTP is allowed only on localhost.
`;

export async function run(argv, env = process.env, fetchImpl = fetch) {
  const secrets = [env.MSN_WORKSPACE_TOKEN, env.MSN_TOKEN].filter(Boolean);
  try {
    const flags = parseArgs(argv, env);
    if (flags.help) {
      return { code: 0, stdout: HELP, stderr: "" };
    }
    const inputs = await resolveInputs(flags, env);
    secrets.push(inputs.token);
    const result = await checkOnboarding(inputs, fetchImpl);
    return { code: 0, stdout: `${formatReport(result)}\n`, stderr: "" };
  } catch (error) {
    const code = error.exitCode ?? 1;
    return { code, stdout: "", stderr: `${redact(error.message, secrets)}\n` };
  }
}

const invoked = Boolean(process.argv[1]) && fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (invoked) {
  run(process.argv.slice(2), process.env)
    .then((result) => {
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      process.exitCode = result.code;
    })
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`${message}\n`);
      process.exitCode = error.exitCode ?? 1;
    });
}
