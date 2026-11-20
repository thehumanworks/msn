/** Synchronous, short transactions only. Never hold a work transaction across an await. */
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { digest, HostError, RECOVERY_GRACE_MS, requireValue } from "./protocol.mjs";

export class HostStore {
  constructor(config, binding, now = Date.now()) {
    this.config = config;
    this.binding = binding;
    mkdirSync(config.stateDir, { recursive: true, mode: 0o700 });
    const stat = lstatSync(config.stateDir);
    requireValue(
      stat.isDirectory() && !stat.isSymbolicLink() && (stat.mode & 0o077) === 0,
      "state_directory_must_be_private",
    );
    for (const file of ["owner.sqlite", "state.sqlite", "state.sqlite-wal", "state.sqlite-shm"]) {
      const path = join(config.stateDir, file);
      if (existsSync(path))
        requireValue(lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink(), "invalid_state_file");
    }
    // Separate lock DB: an OS-owned SQLite lock releases even after SIGKILL. No stale pidfile.
    this.lock = new DatabaseSync(join(config.stateDir, "owner.sqlite"), { timeout: 0 });
    try {
      this.lock.exec(
        "PRAGMA journal_mode=DELETE; CREATE TABLE IF NOT EXISTS ownership (singleton INTEGER); BEGIN EXCLUSIVE",
      );
    } catch {
      this.lock.close();
      throw new HostError("host_state_already_owned");
    }
    try {
      this.db = new DatabaseSync(join(config.stateDir, "state.sqlite"), { timeout: 0 });
      this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
        CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS agents (
          id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, cursor INTEGER NOT NULL DEFAULT 0,
          initialized INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'null', channels TEXT NOT NULL, waiting TEXT);
        CREATE TABLE IF NOT EXISTS jobs (
          id INTEGER PRIMARY KEY AUTOINCREMENT, agent TEXT NOT NULL, event_id INTEGER, channel TEXT NOT NULL,
          event TEXT, trigger TEXT, root TEXT, status TEXT NOT NULL DEFAULT 'queued', attempts INTEGER NOT NULL DEFAULT 0,
          available INTEGER NOT NULL DEFAULT 0, lease_until INTEGER NOT NULL DEFAULT 0, error TEXT,
          counted INTEGER NOT NULL DEFAULT 0,
          UNIQUE(agent, event_id));
        CREATE INDEX IF NOT EXISTS jobs_ready ON jobs(agent, status, available, id);
        CREATE TABLE IF NOT EXISTS outbox (
          id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT UNIQUE NOT NULL, agent TEXT NOT NULL,
          channel TEXT NOT NULL, body TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued',
          attempts INTEGER NOT NULL DEFAULT 0, available INTEGER NOT NULL DEFAULT 0, error TEXT);
        CREATE INDEX IF NOT EXISTS outbox_ready ON outbox(agent, status, available, id);
        CREATE TABLE IF NOT EXISTS server_commits (
          agent TEXT NOT NULL, channel TEXT NOT NULL, generation INTEGER NOT NULL,
          PRIMARY KEY(agent, channel));
        CREATE TABLE IF NOT EXISTS budgets (
          root TEXT PRIMARY KEY, turns INTEGER NOT NULL, agent_turns INTEGER NOT NULL DEFAULT 0,
          last_human_event_id INTEGER NOT NULL DEFAULT 0, next_warning INTEGER NOT NULL DEFAULT 0);
      `);
      this.tx(() => {
        // Version 1 -> 2: additive columns. Older hosts insert positional budget rows, so they cannot
        // reuse this file after migration; the version bump makes them fail closed at open instead.
        for (const [table, column, type] of [
          ["jobs", "counted", "INTEGER NOT NULL DEFAULT 0"],
          ["budgets", "agent_turns", "INTEGER NOT NULL DEFAULT 0"],
          ["budgets", "last_human_event_id", "INTEGER NOT NULL DEFAULT 0"],
          ["budgets", "next_warning", "INTEGER NOT NULL DEFAULT 0"],
        ])
          if (
            !this.db
              .prepare(`PRAGMA table_info(${table})`)
              .all()
              .some((c) => c.name === column)
          )
            this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
        // Legacy rows and rows created while the soft budget was disabled start at the first milestone.
        if (config.softTurnsPerConversation > 0)
          this.db
            .prepare("UPDATE budgets SET next_warning=? WHERE next_warning=0")
            .run(config.softTurnsPerConversation);
        const saved = this.db.prepare("SELECT value FROM meta WHERE key='binding'").get();
        const serialized = JSON.stringify(binding);
        if (saved && saved.value !== serialized) {
          // Roster changes are additive. Workspace and every saved agent record, including its
          // allowedChannels, must survive unchanged; only new agents may appear (ADR 0025).
          const previous = JSON.parse(saved.value);
          requireValue(
            ["version", "hostId", "origin", "tenant"].every((k) => previous[k] === binding[k]),
            "host_state_binding_mismatch",
          );
          for (const was of previous.agents ?? []) {
            const is = binding.agents.find((a) => a.id === was.id);
            requireValue(is, "host_state_agent_removed");
            requireValue(is.username === was.username, "host_state_agent_identity_mismatch");
            requireValue(JSON.stringify(is) === JSON.stringify(was), "host_state_binding_mismatch");
          }
          this.db.prepare("UPDATE meta SET value=? WHERE key='binding'").run(serialized);
        }
        this.db.prepare("INSERT OR IGNORE INTO meta VALUES ('binding', ?)").run(serialized);
        this.db.prepare("INSERT OR IGNORE INTO meta VALUES ('version', '2')").run();
        this.db.prepare("UPDATE meta SET value='2' WHERE key='version' AND value='1'").run();
        this.db.prepare("INSERT OR IGNORE INTO meta VALUES ('generation', ?)").run(randomUUID());
        this.generation = this.db.prepare("SELECT value FROM meta WHERE key='generation'").get().value;
        requireValue(
          this.db.prepare("SELECT value FROM meta WHERE key='version'").get().value === "2",
          "unsupported_host_state_version",
        );
        // replayHistory is a first-start policy. An agent added to an existing roster always bootstraps
        // without execution: it fast-forwards past every event already on the server, including ones
        // peers have not consumed yet, so nothing that predates the addition is ever queued for it.
        // The saved cursor boundary only shortens that first page.
        const boundary = this.db.prepare("SELECT COALESCE(MAX(cursor),0) AS cursor FROM agents").get().cursor;
        const initialized = !saved && config.replayHistory ? 1 : 0;
        for (const agent of config.agents) {
          this.db
            .prepare(
              "INSERT OR IGNORE INTO agents(id,username,cursor,initialized,channels) VALUES (?,?,?,?,?)",
            )
            .run(agent.id, agent.username, boundary, initialized, JSON.stringify(agent.channels));
        }
        // A crashed supervisor's watchdog still needs its disconnect escalation. Never overlap the
        // remaining lease, and reserve the recovery grace from this startup even when the lease has
        // already expired (a long no-deadline turn) or the deadline configuration changed.
        this.db
          .prepare(
            "UPDATE jobs SET status='queued', available=MAX(?,lease_until), error='host_restarted' WHERE status='running'",
          )
          .run(now + RECOVERY_GRACE_MS);
        this.db.exec("UPDATE outbox SET status='queued' WHERE status='sending'");
      });
      chmodSync(join(config.stateDir, "state.sqlite"), 0o600);
      chmodSync(join(config.stateDir, "owner.sqlite"), 0o600);
    } catch (error) {
      this.close();
      throw error;
    }
  }
  key(...parts) {
    return digest(this.binding.origin, this.binding.tenant, this.config.hostId, this.generation, ...parts);
  }
  tx(fn) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  close() {
    this.db?.close();
    this.db = undefined;
    this.lock?.close();
    this.lock = undefined;
  }
  agent(id) {
    const row = this.db.prepare("SELECT * FROM agents WHERE id=?").get(id);
    return {
      ...row,
      state: JSON.parse(row.state),
      channels: JSON.parse(row.channels),
      waiting: row.waiting ? JSON.parse(row.waiting) : null,
    };
  }
  roster() {
    return this.config.agents.map((agent) => ({
      id: agent.id,
      username: agent.username,
      role: agent.role,
      description: agent.description,
      channels: this.agent(agent.id).channels,
    }));
  }
  bootstrap(agent, cursor, done) {
    this.db
      .prepare("UPDATE agents SET cursor=?, initialized=? WHERE id=? AND initialized=0")
      .run(cursor, done ? 1 : 0, agent);
  }
  ingest(agent, event) {
    return this.tx(() => {
      const current = this.agent(agent);
      if (event.id <= current.cursor) return true;
      if (event.type === "message.created" && current.channels.includes(event.channel)) {
        const pending = this.db
          .prepare("SELECT COUNT(*) AS n FROM jobs WHERE agent=? AND status IN ('queued','running')")
          .get(agent).n;
        if (pending >= this.config.maxPending) return false;
        this.db
          .prepare("INSERT OR IGNORE INTO jobs(agent,event_id,channel,event) VALUES (?,?,?,?)")
          .run(agent, event.id, event.channel, JSON.stringify(event));
      }
      this.db.prepare("UPDATE agents SET cursor=? WHERE id=?").run(event.id, agent);
      return true;
    });
  }
  claim(agent, timeout, now = Date.now()) {
    return this.tx(() => {
      if (this.db.prepare("SELECT 1 FROM jobs WHERE agent=? AND status='running'").get(agent)) return null;
      const job = this.db
        .prepare("SELECT * FROM jobs WHERE agent=? AND status='queued' AND available<=? ORDER BY id LIMIT 1")
        .get(agent, now);
      if (!job) return null;
      this.db
        .prepare("UPDATE jobs SET status='running', attempts=attempts+1, lease_until=? WHERE id=?")
        .run(now + timeout + 5000, job.id);
      return {
        ...job,
        attempts: job.attempts + 1,
        event: job.event ? JSON.parse(job.event) : null,
        trigger: job.trigger ? JSON.parse(job.trigger) : null,
      };
    });
  }
  startTurn(job, root, message) {
    return this.tx(() => {
      const { maxTurnsPerConversation: hard, softTurnsPerConversation: soft } = this.config;
      const budget = this.db.prepare("SELECT * FROM budgets WHERE root=?").get(root);
      if ((budget?.turns ?? 0) >= hard) {
        this.deadLetter(job, "conversation_budget_exhausted");
        return false;
      }
      // The hard budget counts every activation, retries included. The soft budget counts logical
      // agent-triggered turns since the newest human message: a job is counted once, on its first
      // start, and jobs triggered by a human message (every broadcast recipient, replays included) never count.
      this.db
        .prepare(
          "INSERT INTO budgets(root,turns,next_warning) VALUES (?,1,?) ON CONFLICT(root) DO UPDATE SET turns=turns+1",
        )
        .run(root, soft);
      const first =
        this.db.prepare("UPDATE jobs SET root=?, counted=1 WHERE id=? AND counted=0").run(root, job.id)
          .changes === 1;
      job.root = root;
      // Canonical message ids, not event cursor ids: a replayed or fanned-out human message resets once.
      const human =
        message && !message.personaId && !this.config.agents.some((a) => a.username === message.username);
      if (soft > 0 && human && message.id > (budget?.last_human_event_id ?? 0))
        this.db
          .prepare("UPDATE budgets SET agent_turns=0, last_human_event_id=?, next_warning=? WHERE root=?")
          .run(message.id, soft, root);
      // A budget warning consumes the hard allowance but never counts toward the next warning.
      if (soft > 0 && first && !human && job.trigger?.type !== "coordination.budget") {
        const { agent_turns, next_warning } = this.db
          .prepare(
            "UPDATE budgets SET agent_turns=agent_turns+1 WHERE root=? RETURNING agent_turns, next_warning",
          )
          .get(root);
        if (agent_turns >= next_warning) {
          this.db.prepare("UPDATE budgets SET next_warning=next_warning+? WHERE root=?").run(soft, root);
          this.enqueueSignal(job.agent, job.channel, root, {
            type: "coordination.budget",
            agentTurns: agent_turns,
            softBudget: soft,
            hardLimit: hard,
            instruction:
              "Agents have taken many turns in this conversation without new human input. Reassess before continuing: report what changed, what remains and whether peer input is actually needed. Continue only concrete remaining work; otherwise finish, report a blocker, or return no actions.",
          });
        }
      }
      const wait = this.agent(job.agent).waiting;
      const resumed = Boolean(
        wait &&
          message &&
          ((wait.onMessage === true && message.channel === wait.channel) ||
            (wait.for.includes(message.username) && message.correlationId === wait.conversationId)),
      );
      if (resumed) this.db.prepare("UPDATE agents SET waiting=NULL WHERE id=?").run(job.agent);
      return { resumed };
    });
  }
  pause(job) {
    this.db.prepare("UPDATE jobs SET status='paused', attempts=MAX(0,attempts-1) WHERE id=?").run(job.id);
  }
  resumeChannel(agent, channel) {
    this.db
      .prepare("UPDATE jobs SET status='queued', available=0 WHERE agent=? AND channel=? AND status='paused'")
      .run(agent, channel);
  }
  /** The server fence for this agent's receipts on a channel (ADR 0053); 0 when never claimed. */
  serverGeneration(agent, channel) {
    return (
      this.db.prepare("SELECT generation FROM server_commits WHERE agent=? AND channel=?").get(agent, channel)
        ?.generation ?? 0
    );
  }
  saveServerGeneration(agent, channel, generation) {
    this.db
      .prepare(
        "INSERT INTO server_commits(agent,channel,generation) VALUES (?,?,?) ON CONFLICT(agent,channel) DO UPDATE SET generation=excluded.generation",
      )
      .run(agent, channel, generation);
  }
  /**
   * The highest message id on `channel` that this agent is finished with, such that every message
   * job before it is finished too (ADR 0053). Finished: done, ignored, or failed for good (the host
   * posts that failure to the board and never retries it). Queued, running and paused jobs hold the
   * watermark below them. Messages from before this agent bootstrapped are covered, as any
   * watermark covers what it skipped.
   */
  processedThrough(agent, channel) {
    const id = "CAST(json_extract(event,'$.resourceId') AS INTEGER)";
    const open = this.db
      .prepare(
        `SELECT MIN(${id}) AS id FROM jobs WHERE agent=? AND channel=? AND event IS NOT NULL AND status IN ('queued','running','paused')`,
      )
      .get(agent, channel).id;
    return (
      this.db
        .prepare(
          `SELECT MAX(${id}) AS id FROM jobs WHERE agent=? AND channel=? AND event IS NOT NULL AND status IN ('done','ignored','failed')${open === null ? "" : ` AND ${id} < ?`}`,
        )
        .get(...(open === null ? [agent, channel] : [agent, channel, open])).id ?? 0
    );
  }
  ignore(job) {
    this.db.prepare("UPDATE jobs SET status='ignored', error=NULL WHERE id=?").run(job.id);
  }
  enqueueSignal(agent, channel, root, trigger) {
    this.db
      .prepare("INSERT INTO jobs(agent,channel,root,trigger) VALUES (?,?,?,?)")
      .run(agent, channel, root, JSON.stringify(trigger));
  }
  cycle(username, peers) {
    const graph = new Map(
      this.config.agents.map((agent) => [agent.username, this.agent(agent.id).waiting?.for ?? []]),
    );
    const seen = new Set();
    const visit = (peer, path) => {
      if (peer === username) return [...path, peer];
      if (seen.has(peer)) return null;
      seen.add(peer);
      for (const next of graph.get(peer) ?? []) {
        const result = visit(next, [...path, peer]);
        if (result) return result;
      }
      return null;
    };
    for (const peer of peers) {
      const path = visit(peer, [username]);
      if (path) return path;
    }
    return null;
  }
  finish(job, result, message, now = Date.now()) {
    return this.tx(() => {
      const agent = this.config.agents.find((a) => a.id === job.agent);
      this.db
        .prepare("UPDATE agents SET state=?, channels=? WHERE id=?")
        .run(
          JSON.stringify(Object.hasOwn(result, "state") ? result.state : this.agent(job.agent).state),
          JSON.stringify(result.memberships),
          job.agent,
        );
      for (const [index, action] of result.actions.entries()) {
        if (action.type !== "send") continue;
        const body = {
          username: agent.username,
          ...(agent.personaId ? { personaId: agent.personaId } : {}),
          text: action.text,
          contentType: action.contentType ?? "text/plain",
          correlationId: job.root,
        };
        if (action.to !== undefined) body.to = action.to;
        if (action.replyTo !== undefined) body.replyTo = action.replyTo;
        else if (message && message.channel === action.channel) body.replyTo = message.id;
        this.queueOutput(`msn-host-${this.key(job.agent, job.id, index)}`, job.agent, action.channel, body);
      }
      if (Object.hasOwn(result, "wait")) {
        this.db.prepare("UPDATE agents SET waiting=NULL WHERE id=?").run(job.agent);
        if (result.wait) {
          const path = this.cycle(agent.username, result.wait.for);
          if (path)
            this.enqueueSignal(job.agent, job.channel, job.root, {
              type: "coordination.cycle",
              path,
              instruction:
                "Do not wait again on this cycle. Perform independent work, send missing information, or request a human decision.",
            });
          else
            this.db.prepare("UPDATE agents SET waiting=? WHERE id=?").run(
              JSON.stringify({
                ...result.wait,
                onMessage: result.wait.onMessage ?? Boolean(agent.personaId),
                deadline: now + result.wait.timeoutMs,
                conversationId: job.root,
                channel: job.channel,
              }),
              job.agent,
            );
        }
      }
      if (result.progress !== undefined) {
        const waiting = this.agent(job.agent).waiting;
        if (["blocked", "complete"].includes(result.progress.status) && waiting?.conversationId === job.root)
          this.db.prepare("UPDATE agents SET waiting=NULL WHERE id=?").run(job.agent);
        requireValue(
          !(result.progress.status === "working" && this.agent(job.agent).waiting),
          "working_cannot_wait",
        );
        // One explicit continuation per conversation. A new decision cancels stale queued intent,
        // never a currently running turn or a different request. Omission does not start an idle loop.
        this.db
          .prepare(
            "UPDATE jobs SET status='ignored' WHERE agent=? AND channel=? AND root=? AND status='queued' AND json_extract(trigger,'$.type')='goal.continue'",
          )
          .run(job.agent, job.channel, job.root);
        if (
          result.progress.status === "working" &&
          !this.agent(job.agent).waiting &&
          result.memberships.includes(job.channel)
        ) {
          this.enqueueSignal(job.agent, job.channel, job.root, {
            type: "goal.continue",
            reason: result.progress.reason,
          });
          this.db
            .prepare("UPDATE jobs SET available=? WHERE id=last_insert_rowid()")
            .run(now + (result.progress.delayMs ?? 1000));
        }
      }
      this.db.prepare("UPDATE jobs SET status='done', error=NULL WHERE id=?").run(job.id);
    });
  }
  queueOutput(key, agent, channel, body) {
    this.db
      .prepare("INSERT OR IGNORE INTO outbox(key,agent,channel,body) VALUES (?,?,?,?)")
      .run(key, agent, channel, JSON.stringify(body));
  }
  deadLetter(job, code) {
    this.db.prepare("UPDATE jobs SET status='failed', error=? WHERE id=?").run(code, job.id);
    const agent = this.config.agents.find((a) => a.id === job.agent);
    this.queueOutput(`msn-host-${this.key(job.agent, job.id, "failure")}`, job.agent, job.channel, {
      username: agent.username,
      ...(agent.personaId ? { personaId: agent.personaId } : {}),
      text: JSON.stringify({
        schema: "msn.host.status.v1",
        hostId: this.config.hostId,
        agent: agent.username,
        jobId: job.id,
        status: "failed",
        reason: code,
      }),
      contentType: "application/json",
    });
  }
  fail(job, code, maxAttempts, now = Date.now()) {
    return this.tx(() => {
      if (job.attempts >= maxAttempts) this.deadLetter(job, code);
      else
        this.db
          .prepare("UPDATE jobs SET status='queued', error=?, available=? WHERE id=?")
          .run(code, now + Math.min(250 * 2 ** (job.attempts - 1), 15000), job.id);
    });
  }
  requeue(job) {
    this.db
      .prepare(
        "UPDATE jobs SET status='queued', attempts=MAX(0,attempts-1), available=0, error='host_stopped' WHERE id=?",
      )
      .run(job.id);
  }
  claimOutput(agent, now = Date.now()) {
    return this.tx(() => {
      const row = this.db
        .prepare("SELECT * FROM outbox WHERE agent=? AND status='queued' ORDER BY id LIMIT 1")
        .get(agent);
      if (!row || row.available > now) return null;
      this.db.prepare("UPDATE outbox SET status='sending', attempts=attempts+1 WHERE id=?").run(row.id);
      return { ...row, attempts: row.attempts + 1, body: JSON.parse(row.body) };
    });
  }
  outputResult(output, code, retryable, now = Date.now()) {
    return this.tx(() => {
      const status = !code ? "sent" : retryable && output.attempts < 10 ? "queued" : "failed";
      const changed = this.db
        .prepare("UPDATE outbox SET status=?, error=?, available=? WHERE id=? AND status='sending'")
        .run(
          status,
          code ?? null,
          now + Math.min(500 * 2 ** (output.attempts - 1), 30000),
          output.id,
        ).changes;
      // Terminal delivery failure is new input, not a reason to regenerate an already-committed turn.
      // Diagnostics have no conversation id, so failed diagnostic sends cannot recurse.
      if (changed && status === "failed" && output.body.correlationId) {
        this.enqueueSignal(output.agent, output.channel, output.body.correlationId, {
          type: "coordination.delivery_failed",
          outputId: output.id,
          to: output.body.to ?? null,
          reason: code,
          instruction:
            "This committed send could not be delivered. Choose an alternative action or report the blocker; do not assume the recipient received it or poll for delivery.",
        });
      }
      return status;
    });
  }
  expire(now = Date.now()) {
    return this.tx(() => {
      let count = 0;
      for (const agent of this.config.agents) {
        const wait = this.agent(agent.id).waiting;
        if (!wait || wait.deadline > now) continue;
        this.db.prepare("UPDATE agents SET waiting=NULL WHERE id=?").run(agent.id);
        this.enqueueSignal(agent.id, wait.channel, wait.conversationId, {
          type: "coordination.timeout",
          for: wait.for,
          reason: wait.reason,
          instruction:
            "The peer deadline expired. Continue independently, choose another peer, or report the blocker. Do not poll.",
        });
        count++;
      }
      return count;
    });
  }
  nextDeadline(now = Date.now()) {
    const times = [];
    for (const agent of this.config.agents) {
      const wait = this.agent(agent.id).waiting;
      if (wait) times.push(wait.deadline);
    }
    for (const table of ["jobs", "outbox"]) {
      const value = this.db
        .prepare(`SELECT MIN(available) AS t FROM ${table} WHERE status='queued' AND available>?`)
        .get(now).t;
      if (value !== null) times.push(value);
    }
    return times.length ? Math.min(...times) : null;
  }
  status() {
    return {
      hostId: this.config.hostId,
      agents: this.config.agents.map((a) => {
        const row = this.agent(a.id);
        return {
          id: a.id,
          username: a.username,
          cursor: row.cursor,
          initialized: Boolean(row.initialized),
          channels: row.channels,
          waiting: row.waiting
            ? { for: row.waiting.for, deadline: row.waiting.deadline, channel: row.waiting.channel }
            : null,
        };
      }),
      jobs: this.db.prepare("SELECT status, COUNT(*) AS count FROM jobs GROUP BY status").all(),
      outbox: this.db.prepare("SELECT status, COUNT(*) AS count FROM outbox GROUP BY status").all(),
      failures: this.db
        .prepare("SELECT id, agent, channel, error FROM jobs WHERE status='failed' ORDER BY id DESC LIMIT 20")
        .all(),
    };
  }
}
