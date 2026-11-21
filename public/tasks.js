// The board's tasks (ADR 0067): the web copy of the msn.task.v1 reducer in cli/src/tasks.rs, and
// the history scan that `msn task list` runs. Pure functions only, besides the scan's `api` argument.
//
// This is a second implementation of the reducer, which ADR 0018 and 0019 warn against: a wrong
// status that looks authoritative is worse than none. So it is a line-by-line port, and
// tests/fixtures/task-projection.json holds cases whose expected output comes from the Rust
// reducer. `cargo test` fails when the Rust output changes and the file is not regenerated, and
// tests/tasks-web.test.mjs fails when this file disagrees with it. Change both together.

export const SCHEMA = "msn.task.v1";
export const MAX_TITLE_BYTES = 256;
export const MAX_ACCEPTANCE_BYTES = 2048;
export const MAX_REASON_BYTES = 1024;
export const MAX_DEPENDS_ON = 32;
export const MAX_EVIDENCE = 32;
const MAX_SAFE = 9007199254740991n;
const ACTIONS = ["open", "claim", "assign", "block", "ready", "close", "cancel"];

const utf8 = new TextEncoder();
const bytes = (text) => utf8.encode(text).length;
// Rust's str::trim uses the Unicode White_Space property, which differs from JS trim (U+0085, U+FEFF).
const RUST_SPACE = new Set([
  9, 10, 11, 12, 13, 0x20, 0x85, 0xa0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000,
]);
for (let code = 0x2000; code <= 0x200a; code++) RUST_SPACE.add(code);
const isBlank = (text) => [...text].every((ch) => RUST_SPACE.has(ch.codePointAt(0)));
const isSlug = (value) => typeof value === "string" && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(value);
const isObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value) && !(value instanceof Num);
const str = (value) => (typeof value === "string" ? value : undefined);
const username = (value) =>
  typeof value === "string" && !isBlank(value) && bytes(value) <= 128 ? value : undefined;

/** A JSON number as written, so `1.0` and `1` stay apart like they do in serde_json. */
class Num {
  constructor(raw) {
    this.raw = raw;
  }
}

/** serde_json's `as_u64` limited to 1..=MAX_SAFE_INTEGER, or a canonical decimal string. */
function positiveId(value) {
  let raw;
  if (value instanceof Num) raw = value.raw;
  else if (typeof value === "number") raw = Number.isInteger(value) && value >= 0 ? String(value) : "";
  else if (typeof value === "string") raw = value;
  else return undefined;
  if (!/^(0|[1-9]\d*)$/.test(raw)) return undefined;
  const big = BigInt(raw);
  return big >= 1n && big <= MAX_SAFE ? Number(big) : undefined;
}

/**
 * Parse JSON text the way serde_json does for `Value`: numbers keep their lexeme, a lone
 * surrogate escape or nesting deeper than 128 is an error. Throws SyntaxError when it is not JSON.
 */
