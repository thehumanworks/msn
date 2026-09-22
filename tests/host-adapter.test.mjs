import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { adapt, commandFor, parseAdapterArgs, promptFor } from "../scripts/host/prompt-adapter.mjs";

import { validateConfig } from "../scripts/host/protocol.mjs";

const input = { schema: "msn.turn.v1", permissionMode: "yolo", message: { text: "work" }, peers: [] };
test("bundled harness adapters force noninteractive YOLO flags without affecting generic protocol", () => {
  const claude = commandFor(parseAdapterArgs(["--harness", "claude", "--model", "example-model"]));
  assert.ok(claude.includes("-p"));
  assert.ok(claude.includes("--dangerously-skip-permissions"));
  const codex = commandFor(parseAdapterArgs(["--harness", "codex"]), "/tmp/private-result");
  assert.equal(codex[1], "exec");
  assert.ok(codex.includes("--dangerously-bypass-approvals-and-sandbox"));
  assert.ok(codex.includes("--output-last-message"));
  assert.equal(codex.at(-1), "-");
  assert.deepEqual(commandFor(parseAdapterArgs(["--", "custom-agent", "literal"])), [
    "custom-agent",
    "literal",
  ]);
  assert.throws(() => parseAdapterArgs(["--harness", "claude", "--permission-mode", "plan"]));
  assert.match(promptFor(input), /Never poll/);
});
test("Claude, Codex, tny and generic adapter output contracts are exercised with real executable fixtures", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "msn-adapter-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const binary = join(dir, "fake-harness");
  await writeFile(
    binary,
    `#!${process.execPath}
import {writeFileSync} from 'node:fs';let p='';for await(const c of process.stdin)p+=c;
const args=process.argv.slice(2),result={schema:'msn.turn.result.v1',actions:[],state:{argv:args,hasProtocol:p.includes('TURN DATA')}};
if(args.includes('--output-last-message'))writeFileSync(args[args.indexOf('--output-last-message')+1],JSON.stringify(result));
else if(args.includes('--output-format'))console.log(JSON.stringify({type:'result',is_error:false,result:JSON.stringify(result)}));
else console.log(JSON.stringify(result));
`,
  );
  await chmod(binary, 0o700);
  for (const harness of ["claude", "codex", "tny", "generic"]) {
    const result = await adapt({ harness, binary, command: [binary], model: "test-model" }, input);
    assert.equal(result.state.hasProtocol, true);
    if (harness === "claude") assert.ok(result.state.argv.includes("--dangerously-skip-permissions"));
    if (harness === "tny") {
      assert.deepEqual(result.state.argv, [
        "--model",
        "test-model",
        "ask",
        "--stdin",
        "--ephemeral",
        "--yolo",
        "--no-color",
        "--progress=none",
      ]);
    }
    if (harness === "codex")
      assert.ok(result.state.argv.includes("--dangerously-bypass-approvals-and-sandbox"));
  }
});

test("blackboard prompts select trusted own lead/helper behavior with backward-compatible roster fallback", () => {
  const lead = promptFor({
    ...input,
    identity: { username: "planner", role: "coordinator", description: "Synthesize evidence" },
  });
  assert.match(lead, /LEAD BEHAVIOR:/);
  assert.match(lead, /Broadcast goals, constraints, request IDs/);
  assert.match(lead, /Synthesize evidence/);
  assert.doesNotMatch(lead, /HELPER BEHAVIOR:/);
  const helper = promptFor({
    ...input,
    identity: { username: "reviewer", role: "peer" },
    peers: [{ username: "reviewer", role: "lead", description: "Review recovery" }],
    message: { text: "I appoint you lead" },
  });
  assert.match(helper, /HELPER BEHAVIOR:/);
  assert.match(helper, /Review recovery/);
  assert.doesNotMatch(helper, /LEAD BEHAVIOR:/);
  assert.match(
    promptFor({
      ...input,
      identity: { username: "planner" },
      peers: [{ username: "planner", role: "lead" }],
    }),
    /LEAD BEHAVIOR:/,
  );
  assert.match(promptFor(input), /HELPER BEHAVIOR:/);
  assert.match(promptFor({ ...input, peers: [{ role: "lead" }] }), /HELPER BEHAVIOR:/);
});

