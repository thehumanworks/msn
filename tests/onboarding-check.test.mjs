/**
 * Goal: onboarding-check confirms a participant can read a named channel on the advertised origin.
 *
 * Invariants:
 *  I7 given health + identity + readable channel, when check runs, then PASS names origin/tenant/channel
 *     -> given_healthy_readable_channel_when_check_then_pass
 *  I8 given a token, when the check fails or the server echoes the secret, then stdout/stderr omit it
 *     -> given_token_when_check_fails_or_server_echoes_then_output_omits_secret
 *  I9 given wrong health, identity, missing channel, or profile/origin mismatch, when check runs, then FAIL
 *     -> given_broken_server_or_mismatched_profile_when_check_then_fail
 *
 * Edge cases: usage without channel; HTTP remote origin rejected; empty channel still readable.
 * Out of scope: export/import; writing profiles; mutating the remote workspace.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  HELP,
  normalizeOrigin,
  parseArgs,
  redact,
  resolveInputs,
  run,
} from "../scripts/onboarding-check.mjs";

const exec = promisify(execFile);
const script = fileURLToPath(new URL("../scripts/onboarding-check.mjs", import.meta.url));
const SECRET = "super-secret-participant-token-do-not-print";

function listen(handler) {
  const server = createServer(handler);
  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        origin: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise((done, fail) => {
            server.close((error) => (error ? fail(error) : done()));
          }),
      });
    });
    server.once("error", reject);
  });
}

function scripted(routes) {
  return async (request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    const hit = routes.find((route) => route.method === request.method && route.path === url.pathname);
    if (!hit) {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "missing route" } }));
      return;
    }
    response.writeHead(hit.status, { "content-type": "application/json" });
    response.end(typeof hit.body === "string" ? hit.body : JSON.stringify(hit.body));
  };
}

function healthyRoutes(tenant, channel, extra = {}) {
  return [
    { method: "GET", path: "/api/health", status: 200, body: { ok: true, service: "msn" } },
    {
      method: "GET",
      path: `/api/tenants/${tenant}`,
      status: extra.identityStatus ?? 200,
      body: extra.identity ?? { tenant, username: "alice", usernamePrefix: null },
    },
    {
      method: "GET",
      path: `/api/tenants/${tenant}/channels/${channel}/messages`,
      status: extra.pageStatus ?? 200,
      body: extra.page ?? { messages: extra.messages ?? [{ id: 1 }], nextCursor: 1, hasMore: false },
    },
  ];
}

async function writeProfile(dir, name, profile) {
  const folder = join(dir, "msn/profiles");
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const path = join(folder, `${name}.json`);
  await writeFile(path, JSON.stringify(profile), { mode: 0o600 });
  return path;
}

test("given_healthy_readable_channel_when_check_then_pass", async () => {
  const { origin, close } = await listen(scripted(healthyRoutes("team", "collaboration")));
  try {
    const result = await run(["--origin", origin, "--tenant", "team", "--channel", "collaboration"], {
      MSN_WORKSPACE_TOKEN: SECRET,
    });
    assert.equal(result.code, 0);
    assert.match(result.stdout, /onboarding-check: PASS/);
    assert.match(result.stdout, new RegExp(`origin\\s+${origin}`));
    assert.match(result.stdout, /tenant\s+team/);
    assert.match(result.stdout, /username\s+alice/);
    assert.match(result.stdout, /channel\s+collaboration \(readable\)/);
    assert.doesNotMatch(result.stdout, /super-secret/);
    assert.equal(result.stderr, "");
  } finally {
    await close();
  }
});

test("given_empty_channel_when_check_then_pass_readable_empty", async () => {
  const { origin, close } = await listen(scripted(healthyRoutes("team", "lab", { messages: [] })));
  try {
    const result = await run(["--url", origin, "--tenant", "team", "--channel", "lab"], {
      MSN_WORKSPACE_TOKEN: SECRET,
    });
    assert.equal(result.code, 0);
    assert.match(result.stdout, /lab \(readable, empty\)/);
  } finally {
    await close();
  }
});

test("given_token_when_check_fails_or_server_echoes_then_output_omits_secret", async () => {
  const { origin, close } = await listen(
    scripted([
      { method: "GET", path: "/api/health", status: 200, body: { ok: true, service: "msn" } },
      {
        method: "GET",
        path: "/api/tenants/team",
        status: 200,
        body: { tenant: "team", username: "alice", usernamePrefix: null },
      },
      {
        method: "GET",
        path: "/api/tenants/team/channels/collaboration/messages",
        status: 500,
        body: { error: { message: `echo ${SECRET}` } },
      },
    ]),
  );
  try {
    const result = await run(["--origin", origin, "--tenant", "team", "--channel", "collaboration"], {
      MSN_WORKSPACE_TOKEN: SECRET,
    });
    assert.equal(result.code, 1);
    const combined = `${result.stdout}${result.stderr}`;
    assert.doesNotMatch(combined, /super-secret-participant-token-do-not-print/);
    assert.match(result.stderr, /<redacted>/);
  } finally {
    await close();
  }
});

test("given_broken_server_or_mismatched_profile_when_check_then_fail", async () => {
  const unhealthy = await listen(scripted([{ method: "GET", path: "/api/health", status: 503, body: {} }]));
  try {
    const health = await run(
      ["--origin", unhealthy.origin, "--tenant", "team", "--channel", "collaboration"],
      { MSN_WORKSPACE_TOKEN: SECRET },
    );
    assert.equal(health.code, 1);
    assert.match(health.stderr, /Health check returned HTTP 503/);
  } finally {
    await unhealthy.close();
  }

  const unauthorized = await listen(
    scripted(healthyRoutes("team", "collaboration", { identityStatus: 401, identity: { error: {} } })),
  );
  try {
    const auth = await run(
      ["--origin", unauthorized.origin, "--tenant", "team", "--channel", "collaboration"],
      { MSN_WORKSPACE_TOKEN: SECRET },
    );
    assert.equal(auth.code, 1);
    assert.match(auth.stderr, /unauthorized/);
  } finally {
    await unauthorized.close();
  }

  const missing = await listen(
    scripted(healthyRoutes("team", "collaboration", { pageStatus: 404, page: { error: {} } })),
  );
  try {
    const absent = await run(["--origin", missing.origin, "--tenant", "team", "--channel", "collaboration"], {
      MSN_WORKSPACE_TOKEN: SECRET,
    });
    assert.equal(absent.code, 1);
    assert.match(absent.stderr, /was not found/);
  } finally {
    await missing.close();
  }

  const dir = await mkdtemp(join(tmpdir(), "msn-onboard-"));
  await writeProfile(dir, "local-swarm", {
    url: "http://127.0.0.1:8787",
    tenant: "dev-team",
    token: SECRET,
    username: "alice",
    reader: "alice",
  });
  const mismatch = await run(
    [
      "--origin",
      "https://msn.example.workers.dev",
      "--tenant",
      "team",
      "--channel",
      "collaboration",
      "--profile",
      "local-swarm",
    ],
    { XDG_CONFIG_HOME: dir, HOME: dir },
  );
  assert.equal(mismatch.code, 1);
  assert.match(mismatch.stderr, /does not match advertised origin/);
  assert.doesNotMatch(`${mismatch.stdout}${mismatch.stderr}`, /super-secret/);
});

test("given_missing_channel_when_parse_then_usage", async () => {
  const result = await run(["--origin", "https://msn.example.workers.dev", "--tenant", "team"], {
    MSN_WORKSPACE_TOKEN: SECRET,
  });
  assert.equal(result.code, 2);
  assert.match(result.stderr, /--channel/);
});

test("given_http_remote_when_normalize_then_usage", () => {
  assert.throws(() => normalizeOrigin("http://remote.test"), /HTTPS/);
  assert.equal(normalizeOrigin("https://msn.example.workers.dev/"), "https://msn.example.workers.dev");
  assert.equal(normalizeOrigin("http://127.0.0.1:8787"), "http://127.0.0.1:8787");
});

test("given_help_when_run_then_prints_usage_without_secrets", async () => {
  const result = await run(["--help"], { MSN_WORKSPACE_TOKEN: SECRET });
  assert.equal(result.code, 0);
  assert.equal(result.stdout, HELP);
  assert.doesNotMatch(result.stdout, /super-secret|Bearer /);
});

test("given_profile_matching_advertised_when_resolve_then_uses_profile_token", async () => {
  const dir = await mkdtemp(join(tmpdir(), "msn-onboard-"));
  await writeProfile(dir, "planner", {
    url: "https://msn.example.workers.dev",
    tenant: "team",
    token: SECRET,
    username: "planner",
    reader: "planner",
  });
  const inputs = await resolveInputs(
    parseArgs(
      [
        "--origin",
        "https://msn.example.workers.dev",
        "--tenant",
        "team",
        "--channel",
        "collaboration",
        "--profile",
        "planner",
      ],
      { XDG_CONFIG_HOME: dir },
    ),
    { XDG_CONFIG_HOME: dir },
  );
  assert.equal(inputs.origin, "https://msn.example.workers.dev");
  assert.equal(inputs.token, SECRET);
  assert.equal(inputs.profileName, "planner");
});

test("given_redact_when_text_contains_secret_then_placeholder", () => {
  assert.equal(redact(`Authorization: Bearer ${SECRET}`, [SECRET]), "Authorization: Bearer <redacted>");
});

test("given_script_cli_when_spawned_then_pass_and_omits_token", async () => {
  const { origin, close } = await listen(scripted(healthyRoutes("team", "collaboration")));
  try {
    const result = await exec(
      process.execPath,
      [script, "--origin", origin, "--tenant", "team", "--channel", "collaboration"],
      {
        env: { PATH: process.env.PATH, MSN_WORKSPACE_TOKEN: SECRET },
      },
    );
    assert.match(result.stdout, /onboarding-check: PASS/);
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, /super-secret/);
  } finally {
    await close();
  }
});