export function parseJson(text) {
  let at = 0;
  const fail = () => {
    throw new SyntaxError(`Invalid JSON at ${at}`);
  };
  const space = () => {
    while (at < text.length && " \t\n\r".includes(text[at])) at++;
  };
  const string = () => {
    at++;
    let out = "";
    for (;;) {
      if (at >= text.length) fail();
      const ch = text[at];
      const code = ch.charCodeAt(0);
      if (ch === '"') {
        at++;
        return out;
      }
      if (code < 0x20) fail();
      if (ch !== "\\") {
        if (code >= 0xd800 && code <= 0xdfff) {
          const next = text.charCodeAt(at + 1);
          if (code > 0xdbff || !(next >= 0xdc00 && next <= 0xdfff)) fail();
          out += text.slice(at, at + 2);
          at += 2;
          continue;
        }
        out += ch;
        at++;
        continue;
      }
      const esc = text[at + 1];
      at += 2;
      const simple = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" }[esc];
      if (simple !== undefined) {
        out += simple;
        continue;
      }
      if (esc !== "u") fail();
      const hex = () => {
        const digits = text.slice(at, at + 4);
        if (!/^[0-9a-fA-F]{4}$/.test(digits)) fail();
        at += 4;
        return Number.parseInt(digits, 16);
      };
      const unit = hex();
      if (unit >= 0xdc00 && unit <= 0xdfff) fail();
      if (unit >= 0xd800 && unit <= 0xdbff) {
        if (text[at] !== "\\" || text[at + 1] !== "u") fail();
        at += 2;
        const low = hex();
        if (low < 0xdc00 || low > 0xdfff) fail();
        out += String.fromCharCode(unit, low);
      } else out += String.fromCharCode(unit);
    }
  };
  const value = (depth) => {
    space();
    const ch = text[at];
    if (ch === "{" || ch === "[") {
      // serde_json's recursion limit: the 128th level of nesting is an error.
      if (depth >= 127) fail();
      at++;
      const object = ch === "{";
      const out = object ? {} : [];
      space();
      if (text[at] === (object ? "}" : "]")) {
        at++;
        return out;
      }
      for (;;) {
        if (object) {
          space();
          if (text[at] !== '"') fail();
          const key = string();
          space();
          if (text[at] !== ":") fail();
          at++;
          // Later duplicate keys replace earlier ones, as in serde_json's map.
          Object.defineProperty(out, key, {
            value: value(depth + 1),
            enumerable: true,
            writable: true,
            configurable: true,
          });
        } else out.push(value(depth + 1));
        space();
        if (text[at] === ",") {
          at++;
          continue;
        }
        if (text[at] === (object ? "}" : "]")) {
          at++;
          return out;
        }
        fail();
      }
    }
    if (ch === '"') return string();
    for (const [word, result] of [
      ["true", true],
      ["false", false],
      ["null", null],
    ])
      if (text.startsWith(word, at)) {
        at += word.length;
        return result;
      }
    const number = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/.exec(text.slice(at));
    // serde_json reads a number that overflows f64 as an error, not as infinity.
    if (!number || !Number.isFinite(Number(number[0]))) fail();
    at += number[0].length;
    return new Num(number[0]);
  };
  const result = value(0);
  space();
  if (at !== text.length) fail();
  return result;
}

function messageId(message) {
  return positiveId(message.id);
}

function isTombstone(message) {
  if (message.deleted === true) return true;
  const name = typeof message.username === "string" ? message.username : "";
  let text;
  if (typeof message.text === "string") text = message.text;
  else if (message.text === null || message.text === undefined) text = "";
  else return false;
  return isBlank(name) && isBlank(text);
}

function liveMessageIds(messages) {
  const live = new Set();
  const dead = new Set();
  for (const message of messages) {
    if (!isObject(message)) continue;
    const id = messageId(message);
    if (id === undefined) continue;
    if (isTombstone(message)) {
      dead.add(id);
      live.delete(id);
    } else if (!dead.has(id)) live.add(id);
  }
  return live;
}

function warn(warnings, code, messageId, task, detail) {
  warnings.push({ code, messageId: messageId ?? null, task: task ?? null, detail });
}

const has = (task, code) => task.conflicts.includes(code);
const addConflict = (task, code) => {
  if (!has(task, code)) task.conflicts.push(code);
};
const removeConflict = (task, code) => {
  task.conflicts = task.conflicts.filter((existing) => existing !== code);
};
const recordMessage = (task, id) => {
  if (!task.messageIds.includes(id)) task.messageIds.push(id);
};
const pushUnique = (items, value) => {
  if (!items.includes(value)) items.push(value);
};

function boundedRequired(value, max) {
  if (typeof value !== "string" || isBlank(value) || bytes(value) > max) return undefined;
  return value;
}
/** { ok, value }: null/absent/blank is no value; anything else not a short string is an error. */
function boundedOptional(value, max) {
  if (value === undefined || value === null) return { ok: true, value: null };
  if (typeof value === "string" && isBlank(value)) return { ok: true, value: null };
  if (typeof value === "string" && bytes(value) <= max) return { ok: true, value };
  return { ok: false };
}
function boundedPresent(value, max) {
  if (value === undefined || value === null) return { ok: true, value: null };
  if (typeof value === "string" && !isBlank(value) && bytes(value) <= max) return { ok: true, value };
  return { ok: false };
}

