// End to end, inside a real Pi in RPC mode: the extension loads, registers the MSN tools, starts
// the webhook through a tunnel program, and a notice posted to the public URL reaches the model:
// it wakes an idle session and it steers a working one before its next model call.
//
// Stand-ins: the MSN CLI (fixtures/fake-msn.mjs), the tunnel program (fixtures/fake-tunnel.mjs,
// a real https hop) and the model (an OpenAI-compatible server in this file). Pi itself is real.
import assert from "node:assert/strict";
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { request as httpsRequest } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const packageDir = resolve(here, "../..");
const fixtures = join(here, "fixtures");
const piBin = join(packageDir, "node_modules/.bin/pi");

type Json = Record<string, unknown>;

let work: string;
let llm: Server;
let pi: ChildProcess;
const llmRequests: string[] = [];
const records: Json[] = [];
let stderr = "";
const waiters: Array<{ match: (record: Json) => boolean; resolve: (record: Json) => void }> = [];

function sse(response: import("node:http").ServerResponse, chunks: Json[]) {
  response.writeHead(200, { "content-type": "text/event-stream" });
  for (const chunk of chunks)
    response.write(
      `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", model: "fake-1", ...chunk })}\n\n`,
    );
  response.write("data: [DONE]\n\n");
  response.end();
}

/** Asks for one slow bash call when told to "do slow work"; otherwise answers "ok". */
function startModel(): Promise<Server> {
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      llmRequests.push(body);
      const messages = (JSON.parse(body) as { messages: Array<{ role: string }> }).messages;
      const hasToolResult = messages.some((message) => message.role === "tool");
      if (body.includes("do slow work") && !hasToolResult)
        return sse(response, [
          {
            choices: [
              {
                index: 0,
                delta: {
                  role: "assistant",
                  tool_calls: [
                    {
                      index: 0,
                      id: "call_1",
                      type: "function",
                      function: { name: "bash", arguments: '{"command":"sleep 3"}' },
                    },
                  ],
                },
              },
            ],
          },
          { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
        ]);
      sse(response, [
        { choices: [{ index: 0, delta: { role: "assistant", content: "ok" } }] },
        { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      ]);
    });
  });
  return new Promise((done) => server.listen(0, "127.0.0.1", () => done(server)));
}

function waitFor(
  what: string,
  match: (record: Json) => boolean,
  from = 0,
  timeoutMs = 30_000,
): Promise<Json> {
  const found = records.slice(from).find(match);
  if (found) return Promise.resolve(found);
  return new Promise((done, fail) => {
    const timer = setTimeout(
      () =>
        fail(
          new Error(
            `Timed out waiting for ${what}.\nstderr: ${stderr.slice(-2000)}\nlast records: ${JSON.stringify(records.slice(-8))}`,
          ),
        ),
      timeoutMs,
    );
    waiters.push({
      match,
      resolve: (record) => {
        clearTimeout(timer);
        done(record);
      },
    });
  });
}

function send(command: Json) {
  pi.stdin?.write(`${JSON.stringify(command)}\n`);
}

/** Sends a slash command and returns the text of the notice it shows. */
async function slash(text: string, expect: RegExp): Promise<string> {
  const from = records.length;
  send({ type: "prompt", message: text });
  const record = await waitFor(
    `a notice matching ${expect} after ${text}`,
    (r) => r.type === "extension_ui_request" && r.method === "notify" && expect.test(String(r.message)),
    from,
  );
  return String(record.message);
}

function msnLog(): Json[] {
  const file = join(work, "msn.log");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Json);
}

/** Calls the "public" URL as the board would, trusting the test certificate. Resolves to the status. */
function call(url: string, method: string, headers: Record<string, string>, body = ""): Promise<number> {
  return new Promise((done, fail) => {
    const request = httpsRequest(
      url,
      { method, headers, ca: readFileSync(join(work, "cert.pem")) },
      (response) => {
        response.resume();
        response.on("end", () => done(response.statusCode ?? 0));
      },
    );
    request.on("error", fail);
    request.end(body);
  });
}

