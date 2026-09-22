import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { validateConfig } from "../scripts/host/protocol.mjs";
import { connectionsFor } from "../scripts/host/transport.mjs";

test("shared personas require an existing matching profile, remain scoped, and bind state to persona ID", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "msn-persona-transport-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, "msn/profiles"), { recursive: true });
  let identity = { tenant: "team", sharedChannel: true, channel: "work", username: null };
  let personas = [{ id: "persona-alice", displayName: "alice" }];
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    calls.push({ url: String(url), method: options.method ?? "GET" });
    return new Response(JSON.stringify(String(url).endsWith("/personas") ? { personas } : identity), {
      headers: { "content-type": "application/json" },
    });
  });
  const save = async (extra = {}) =>
    writeFile(
      join(dir, "msn/profiles/alice.json"),
      JSON.stringify({
        url: "https://example.test",
        tenant: "team",
        token: "test-secret",
        username: "alice",
        reader: "persona-alice",
        ...extra,
      }),
    );
  const config = (channels = ["work"]) =>
    validateConfig(
      {
        schema: "msn.host.v1",
        hostId: "test",
        stateDir: join(dir, "state"),
        agents: [
          {
            id: "worker",
            profile: "alice",
            command: ["node"],
            channels,
            allowedChannels: ["*"],
            permissionMode: "yolo",
          },
        ],
      },
      dir,
    );
  const connect = (c = config()) => connectionsFor(c, { XDG_CONFIG_HOME: dir }, new AbortController().signal);
  await save();
  const c = config();
  const result = await connect(c);
  assert.equal(result.connections.get("worker").personaId, "persona-alice");
  assert.equal(result.binding.agents[0].personaId, "persona-alice");
  assert.deepEqual(c.agents[0].allowedChannels, ["work"]);
  assert.ok(
    calls.every((c) => c.method === "GET"),
    "startup must not create or rename personas",
  );
  await assert.rejects(connect(config(["other"])), /participant_channel_scope_mismatch/);
  await save({ reader: "not-present" });
  await assert.rejects(connect(), /board_persona_identity_mismatch/);
  await save({ reader: "" });
  await assert.rejects(connect(), /board_persona_profile_required/);
  await save();
  personas = [{ id: "persona-alice", displayName: "renamed" }];
  await assert.rejects(connect(), /board_persona_identity_mismatch/);
  identity = { tenant: "team", username: null, channel: "work" };
  await assert.rejects(connect(), /channel_or_exact_name_participant_required/);
  identity = { tenant: "team", username: "another", channel: "work" };
  await assert.rejects(connect(), /profile_identity_mismatch/);
});