function parseDependsOn(event) {
  if (!Object.hasOwn(event, "dependsOn")) return [];
  const items = event.dependsOn;
  if (!Array.isArray(items) || items.length > MAX_DEPENDS_ON) return undefined;
  const slugs = [];
  for (const item of items) {
    if (!isSlug(item) || slugs.includes(item)) return undefined;
    slugs.push(item);
  }
  return slugs;
}

function parseEvidence(event, readyId) {
  const items = event.evidence;
  if (!Array.isArray(items) || !items.length || items.length > MAX_EVIDENCE) return undefined;
  const ids = [];
  for (const item of items) {
    const id = positiveId(item);
    if (id === undefined || id >= readyId || ids.includes(id)) return undefined;
    ids.push(id);
  }
  return ids;
}

function syncClaimConflict(task) {
  const contested =
    task.owner === null
      ? task.claimants.size > 1
      : [...task.claimants].some((claimant) => claimant !== task.owner);
  if (contested) addConflict(task, "claim-conflict");
  else removeConflict(task, "claim-conflict");
}

function applyOpen(id, actor, taskId, event, tasks, index, warnings) {
  if (index.has(taskId)) {
    const task = tasks[index.get(taskId)];
    recordMessage(task, id);
    addConflict(task, "duplicate-open");
    warn(warnings, "duplicate-open", id, taskId, "Duplicate open does not overwrite the original task.");
    return;
  }
  const title = boundedRequired(event.title, MAX_TITLE_BYTES);
  if (title === undefined)
    return warn(warnings, "malformed-event", id, taskId, "Task open is missing a non-blank title.");
  const acceptance = boundedOptional(event.acceptance, MAX_ACCEPTANCE_BYTES);
  if (!acceptance.ok)
    return warn(warnings, "malformed-event", id, taskId, "Task open acceptance is malformed or too long.");
  const reviewer = username(event.reviewer);
  if (reviewer === undefined)
    return warn(warnings, "malformed-event", id, taskId, "Task open is missing a valid reviewer.");
  let owner = null;
  if (event.owner !== undefined && event.owner !== null) {
    owner = username(event.owner) ?? null;
    if (owner === null)
      return warn(warnings, "malformed-event", id, taskId, "Task open owner is not a valid username.");
  }
  const dependsOn = parseDependsOn(event);
  if (dependsOn === undefined)
    return warn(warnings, "malformed-event", id, taskId, "Task open dependsOn is malformed.");
  const task = {
    id: taskId,
    title,
    owner,
    reviewer,
    creator: actor,
    state: "open",
    dependsOn,
    evidence: [],
    messageIds: [],
    conflicts: [],
    claimants: new Set(),
    blockedOn: [],
    closeUnsatisfied: false,
    acceptance: acceptance.value,
    reason: null,
  };
  recordMessage(task, id);
  index.set(taskId, tasks.length);
  tasks.push(task);
}

function applyClaim(id, actor, task, warnings) {
  if (task.state === "closed" || task.state === "cancelled")
    return warn(
      warnings,
      "invalid-transition",
      id,
      task.id,
      "Claim cannot reopen a closed or cancelled task.",
    );
  if (task.claimants.size === 0 && task.owner === null) task.owner = actor;
  task.claimants.add(actor);
  syncClaimConflict(task);
  recordMessage(task, id);
}

function applyAssign(id, actor, event, task, warnings) {
  if (actor !== task.creator && actor !== task.reviewer)
    return warn(warnings, "unauthorized", id, task.id, "Only the creator or reviewer may assign.");
  const owner = username(event.owner);
  if (owner === undefined)
    return warn(warnings, "malformed-event", id, task.id, "Task assign is missing a valid owner.");
  const reason = boundedPresent(event.reason, MAX_REASON_BYTES);
  if (!reason.ok)
    return warn(
      warnings,
      "malformed-event",
      id,
      task.id,
      "Task assign reason must be non-blank when present.",
    );
  task.owner = owner;
  task.claimants = new Set([owner]);
  task.reason = reason.value;
  task.evidence = [];
  removeConflict(task, "claim-conflict");
  if (task.state !== "open") {
    task.state = "open";
    task.closeUnsatisfied = false;
  }
  recordMessage(task, id);
}