function notice(url: string, bearer: string, id: string, messageId: number) {
  return call(
    url,
    "POST",
    { authorization: `Bearer ${bearer}`, "content-type": "application/json", "msn-webhook-id": id },
    JSON.stringify({
      schema: "msn.webhook.v1",
      type: "message.addressed",
      id,
      tenant: "team",
      channel: "work",
      persona: "reviewer",
      messageId,
      eventId: messageId,
      messageUrl: `https://msn.example/api/tenants/team/channels/work/messages/${messageId}`,
      createdAt: new Date().toISOString(),
    }),
  );
}

before(async () => {
  work = mkdtempSync(join(tmpdir(), "pi-msn-e2e-"));
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost",
      "-keyout",
      join(work, "key.pem"),
      "-out",
      join(work, "cert.pem"),
    ],
    { stdio: "ignore" },
  );
  llm = await startModel();
  const env: Record<string, string | undefined> = {
    ...process.env,
    PI_CODING_AGENT_DIR: join(work, "agent"),
    PI_OFFLINE: "1",
    PI_SKIP_VERSION_CHECK: "1",
    PI_TELEMETRY: "0",
    FAKE_LLM_URL: `http://127.0.0.1:${(llm.address() as AddressInfo).port}/v1`,
    FAKE_LLM_KEY: "test",
    FAKE_MSN_LOG: join(work, "msn.log"),
    NODE_EXTRA_CA_CERTS: join(work, "cert.pem"),
    PI_MSN_BIN: join(fixtures, "fake-msn.mjs"),
    PI_MSN_PROFILE: "reviewer",
    PI_MSN_OWNER_PROFILE: "owner",
    PI_MSN_BOARD: "work",
    PI_MSN_PERSONA: "reviewer",
    PI_MSN_TUNNEL: "command",
    PI_MSN_TUNNEL_COMMAND: JSON.stringify([
      process.execPath,
      join(fixtures, "fake-tunnel.mjs"),
      "{port}",
      join(work, "key.pem"),
      join(work, "cert.pem"),
    ]),
  };
  // Calls to localhost must not go through a proxy of the machine that runs the test.
  for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY", "all_proxy"])
    delete env[name];
  pi = spawn(
    piBin,
    [
      "--mode",
      "rpc",
      "--no-session",
      "-e",
      join(fixtures, "fake-provider.ts"),
      "-e",
      packageDir,
      "--model",
      "fake/fake-1",
    ],
    { cwd: work, env, stdio: ["pipe", "pipe", "pipe"] },
  );
  pi.stderr?.on("data", (chunk) => {
    stderr += chunk;
  });
  let buffer = "";
  pi.stdout?.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    for (;;) {
      const end = buffer.indexOf("\n");
      if (end < 0) break;
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      if (!line.trim()) continue;
      const record = JSON.parse(line) as Json;
      records.push(record);
      for (const waiter of waiters.splice(0)) {
        if (waiter.match(record)) waiter.resolve(record);
        else waiters.push(waiter);
      }
    }
  });
});

after(async () => {
  pi?.stdin?.end();
  await new Promise((done) => {
    if (!pi || pi.exitCode !== null) return done(null);
    const force = setTimeout(() => pi.kill("SIGKILL"), 10_000);
    pi.once("exit", () => {
      clearTimeout(force);
      done(null);
    });
  });
  llm?.close();
  llm?.closeAllConnections();
  rmSync(work, { recursive: true, force: true });
});

