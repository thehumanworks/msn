import { test } from "./support/bounded.ts";
import assert from "node:assert/strict";
import { decodeIdentity } from "../src/core/decode.ts";
import { ProtocolError } from "../src/core/errors.ts";
import { activeMute, decodeMutes, muteLabel, removeMute, saveMute, type Mute } from "../src/core/mutes.ts";

const now = Date.parse("2026-11-20T10:00:00Z");

test("decodes the owner's mutes and rejects malformed ones", () => {
  const mutes = decodeMutes({
    mutes: [
      { channel: "ops", until: null, everything: true },
      { channel: "web", until: "2026-11-20T11:00:00.000Z", everything: false },
    ],
  });
  assert.equal(mutes.length, 2);
  for (const bad of [{}, { mutes: [{ channel: "x", until: "soon", everything: false }] }, { mutes: [{ channel: 1 }] }])
    assert.throws(() => decodeMutes(bad), ProtocolError);
});

test("an expired mute no longer counts, and labels say how long a mute lasts", () => {
  const mutes: Mute[] = [
    { channel: "ops", until: null, everything: false },
    { channel: "old", until: "2026-11-20T09:59:00.000Z", everything: false },
    { channel: "web", until: "2026-11-20T11:00:00.000Z", everything: false },
  ];
  assert.equal(activeMute(mutes, "old", now), null);
  assert.equal(activeMute(mutes, "none", now), null);
  assert.equal(muteLabel(null), "Mute");
  assert.equal(muteLabel(activeMute(mutes, "ops", now), now), "Muted");
  assert.match(muteLabel(activeMute(mutes, "web", now), now, "en-GB"), /^Muted until \d{1,2}:\d{2}/);
  assert.match(
    muteLabel({ channel: "web", until: "2026-11-23T11:00:00.000Z", everything: false }, now, "en-GB"),
    /^Muted until [A-Z][a-z]{2} /,
  );
});

test("saving or clearing a mute sends the right request, then reloads the list", async () => {
  const calls: unknown[][] = [];
  const api = {
    setMute: async (...args: unknown[]) => {
      calls.push(["set", ...args]);
      return { channel: "ops", until: null, everything: true };
    },
    clearMute: async (...args: unknown[]) => {
      calls.push(["clear", ...args]);
    },
    listMutes: async () => {
      calls.push(["list"]);
      return [];
    },
  };
  await saveMute(api, "ops", "forever", true);
  await saveMute(api, "ops", "1d", false);
  await removeMute(api, "ops");
  assert.deepEqual(calls, [
    ["set", "ops", null, true],
    ["list"],
    ["set", "ops", "1d", false],
    ["list"],
    ["clear", "ops"],
    ["list"],
  ]);
});

test("identity marks only the owner's key", () => {
  assert.equal(decodeIdentity({ tenant: "acme", username: "tomas", owner: true }, "acme").owner, true);
  assert.equal(decodeIdentity({ tenant: "acme", username: "agent" }, "acme").owner, undefined);
});