function applyBlock(id, actor, event, task, warnings) {
  if (task.owner !== actor)
    return warn(warnings, "unauthorized", id, task.id, "Only the current owner may block.");
  if (task.state !== "open")
    return warn(warnings, "invalid-transition", id, task.id, "Block is only valid from open.");
  const reason = boundedRequired(event.reason, MAX_REASON_BYTES);
  if (reason === undefined)
    return warn(warnings, "malformed-event", id, task.id, "Task block requires a non-blank reason.");
  task.state = "blocked";
  task.reason = reason;
  recordMessage(task, id);
}

function applyReady(id, actor, event, task, warnings) {
  if (task.owner !== actor)
    return warn(warnings, "unauthorized", id, task.id, "Only the current owner may mark ready.");
  if (has(task, "claim-conflict"))
    return warn(
      warnings,
      "invalid-transition",
      id,
      task.id,
      "Ready does not clear unresolved claim conflicts.",
    );
  if (task.state !== "open" && task.state !== "blocked")
    return warn(warnings, "invalid-transition", id, task.id, "Ready is only valid from open or blocked.");
  const evidence = parseEvidence(event, id);
  if (evidence === undefined)
    return warn(
      warnings,
      "malformed-event",
      id,
      task.id,
      "Task ready requires at least one earlier positive evidence id.",
    );
  task.state = "ready";
  task.evidence = evidence;
  recordMessage(task, id);
}

function applyClose(id, actor, task, tasks, byId, warnings) {
  if (actor !== task.reviewer)
    return warn(warnings, "unauthorized", id, task.id, "Only the named reviewer may close.");
  if (has(task, "claim-conflict"))
    return warn(
      warnings,
      "invalid-transition",
      id,
      task.id,
      "Close is blocked while claim conflicts are unresolved.",
    );
  if (task.state !== "ready")
    return warn(warnings, "invalid-transition", id, task.id, "Close is only valid after ready.");
  const unsatisfied = !depsCleanNow(task, tasks, byId);
  task.state = "closed";
  task.closeUnsatisfied = unsatisfied;
  recordMessage(task, id);
}

function applyCancel(id, actor, event, task, warnings) {
  if (actor !== task.creator && actor !== task.reviewer)
    return warn(warnings, "unauthorized", id, task.id, "Only the creator or reviewer may cancel.");
  if (task.state !== "open" && task.state !== "blocked" && task.state !== "ready")
    return warn(
      warnings,
      "invalid-transition",
      id,
      task.id,
      "Cancel is only valid from open, blocked or ready.",
    );
  const reason = boundedRequired(event.reason, MAX_REASON_BYTES);
  if (reason === undefined)
    return warn(warnings, "malformed-event", id, task.id, "Task cancel requires a non-blank reason.");
  task.state = "cancelled";
  task.reason = reason;
  recordMessage(task, id);
}

function inherentUnclean(task) {
  return (
    task.state !== "closed" ||
    task.closeUnsatisfied ||
    task.conflicts.some(
      (code) => code === "orphan-evidence" || code === "claim-conflict" || code === "duplicate-open",
    )
  );
}

/** Rust's clean_closed_rec / clean_closed_now_rec: a dependency closed cleanly, all the way down. */
function cleanClosed(id, lookup, visiting, memo) {
  if (memo.has(id)) return memo.get(id);
  if (visiting.has(id)) return false;
  visiting.add(id);
  const task = lookup(id);
  if (!task) {
    visiting.delete(id);
    return false;
  }
  if (inherentUnclean(task)) {
    visiting.delete(id);
    memo.set(id, false);
    return false;
  }
  const ok = task.dependsOn.every((dep) => cleanClosed(dep, lookup, visiting, memo));
  visiting.delete(id);
  memo.set(id, ok);
  return ok;
}