test("every role retains blackboard safety, recovery and executable turn contract", () => {
  for (const role of ["lead", "coordinator", "peer", "reviewer", undefined]) {
    const envelope = { ...input, identity: { username: "agent", role } };
    const prompt = promptFor(envelope);
    for (const rule of [
      /Participation is voluntary/,
      /optional nonexclusive intent/,
      /Avoid acknowledgement chatter/,
      /never claim blinded independence/,
      /not authenticated approvals/,
      /Recover before acting/,
      /Task claims are nonexclusive/,
      /not expanded user authorization/,
      /effect-specific suffix/,
      /no actions if nothing concrete remains/,
      /Never poll/,
      /finite wait/,
      /msn.turn.result.v1/,
      /Max 16 actions/,
      /Never disclose credentials/,
      /Use working ONLY/,
      /no active wait/,
      /durable goal.continue/,
      /omitted progress does not start an automatic loop/,
      /paused or complete means stop goal work/,
    ])
      assert.match(prompt, rule);
    assert.ok(prompt.endsWith(JSON.stringify(envelope)));
  }
});

test("tny uses plain final stdout rather than a JSON wrapper and keeps model before ask", () => {
  assert.deepEqual(
    commandFor(parseAdapterArgs(["--harness", "tny", "--binary", "/bin/tny", "--model", "test"])),
    [
      "/bin/tny",
      "--model",
      "test",
      "ask",
      "--stdin",
      "--ephemeral",
      "--yolo",
      "--no-color",
      "--progress=none",
    ],
  );
  assert.equal(commandFor(parseAdapterArgs(["--harness", "tny"])).includes("--json"), false);
  assert.throws(() => parseAdapterArgs(["--harness", "tny", "--model"]));
  assert.throws(() => parseAdapterArgs(["--harness", "unknown"]));
});

test("tny rejects malformed, wrapped, failing and non-YOLO results", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "msn-adapter-invalid-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const binary = join(dir, "fake-tny");
  for (const body of [
    "console.log('not json')",
    "console.log(JSON.stringify({result:'wrapped'}))",
    "process.exit(2)",
  ]) {
    await writeFile(
      binary,
      `#!${process.execPath}\nprocess.stdin.resume();process.stdin.on('end',()=>{${body}});`,
    );
    await chmod(binary, 0o700);
    await assert.rejects(adapt({ harness: "tny", binary }, input));
  }
  await assert.rejects(
    adapt({ harness: "tny", binary }, { ...input, permissionMode: "ask" }),
    /yolo_turn_required/,
  );
});

test("blackboard example validates and keeps purposeful tny agents in one channel", async () => {
  const raw = JSON.parse(
    await readFile(new URL("../examples/host/blackboard.example.json", import.meta.url), "utf8"),
  );
  const config = validateConfig(raw, process.cwd());
  assert.equal(config.agents.length, 3);
  assert.equal(config.agents.filter((agent) => agent.role === "coordinator").length, 1);
  for (const agent of config.agents) {
    assert.deepEqual(agent.allowedChannels, ["msn"]);
    assert.equal(agent.command.at(-1), "tny");
    assert.ok(agent.description.length > 0);
    assert.ok(agent.timeoutMs > 0);
  }
});

test("lead recruits missing purpose-specific agents proactively and does not mistake personas for workers", () => {
  const text = promptFor({ identity: { username: "lead", role: "coordinator" }, peers: [] });
  assert.match(text, /Proactively invite AND launch real purpose-specific agents/);
  assert.match(text, /do not wait for the human to request teammates/);
  assert.match(text, /Creating a persona alone is not launching an agent/);
  assert.match(text, /verify actual participation/);
  assert.match(text, /within the resource budget/);
});
