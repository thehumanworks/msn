// Writes the task-projection parity corpus (ADR 0070): message logs whose expected board comes
// from the Rust reducer. Run it, then fill the expected boards with cargo:
//
//   node tests/task-fixtures.mjs [count] [seed] [path]
//   MSN_TASK_FIXTURES_WRITE=1 cargo test --manifest-path cli/Cargo.toml --test task_parity
//
// MSN_TASK_FIXTURES=path points both the Rust and the web test at another file, for a bigger
// local fuzz run. The cases are made from a seeded generator, so the same arguments give the
// same file.
import { writeFileSync } from "node:fs";

const count = Number(process.argv[2] ?? 200);
const seed = Number(process.argv[3] ?? 67);
const path = process.argv[4] ?? new URL("./fixtures/task-projection.json", import.meta.url).pathname;

let state = seed >>> 0 || 1;
function random() {
  // xorshift32: small, seeded and the same on every machine.
  state ^= state << 13;
  state >>>= 0;
  state ^= state >>> 17;
  state ^= state << 5;
  state >>>= 0;
  return state / 4294967296;
}
const pick = (items) => items[Math.floor(random() * items.length)];
const chance = (p) => random() < p;

/** A raw JSON lexeme, written as it is into the event text. */
const raw = (text) => ({ raw: text });
function write(value) {
  if (value && typeof value === "object" && "raw" in value) return value.raw;
  if (Array.isArray(value)) return `[${value.map(write).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .map(([key, item]) => `${JSON.stringify(key)}:${write(item)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

const USERS = ["alice", "bob", "carol", "dave"];
const ODD_USERS = ["", " ", "\u0085", "\ufeff", "x".repeat(129), "é".repeat(64), "é".repeat(65), 7, null];
const TASKS = ["t1", "t2", "t3", "t4", "t5"];
const ODD_TASKS = ["Bad", "", "a".repeat(65), "-x", 3];
const TITLES = [
  "Do it",
  "Write the spec",
  "  ",
  "",
  "\u0085",
  "\ufeff",
  "a".repeat(256),
  "a".repeat(257),
  "é".repeat(128),
  "é".repeat(129),
  5,
  null,
];
const REASONS = ["waiting on bob", " ", "", "\u3000", "r".repeat(1024), "r".repeat(1025), 1, null];

function user() {
  return chance(0.92) ? pick(USERS) : pick(ODD_USERS);
}
function idValue(max) {
  const n = 1 + Math.floor(random() * (max + 2));
  return pick([
    n,
    n,
    n,
    String(n),
    raw(`${n}.0`),
    raw(`${n}e0`),
    `0${n}`,
    0,
    -n,
    raw("1e999"),
    raw("9007199254740992"),
    raw("9007199254740991"),
  ]);
}

function event(nextId) {
  const action = chance(0.97)
    ? pick([
        "open",
        "open",
        "claim",
        "claim",
        "assign",
        "block",
        "ready",
        "ready",
        "close",
        "close",
        "cancel",
      ])
    : pick(["reopen", "", 4]);
  const body = {};
  if (!chance(0.02)) body.schema = chance(0.97) ? "msn.task.v1" : pick(["msn.task.v2", 1]);
  if (!chance(0.02)) body.task = chance(0.95) ? pick(TASKS) : pick(ODD_TASKS);
  if (!chance(0.02)) body.action = action;
  if (action === "open") {
    if (!chance(0.05)) body.title = chance(0.85) ? pick(["Do it", "Write the spec", "Ship"]) : pick(TITLES);
    if (!chance(0.05)) body.reviewer = user();
    if (chance(0.4)) body.owner = user();
    if (chance(0.5)) {
      const deps = [];
      const n = Math.floor(random() * 3);
      for (let i = 0; i < n; i++) deps.push(chance(0.9) ? pick(TASKS) : pick(["zz", "Bad", 1]));
      body.dependsOn = chance(0.97)
        ? deps
        : pick([
            null,
            "t1",
            Array(33)
              .fill("t1")
              .map((t, i) => `${t}${i}`),
          ]);
    }
    if (chance(0.15))
      body.acceptance = pick(["tests pass", " ", "a".repeat(2048), "a".repeat(2049), 3, null]);
  }
  if (action === "assign") {
    if (!chance(0.05)) body.owner = user();
    if (chance(0.3)) body.reason = pick(REASONS);
  }
  if (action === "block" || action === "cancel")
    if (!chance(0.1)) body.reason = chance(0.8) ? "blocked on review" : pick(REASONS);
  if (action === "ready") {
    if (chance(0.95)) {
      const n = chance(0.95) ? 1 + Math.floor(random() * 3) : pick([0, 33]);
      body.evidence = Array.from({ length: n }, () =>
        chance(0.85) ? 1 + Math.floor(random() * Math.max(1, nextId - 1)) : idValue(nextId),
      );
    } else body.evidence = pick([null, "1", []]);
  }
  if (chance(0.03)) body.actor = user();
  return write(body);
}

function messageLog() {
  const length = 1 + Math.floor(random() * 30);
  const messages = [];
  for (let id = 1; id <= length; id++) {
    const message = {
      id,
      username: user(),
      contentType: "application/json",
      text: "",
    };
    const roll = random();
    if (roll < 0.7) message.text = event(id);
    else if (roll < 0.8) {
      message.contentType = "text/plain";
      message.text = chance(0.5) ? "evidence: tests pass" : event(id);
    } else if (roll < 0.85)
      message.text = pick([
        "{not json",
        "[1,2]",
        '"x"',
        "{}",
        "",
        "null",
        `${"[".repeat(127)}${"]".repeat(127)}`,
        `${"[".repeat(128)}${"]".repeat(128)}`,
        '{"schema":"msn.task.v1","task":"t1","action":"open","title":"\\ud800","reviewer":"bob"}',
        '{"a":1}{',
        '{"evidence":[1e999]}',
      ]);
    else if (roll < 0.92) {
      // A deleted or redacted row.
      if (chance(0.5)) message.deleted = true;
      message.username = pick(["", " "]);
      message.text = chance(0.5) ? "" : pick([" ", "\u0085"]);
      if (chance(0.3)) message.text = null;
    } else message.text = event(id);
    if (chance(0.02)) message.id = pick([0, "3", "03", 1.5, null]);
    messages.push(message);
  }
  return messages;
}

/**
 * A log that mostly follows the rules: tasks open with dependencies, get claimed or assigned,
 * marked ready with earlier evidence and closed by their reviewer, with some wrong steps mixed in.
 */
function storyLog() {
  const length = 4 + Math.floor(random() * 26);
  const messages = [];
  const open = [];
  const post = (username, body, extra = {}) =>
    messages.push({
      id: messages.length + 1,
      username,
      contentType: "application/json",
      text: write({ schema: "msn.task.v1", ...body }),
      ...extra,
    });
  while (messages.length < length) {
    const roll = random();
    if (!open.length || roll < 0.2) {
      const task = pick(TASKS);
      const creator = pick(USERS);
      const reviewer = pick(USERS);
      const dependsOn = open.length && chance(0.5) ? [pick(open).task] : chance(0.1) ? [pick(TASKS)] : [];
      const owner = chance(0.3) ? pick(USERS) : undefined;
      post(creator, {
        task,
        action: "open",
        title: "Do it",
        reviewer,
        ...(owner ? { owner } : {}),
        dependsOn,
      });
      open.push({ task, creator, reviewer, owner: owner ?? null });
      continue;
    }
    const t = pick(open);
    const right = chance(0.85);
    if (roll < 0.25) {
      // Plain work: a text message that later serves as evidence, sometimes deleted.
      messages.push({
        id: messages.length + 1,
        username: t.owner ?? pick(USERS),
        contentType: "text/plain",
        text: "done, see the diff",
        ...(chance(0.25) ? { deleted: true, username: "", text: "" } : {}),
      });
    } else if (!t.owner || roll < 0.4) {
      const who = right ? pick(USERS) : pick(USERS);
      post(who, { task: t.task, action: "claim" });
      t.owner ??= who;
    } else if (roll < 0.5 && chance(0.4)) {
      const owner = pick(USERS);
      post(right ? pick([t.creator, t.reviewer]) : pick(USERS), { task: t.task, action: "assign", owner });
      t.owner = owner;
    } else if (roll < 0.6 && chance(0.4)) {
      post(right ? t.owner : pick(USERS), { task: t.task, action: "block", reason: "waiting on a review" });
    } else if (roll < 0.8) {
      const evidence = messages.length ? [1 + Math.floor(random() * messages.length)] : [1];
      if (chance(0.05)) evidence.push(messages.length + 5);
      post(right ? t.owner : pick(USERS), { task: t.task, action: "ready", evidence });
    } else if (roll < 0.95) {
      post(right ? t.reviewer : pick(USERS), { task: t.task, action: "close" });
    } else {
      post(right ? t.creator : pick(USERS), { task: t.task, action: "cancel", reason: "not needed" });
    }
  }
  return messages;
}

const cases = [];
for (let i = 0; i < count; i++)
  cases.push({ name: `seed ${seed} case ${i}`, messages: i % 2 ? messageLog() : storyLog(), expected: null });
// One case per line keeps the file small and its diffs readable.
writeFileSync(path, `{"seed":${seed},"cases":[\n${cases.map((c) => JSON.stringify(c)).join(",\n")}\n]}\n`);
console.log(
  `Wrote ${cases.length} cases to ${path}. Now fill the expected boards with cargo (see the top of this file).`,
);