function depsCleanNow(task, tasks, byId) {
  if (!task.dependsOn.length) return true;
  const lookup = (id) => (byId.has(id) ? tasks[byId.get(id)] : undefined);
  const visiting = new Set();
  const memo = new Map();
  return task.dependsOn.every((dep) => cleanClosed(dep, lookup, visiting, memo));
}

function cyclicTasks(tasks) {
  const graph = new Map(tasks.map((task) => [task.id, task.dependsOn]));
  const cyclic = new Set();
  const marks = new Map();
  const stack = [];
  const visit = (id) => {
    const mark = marks.get(id) ?? 0;
    if (mark === 2) return;
    if (mark === 1) {
      const start = stack.indexOf(id);
      if (start >= 0) for (const item of stack.slice(start)) cyclic.add(item);
      cyclic.add(id);
      return;
    }
    marks.set(id, 1);
    stack.push(id);
    for (const dep of graph.get(id) ?? []) visit(dep);
    stack.pop();
    marks.set(id, 2);
  };
  for (const task of tasks) visit(task.id);
  return cyclic;
}

function finalizeEvidence(tasks, live, warnings) {
  for (const task of tasks) {
    removeConflict(task, "orphan-evidence");
    const unknown = task.evidence.filter((id) => !live.has(id));
    if (unknown.length) {
      addConflict(task, "orphan-evidence");
      for (const id of unknown)
        warn(
          warnings,
          "unknown-evidence",
          id,
          task.id,
          "Evidence id is missing or deleted in the supplied messages.",
        );
    }
  }
}

function finalizeDependencies(tasks) {
  const ids = new Set(tasks.map((task) => task.id));
  const cyclic = cyclicTasks(tasks);
  // A snapshot, as in Rust: the checks below read the conflicts as they were before this pass.
  const snapshot = new Map(
    tasks.map((task) => [
      task.id,
      {
        state: task.state,
        dependsOn: task.dependsOn,
        closeUnsatisfied: task.closeUnsatisfied,
        conflicts: [...task.conflicts],
      },
    ]),
  );
  const lookup = (id) => (ids.has(id) ? snapshot.get(id) : undefined);
  for (const task of tasks) {
    removeConflict(task, "dependency-cycle");
    removeConflict(task, "dependency-missing");
    removeConflict(task, "unsatisfied-dependencies");
    const blockedOn = [];
    for (const dep of task.dependsOn) {
      if (!ids.has(dep)) {
        addConflict(task, "dependency-missing");
        pushUnique(blockedOn, dep);
        continue;
      }
      if (!cleanClosed(dep, lookup, new Set(), new Map())) pushUnique(blockedOn, dep);
    }
    if (cyclic.has(task.id)) addConflict(task, "dependency-cycle");
    if (task.closeUnsatisfied || ((task.state === "ready" || task.state === "closed") && blockedOn.length))
      addConflict(task, "unsatisfied-dependencies");
    task.blockedOn = blockedOn;
  }
}

function effectiveState(task) {
  const c = (code) => has(task, code);
  const depTrouble =
    c("unsatisfied-dependencies") ||
    c("dependency-cycle") ||
    c("dependency-missing") ||
    task.blockedOn.length > 0;
  switch (task.state) {
    case "closed":
      if (c("orphan-evidence")) return "unknown";
      if (c("claim-conflict") || c("duplicate-open") || depTrouble) return "conflict";
      return "closed";
    case "ready":
      if (c("orphan-evidence")) return "unknown";
      if (c("claim-conflict") || c("duplicate-open")) return "conflict";
      if (depTrouble) return "blocked";
      return "ready";
    case "cancelled":
      return "cancelled";
    case "blocked":
      return c("claim-conflict") ? "conflict" : "blocked";
    default:
      if (c("claim-conflict")) return "conflict";
      return task.blockedOn.length ? "blocked" : "open";
  }
}