test("webhook messages wake and steer a real Pi session", { timeout: 120_000 }, async () => {
  // Start: receiver, tunnel, webhook on the board, and the board's ping comes back through.
  const started = await slash("/msn-webhook-start", /Public URL/);
  const url = /Public URL: (\S+)/.exec(started)?.[1] as string;
  assert.match(url, /^https:\/\/localhost:\d+\/msn-wake$/);
  assert.match(started, /Reachable: yes/);
  assert.match(started, /webhook set by this session/);
  const set = msnLog().find((entry) => entry.call === "webhook set") as Json;
  assert.equal(set.profile, "owner", "the owner profile sets the webhook");
  assert.deepEqual([set.board, set.persona, set.url, set.flag], ["work", "reviewer", url, "--bearer-env"]);
  const bearer = String(set.bearer);
  assert.ok(bearer.length >= 32, "a random key reached the CLI through the environment");
  assert.ok(!JSON.stringify(set.url).includes(bearer));

  // The MSN tools come from the CLI's MCP server, started with the agent's profile and board.
  const mcp = msnLog().find((entry) => entry.call === "mcp") as Json;
  assert.deepEqual([mcp.profile, mcp.args], ["reviewer", ["mcp", "--channel", "work"]]);

  // A wrong key is refused and nothing reaches the model.
  assert.equal(await call(url, "POST", { authorization: "Bearer wrong-key-000" }, "{}"), 401);

  // 1. Idle session: the message starts a turn.
  assert.equal(llmRequests.length, 0);
  assert.equal(await notice(url, bearer, "n-41", 41), 204);
  await waitFor("the run for message 41 to settle", (r) => r.type === "agent_settled");
  assert.equal(llmRequests.length, 1);
  assert.match(llmRequests[0], /MSN message 41 on board \\"work\\" from tomas to Reviewer/);
  assert.match(llmRequests[0], /please handle task number 41/);
  assert.match(llmRequests[0], /mcp__msn__send/, "the MSN tools are declared to the model");
  assert.equal(
    msnLog()
      .filter((entry) => entry.call === "show")
      .at(-1)?.profile,
    "reviewer",
    "read with the agent's own profile",
  );

  // A retry of the same notice is acknowledged and not delivered again.
  assert.equal(await notice(url, bearer, "n-41", 41), 204);

  // 2. Working session: the message arrives while a tool runs and is in the very next model call.
  const from = records.length;
  const before = llmRequests.length;
  send({ type: "prompt", message: "do slow work" });
  await waitFor("the bash tool to start", (r) => r.type === "tool_execution_start", from);
  assert.equal(await notice(url, bearer, "n-42", 42), 204);
  await waitFor("the steered run to settle", (r) => r.type === "agent_settled", from);
  const calls = llmRequests.slice(before);
  assert.equal(calls.length, 2, "one call that asks for the tool, one after it");
  assert.doesNotMatch(calls[0], /task number 42/);
  assert.match(calls[1], /"role":"tool"/);
  assert.match(calls[1], /please handle task number 42/, "steered in before the next model call");
  assert.equal(
    llmRequests.filter((body) => body.includes("task number 41")).length,
    llmRequests.length,
    "41 stays in context",
  );

  // Status, then stop: the webhook is removed and the tunnel program ends.
  const status = await slash("/msn-webhook-status", /Notices:/);
  assert.match(status, /Notices: 3 accepted, 1 repeats dropped, 1 refused/);
  assert.match(status, /Messages delivered: 2/);
  assert.match(status, /last ping: 20/);
  assert.match(status, /Board's last delivery: .*delivered/);
  const stopped = await slash("/msn-webhook-stop", /stopped/);
  assert.match(stopped, /removed from the board/);
  assert.deepEqual(
    msnLog()
      .filter((entry) => entry.call === "webhook remove")
      .map((entry) => [entry.profile, entry.board, entry.persona]),
    [["owner", "work", "reviewer"]],
  );
  await assert.rejects(call(url.replace("/msn-wake", "/healthz"), "GET", {}), "the tunnel is closed");

  // 3. Started again, the webhook outlives a new session and delivers into it.
  const again = await slash("/msn-webhook-start work reviewer", /Public URL/);
  const url2 = /Public URL: (\S+)/.exec(again)?.[1] as string;
  const bearer2 = String(
    msnLog()
      .filter((entry) => entry.call === "webhook set")
      .at(-1)?.bearer,
  );
  assert.notEqual(bearer2, bearer, "a new key for every start");
  const fromNew = records.length;
  send({ id: "new", type: "new_session" });
  await waitFor(
    "the new session",
    (r) => r.type === "response" && r.id === "new" && r.success === true,
    fromNew,
  );
  assert.equal(await notice(url2, bearer2, "n-43", 43), 204);
  await waitFor("the run for message 43 to settle", (r) => r.type === "agent_settled", fromNew);
  const inNew = llmRequests.at(-1) as string;
  assert.match(inNew, /please handle task number 43/);
  assert.doesNotMatch(inNew, /task number 41/, "it is a new session");

  // 4. Quitting Pi removes the webhook and ends the tunnel program.
  pi.stdin?.end();
  await new Promise((done) => pi.once("exit", done));
  assert.equal(msnLog().filter((entry) => entry.call === "webhook remove").length, 2);
  await assert.rejects(call(url2.replace("/msn-wake", "/healthz"), "GET", {}), "the tunnel is closed");
});
