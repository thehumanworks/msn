#!/usr/bin/env node
// A stand-in for the MSN CLI in the end-to-end test. It records every call in FAKE_MSN_LOG
// (one JSON line each), answers `show`, plays the board for `persona webhook`, and serves a
// one-tool MCP server for `mcp`.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
const log = (entry) => appendFileSync(process.env.FAKE_MSN_LOG, `${JSON.stringify(entry)}\n`);
const command = args[0] === "--profile" ? args.slice(2) : args;
const profile = args[0] === "--profile" ? args[1] : null;

if (command[0] === "mcp") {
  log({ call: "mcp", profile, args: command });
  const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
  for await (const line of createInterface({ input: process.stdin })) {
    if (!line.trim()) continue;
    const request = JSON.parse(line);
    if (request.id === undefined) continue;
    if (request.method === "initialize")
      send({
        jsonrpc: "2.0",
        id: request.id,
        result: {
          protocolVersion: request.params.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: "msn", version: "0.0.0" },
        },
      });
    else if (request.method === "tools/list")
      send({
        jsonrpc: "2.0",
        id: request.id,
        result: {
          tools: [
            {
              name: "send",
              description: "Post a message to the board",
              inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
            },
          ],
        },
      });
    else send({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Method not found" } });
  }
  process.exit(0);
}

if (command[0] === "show") {
  if (command[1] !== "--") {
    console.error("fake msn: positionals must follow --");
    process.exit(2);
  }
  command.splice(1, 1);
  const id = Number(command[2]);
  log({ call: "show", profile, board: command[1], id });
  if (id === 404) {
    console.error("Message not found.");
    process.exit(4);
  }
  console.log(
    JSON.stringify({
      message: {
        id,
        channel: command[1],
        tenant: "team",
        username: "tomas",
        to: "Reviewer",
        text: `please handle task number ${id}`,
        createdAt: "2026-11-22T00:00:00.000Z",
      },
    }),
  );
  process.exit(0);
}

if (command[0] === "persona" && command[1] === "webhook") {
  // Shape: persona webhook ACTION [--bearer-env VAR] -- BOARD PERSONA [URL]
  const rest = command.slice(2);
  const action = rest[0];
  const dashes = rest.indexOf("--");
  const [flag, variable] = rest.slice(1, dashes);
  const [board, persona, url] = rest.slice(dashes + 1);
  if (dashes < 0) {
    console.error("fake msn: positionals must follow --");
    process.exit(2);
  }
  if (process.env.FAKE_MSN_NOT_OWNER) {
    log({ call: `webhook ${action}`, refused: true });
    console.error("Only the workspace owner can do this.");
    process.exit(3);
  }
  if (action === "set") {
    // The key must arrive through the named environment variable, never as an argument.
    log({ call: "webhook set", profile, board, persona, url, flag, variable, bearer: process.env[variable] });
    writeFileSync(`${process.env.FAKE_MSN_LOG}.set`, JSON.stringify({ url, bearer: process.env[variable] }));
    console.log(JSON.stringify({ webhook: { url, bearer: true } }));
  } else if (action === "test") {
    const file = `${process.env.FAKE_MSN_LOG}.set`;
    const set = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
    log({ call: "webhook test", profile, board, persona });
    if (set)
      await fetch(set.url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${set.bearer}`,
          "content-type": "application/json",
          "msn-webhook-id": `ping-${Date.now()}`,
        },
        body: JSON.stringify({ schema: "msn.webhook.v1", type: "ping", id: "ping", channel: board, persona }),
      }).catch(() => undefined);
    console.log(JSON.stringify({ queued: true }));
  } else if (action === "show") {
    log({ call: "webhook show", profile, board, persona });
    console.log(JSON.stringify({ webhook: { lastDelivery: { status: "delivered", httpStatus: 204 } } }));
  } else if (action === "remove") {
    log({ call: "webhook remove", profile, board, persona });
    console.log(JSON.stringify({ removed: persona }));
  }
  process.exit(0);
}

console.error(`fake msn: unknown command ${command.join(" ")}`);
process.exit(2);