function applyMessage(message, tasks, index, warnings) {
  if (!isObject(message)) return;
  const id = messageId(message);
  if (isTombstone(message))
    return warn(
      warnings,
      "deleted-or-redacted",
      id,
      null,
      "Deleted or redacted message is not a task event.",
    );
  if (message.contentType !== "application/json") return;
  if (id === undefined)
    return warn(warnings, "malformed-event", null, null, "Task-bearing message is missing a positive id.");
  const actor = username(message.username);
  if (actor === undefined)
    return warn(warnings, "malformed-event", id, null, "Task-bearing message is missing a usable username.");
  if (!Object.hasOwn(message, "text")) return;
  let event;
  if (isObject(message.text)) event = message.text;
  else if (typeof message.text === "string") {
    try {
      event = parseJson(message.text);
    } catch {
      return warn(warnings, "malformed-event", id, null, "application/json text was not valid JSON.");
    }
    if (!isObject(event)) return;
  } else return;
  const schema = str(event.schema);
  if (schema === undefined) return;
  if (schema !== SCHEMA)
    return warn(warnings, "unknown-schema", id, null, `Unsupported task schema ${schema}.`);
  const taskId = str(event.task);
  if (taskId === undefined)
    return warn(warnings, "malformed-event", id, null, "Task event is missing a task slug.");
  if (!isSlug(taskId)) return warn(warnings, "malformed-event", id, taskId, "Task id is not a valid slug.");
  const action = str(event.action);
  if (action === undefined)
    return warn(warnings, "malformed-event", id, taskId, "Task event is missing an action.");
  if (!ACTIONS.includes(action))
    return warn(warnings, "malformed-event", id, taskId, `Unknown task action ${action}.`);
  if (action === "open") return applyOpen(id, actor, taskId, event, tasks, index, warnings);
  if (!index.has(taskId))
    return warn(warnings, "unknown-task", id, taskId, "Task event refers to a task that was never opened.");
  const task = tasks[index.get(taskId)];
  if (action === "claim") applyClaim(id, actor, task, warnings);
  else if (action === "assign") applyAssign(id, actor, event, task, warnings);
  else if (action === "block") applyBlock(id, actor, event, task, warnings);
  else if (action === "ready") applyReady(id, actor, event, task, warnings);
  else if (action === "close") applyClose(id, actor, task, tasks, index, warnings);
  else applyCancel(id, actor, event, task, warnings);
}

/**
 * `{ tasks, warnings }` from a board's messages in log order, exactly like `msn task list`
 * (cli/src/tasks.rs `project`). Each task has id, title, owner, reviewer, creator, state,
 * assertedState, dependsOn, blockedOn, evidence, messageIds, conflicts, acceptance and reason.
 */
export function projectTasks(messages) {
  const live = liveMessageIds(messages);
  const tasks = [];
  const index = new Map();
  const warnings = [];
  for (const message of messages) applyMessage(message, tasks, index, warnings);
  finalizeEvidence(tasks, live, warnings);
  finalizeDependencies(tasks);
  return {
    tasks: tasks.map((task) => ({
      id: task.id,
      title: task.title,
      owner: has(task, "claim-conflict") ? null : task.owner,
      reviewer: task.reviewer,
      creator: task.creator,
      state: effectiveState(task),
      assertedState: task.state,
      dependsOn: task.dependsOn,
      blockedOn: task.blockedOn,
      evidence: task.evidence,
      messageIds: task.messageIds,
      conflicts: task.conflicts,
      acceptance: task.acceptance,
      reason: task.reason,
    })),
    warnings,
  };
}

/** The panel's sections, in the order they show. Each takes the tasks whose `when` is true. */
export const SECTIONS = [
  { key: "attention", title: "Needs a look", when: (t) => t.state === "conflict" || t.state === "unknown" },
  { key: "review", title: "Ready for review", when: (t) => t.state === "ready" },
  { key: "blocked", title: "Blocked", when: (t) => t.state === "blocked" },
  { key: "claimed", title: "Claimed", when: (t) => t.state === "open" && t.owner !== null },
  { key: "open", title: "Open", when: (t) => t.state === "open" && t.owner === null },
  { key: "closed", title: "Closed", when: (t) => t.state === "closed" || t.state === "cancelled" },
];

