import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { adapt, commandFor, parseAdapterArgs, promptFor } from "../scripts/host/prompt-adapter.mjs";

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
test("Claude, Codex and generic adapter output contracts are exercised with real executable fixtures", async (t) => {
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
  for (const harness of ["claude", "codex", "generic"]) {
    const result = await adapt({ harness, binary, command: [binary], model: "test-model" }, input);
    assert.equal(result.state.hasProtocol, true);
    if (harness === "claude") assert.ok(result.state.argv.includes("--dangerously-skip-permissions"));
    if (harness === "codex")
      assert.ok(result.state.argv.includes("--dangerously-bypass-approvals-and-sandbox"));
  }
});