/** The sections with their tasks, sorted by id; empty sections are left out. */
export function groupTasks(tasks) {
  const sorted = [...tasks].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return SECTIONS.map((section) => ({
    key: section.key,
    title: section.title,
    tasks: sorted.filter(section.when),
  })).filter((section) => section.tasks.length);
}

const STATE_TEXT = {
  open: "Open",
  ready: "Ready for review",
  blocked: "Blocked",
  closed: "Closed",
  cancelled: "Cancelled",
  conflict: "Conflict",
  unknown: "Unknown",
};

/** What a task's state chip says. A claimed open task says who has it. */
export function stateText(task) {
  if (task.state === "open" && task.owner !== null) return "Claimed";
  return STATE_TEXT[task.state] ?? task.state;
}

const CONFLICT_TEXT = {
  "duplicate-open": "opened more than once",
  "claim-conflict": "claimed by more than one person",
  "dependency-cycle": "its dependencies form a loop",
  "dependency-missing": "depends on a task that was never opened",
  "unsatisfied-dependencies": "finished before its dependencies were closed",
  "orphan-evidence": "its evidence message was deleted",
};

/** Plain words for a conflict code; unknown codes show as they are. */
export function conflictText(code) {
  return CONFLICT_TEXT[code] ?? code;
}

/** Same limits as `msn task list`: pages of 100, at most 100 pages and 32 MiB, never a partial board. */
export const TASK_PAGES = 100;
export const TASK_SCAN_BYTES = 32 * 1024 * 1024;

/**
 * Read a board's whole history like `msn task list` (cli/src/task_client.rs `list`) and project it.
 * `api(path)` returns the parsed JSON of a GET under /channels/NAME; `size(page)` its byte size.
 * Throws an Error with a plain message when the history changes during the scan or is too big.
 * `current()` false stops the scan; it then returns null.
 */
export async function scanTasks(api, { tenant, channel, current = () => true, progress = () => {} }) {
  const path = (after, limit) => `/channels/${channel}/catchup?after=${after}&limit=${limit}&maxBytes=262144`;
  let cursor = 0;
  let head = null;
  let revision = null;
  let total = 0;
  let complete = false;
  const messages = [];
  const changed = () => new Error(`#${channel} history changed while reading its tasks. Try again.`);
  for (let pageNumber = 0; pageNumber < TASK_PAGES; pageNumber++) {
    const page = await api(path(cursor, 100));
    if (!current()) return null;
    total += bytes(JSON.stringify(page));
    if (total > TASK_SCAN_BYTES)
      throw new Error(`#${channel} has too much history to show its tasks here. Use msn task list instead.`);
    if (revision !== null && page.historyRevision !== revision) throw changed();
    revision = page.historyRevision;
    head ??= page.headCursor;
    if (page.headCursor < head) throw changed();
    let previous = cursor;
    for (const row of page.messages ?? []) {
      if (
        !Number.isSafeInteger(row.id) ||
        row.id <= previous ||
        row.id > page.headCursor ||
        row.tenant !== tenant ||
        row.channel !== channel
      )
        throw new Error(`#${channel} history came back out of order. Try again.`);
      previous = row.id;
      if (row.id <= head) messages.push(row);
    }
    if (page.nextCursor !== previous || (page.hasMore && !page.messages?.length))
      throw new Error(`#${channel} history came back out of order. Try again.`);
    cursor = page.nextCursor;
    progress(messages.length);
    if (!page.hasMore || cursor >= head) {
      complete = true;
      break;
    }
  }
  if (!complete)
    throw new Error(`#${channel} has too much history to show its tasks here. Use msn task list instead.`);
  // A deletion anywhere in history changes the revision and invalidates the board.
  const check = await api(path(0, 1));
  if (!current()) return null;
  if (check.historyRevision !== revision) throw changed();
  return {
    ...projectTasks(messages),
    headCursor: head,
    historyRevision: revision,
    messages: messages.length,
  };
}
