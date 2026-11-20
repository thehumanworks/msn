import { setTimeout as delay } from "node:timers/promises";
import { executeTurn } from "./process.mjs";
import { diagnostic, HostError, turnLease, validateMessage, validateResult } from "./protocol.mjs";
import { Fenced, ServerCommits, serverCommitsEnabled, unavailableHint } from "./server-commits.mjs";
import { request, validateHostPage } from "./transport.mjs";

/** Edge-triggered notification with an epoch to close check/register lost-wakeup races. */
export class Pulse {
  epoch = 0;
  listeners = new Set();
  notify() {
    this.epoch++;
    for (const listener of [...this.listeners]) listener();
  }
  wait(epoch, deadline, signal) {
    if (epoch !== this.epoch || signal.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      let timer;
      const done = () => {
        clearTimeout(timer);
        this.listeners.delete(done);
        signal.removeEventListener("abort", done);
        resolve();
      };
      this.listeners.add(done);
      signal.addEventListener("abort", done, { once: true });
      if (deadline !== null) timer = setTimeout(done, Math.max(0, deadline - Date.now()));
      if (epoch !== this.epoch || signal.aborted) done();
    });
  }
}
function codeFor(error) {
  return error instanceof HostError
    ? error.code
    : error.code === "board_archived" // ADR 0046: say why, not just http_409.
      ? "board_archived"
      : error.status
        ? `http_${error.status}`
        : "transport_or_protocol_failure";
}
export class HostRuntime {
  constructor(
    config,
    store,
    connections,
    { log = (entry) => process.stdout.write(`${JSON.stringify(entry)}\n`), env = process.env } = {},
  ) {
    this.config = config;
    this.store = store;
    this.connections = connections;
    this.log = log;
    this.env = env;
    this.pulse = new Pulse();
    this.active = new Map();
    this.outputs = new Map();
    this.disabled = new Set();
    this.controls = new Map(config.agents.map((a) => [a.id, new AbortController()]));
    this.rotation = 0;
    this.fatal = null;
    this.commits = new Map();
  }
  /** Per agent and channel: the server commit reporter, or null when receipts are off (ADR 0053). */
  commitsFor(agent, channel) {
    const key = JSON.stringify([agent.id, channel]);
    if (!this.commits.has(key)) {
      const connection = this.connections.get(agent.id);
      this.commits.set(
        key,
        serverCommitsEnabled(agent.serverCommits, this.env)
          ? new ServerCommits({
              request,
              connection,
              channel,
              reader: agent.username,
              generation: this.store.serverGeneration(agent.id, channel),
              save: (generation) => this.store.saveServerGeneration(agent.id, channel, generation),
              role: "msn run",
            })
          : null,
      );
    }
    return this.commits.get(key);
  }
  /**
   * Sends the channel's finished-message watermark to the server, so receipts name this agent. Best
   * effort: a failure never stops the agent, except a takeover, which must (ADR 0034).
   */
  async reportProcessed(agent, channel, signal) {
    const commits = this.commitsFor(agent, channel);
    if (!commits || signal.aborted) return;
    try {
      const result = await commits.commit(this.store.processedThrough(agent.id, channel), signal);
      if (result.status === "unavailable" && !commits.reported) {
        commits.reported = true;
        this.emit("receipts.unavailable", {
          agent: agent.id,
          channel,
          reason: result.reason,
          hint: unavailableHint(result.reason),
        });
      }
    } catch (error) {
      if (!(error instanceof Fenced)) throw error;
      this.disable(agent, new HostError("processing_fenced"));
    }
  }
  emit(type, fields = {}) {
    this.log({ type, hostId: this.config.hostId, ...fields });
  }
  disable(agent, error) {
    this.disabled.add(agent.id);
    this.controls.get(agent.id).abort();
    this.emit("agent.stopped", { agent: agent.id, reason: codeFor(error) });
    this.pulse.notify();
  }
  async listen(agent, signal) {
    const connection = this.connections.get(agent.id);
    let retry = 500;
    while (!signal.aborted) {
      try {
        const state = this.store.agent(agent.id);
        const started = Date.now();
        const query = new URLSearchParams({
          after: String(state.cursor),
          limit: "100",
          wait: state.initialized ? "25" : "0",
        });
        // A board persona tags its long poll so people can see it is listening (ADR 0028).
        if (state.initialized && connection.sharedChannel && connection.personaId)
          query.set("listener", connection.personaId);
        const page = await request(connection, `/api/tenants/${connection.tenant}/events?${query}`, signal);
        const events = validateHostPage(page, connection, state.cursor);
        if (!state.initialized) {
          this.store.bootstrap(agent.id, page.nextCursor, !page.hasMore);
          if (!page.hasMore) this.emit("agent.ready", { agent: agent.id, cursor: page.nextCursor });
        } else {
          for (const event of events) {
            for (;;) {
              if (signal.aborted) return;
              const epoch = this.pulse.epoch;
              if (this.store.ingest(agent.id, event)) break;
              // Backpressure preserves this event and cursor; completion wakes us without a scan timer.
              await this.pulse.wait(epoch, null, signal);
            }
            this.pulse.notify();
          }
        }
        retry = 500;
        // A misbehaving proxy returning empty long polls immediately must not cause a hot loop.
        if (state.initialized && !events.length && Date.now() - started < 250)
          await delay(250 - (Date.now() - started), undefined, { signal });
      } catch (error) {
        if (signal.aborted) return;
        if (!error.retryable) {
          this.disable(agent, error);
          return;
        }
        this.emit("stream.reconnecting", { agent: agent.id, reason: codeFor(error) });
        await delay(retry, undefined, { signal }).catch(() => {});
        retry = Math.min(retry * 2, 15000);
      }
    }
  }
  async dispatch(agent, job, signal) {
    await this.dispatchTurn(agent, job, signal);
    if (job.event) await this.reportProcessed(agent, job.channel, signal);
  }
  async dispatchTurn(agent, job, signal) {
    const connection = this.connections.get(agent.id);
    try {
      let message = null;
      if (job.event) {
        const result = await request(
          connection,
          `/api/tenants/${connection.tenant}/channels/${job.channel}/messages/${job.event.resourceId}`,
          signal,
        );
        message = validateMessage(result?.message, job.event, connection);
        const current = this.store.agent(agent.id);
        if (
          !current.channels.includes(job.channel) ||
          (agent.personaId ? message.personaId === agent.personaId : message.username === agent.username) ||
          (message.to !== undefined && message.to !== agent.username) ||
          diagnostic(message)
        ) {
          this.store.ignore(job);
          return;
        }
      }
      let board = null;
      if (connection.sharedChannel) {
        const result = await request(
          connection,
          `/api/tenants/${connection.tenant}/channels/${job.channel}/board`,
          signal,
        );
        board = result?.board;
        if (
          !board ||
          board.channel !== job.channel ||
          typeof board.goal !== "string" ||
          !["active", "paused", "blocked", "complete"].includes(board.status)
        )
          throw new HostError("invalid_board_state");
        if (["paused", "blocked"].includes(board.status)) {
          this.store.pause(job);
          return;
        }
        if (board.status === "complete") {
          this.store.ignore(job);
          return;
        }
        this.store.resumeChannel(agent.id, job.channel);
      }
      if (signal.aborted) {
        this.store.requeue(job);
        return;
      }
      if (job.attempts > agent.attempts) {
        this.store.fail(job, "attempts_exhausted_after_restart", agent.attempts);
        return;
      }
      const root =
        job.root ??
        message?.correlationId ??
        `msn-conversation-${this.store.key(job.channel, message?.id).slice(0, 40)}`;
      const activation = this.store.startTurn(job, root, message);
      if (!activation) {
        this.emit("turn.failed", { agent: agent.id, jobId: job.id, reason: "conversation_budget_exhausted" });
        return;
      }
      const state = this.store.agent(agent.id);
      const envelope = {
        schema: "msn.turn.v1",
        hostId: this.config.hostId,
        channel: job.channel,
        identity: {
          origin: connection.origin,
          tenant: connection.tenant,
          username: agent.username,
          role: agent.role,
          description: agent.description,
          ...(agent.personaId ? { personaId: agent.personaId, sharedChannel: true } : {}),
        },
        permissionMode: "yolo",
        peers: this.store.roster(),
        channels: state.channels,
        allowedChannels: agent.allowedChannels,
        conversationId: root,
        idempotencyKey: `msn-turn-${this.store.key(agent.id, job.id)}`,
        trigger: job.trigger ?? { type: "message", resumed: activation.resumed, eventId: job.event.id },
        message,
        board,
        state: state.state,
        waiting: state.waiting,
        previousFailure: job.error,
        instructions:
          "Coordinate directly with peers. Return sends and a bounded wait to yield; never poll or synchronously wait for a peer. A coordinator is optional, not an approval gate. Exit success is not task completion. Persist only bounded useful continuation state; use the idempotency key for external effects.",
      };
      this.store.db
        .prepare("UPDATE jobs SET lease_until=? WHERE id=?")
        .run(turnLease(agent.timeoutMs), job.id);
      this.emit("turn.started", { agent: agent.id, jobId: job.id, attempt: job.attempts });
      const raw = await executeTurn(agent, connection, envelope, this.config, signal, this.env);
      if (signal.aborted) {
        this.store.requeue(job);
        return;
      }
      const output = validateResult(raw, agent, state.channels);
      this.store.finish(job, output, message);
      this.emit("turn.completed", {
        agent: agent.id,
        jobId: job.id,
        actions: output.actions.length,
        suspended: Boolean(this.store.agent(agent.id).waiting),
      });
    } catch (error) {
      if (signal.aborted) {
        this.store.requeue(job);
        return;
      }
      if (error.status === 404 || error.status === 410) {
        this.store.ignore(job);
        return;
      }
      this.store.fail(job, codeFor(error), agent.attempts);
      this.emit("turn.failed", {
        agent: agent.id,
        jobId: job.id,
        reason: codeFor(error),
        attempt: job.attempts,
      });
      if (error.status === 401 || error.status === 403) this.disable(agent, error);
    }
  }
  async send(agent, output, signal) {
    const connection = this.connections.get(agent.id);
    try {
      const result = await request(
        connection,
        `/api/tenants/${connection.tenant}/channels/${output.channel}/messages`,
        signal,
        { method: "POST", body: output.body, key: output.key },
      );
      if (
        !result?.message ||
        result.message.username !== agent.username ||
        (agent.personaId && result.message.personaId !== agent.personaId) ||
        result.message.tenant !== connection.tenant ||
        result.message.channel !== output.channel ||
        result.message.text !== output.body.text
      )
        throw new HostError("invalid_send_receipt");
      this.store.outputResult(output, null, false);
      this.emit("output.sent", { agent: agent.id, outputId: output.id });
    } catch (error) {
      // Aborted/uncertain writes retain their stable key and body for restart.
      if (signal.aborted) {
        this.store.db.prepare("UPDATE outbox SET status='queued' WHERE id=?").run(output.id);
        return;
      }
      const status = this.store.outputResult(output, codeFor(error), Boolean(error.retryable));
      this.emit(`output.${status}`, { agent: agent.id, outputId: output.id, reason: codeFor(error) });
      if (error.status === 401 || error.status === 403) this.disable(agent, error);
    }
  }
  track(map, id, promise) {
    const tracked = promise
      .catch((error) => {
        this.fatal = error;
      })
      .finally(() => {
        map.delete(id);
        this.pulse.notify();
      });
    map.set(id, tracked);
  }
  async run(signal) {
    const controller = new AbortController();
    const stop = AbortSignal.any([signal, controller.signal]);
    const signals = new Map(
      this.config.agents.map((agent) => [
        agent.id,
        AbortSignal.any([stop, this.controls.get(agent.id).signal]),
      ]),
    );
    const listeners = this.config.agents.map((agent) =>
      this.listen(agent, signals.get(agent.id)).catch((error) => {
        this.fatal = error;
        this.pulse.notify();
      }),
    );
    this.emit("host.started", {
      agents: this.config.agents.length,
      maxConcurrent: this.config.maxConcurrent,
    });
    try {
      while (!stop.aborted) {
        const epoch = this.pulse.epoch;
        if (this.fatal) throw this.fatal;
        if (this.disabled.size === this.config.agents.length)
          throw new HostError("all_agent_streams_stopped");
        // One clock reading per pass: an item not yet available to claim must still be in the
        // deadline set. Separate readings let a row become due between the two and sleep forever.
        const now = Date.now();
        this.store.expire(now);
        for (const agent of this.config.agents) {
          if (this.disabled.has(agent.id) || this.outputs.has(agent.id)) continue;
          const output = this.store.claimOutput(agent.id, now);
          if (output) this.track(this.outputs, agent.id, this.send(agent, output, signals.get(agent.id)));
        }
        for (
          let offset = 0;
          offset < this.config.agents.length && this.active.size < this.config.maxConcurrent;
          offset++
        ) {
          const index = (this.rotation + offset) % this.config.agents.length;
          const agent = this.config.agents[index];
          if (this.disabled.has(agent.id) || this.active.has(agent.id)) continue;
          const job = this.store.claim(agent.id, 40000, now);
          if (!job) continue;
          this.track(this.active, agent.id, this.dispatch(agent, job, signals.get(agent.id)));
          this.rotation = (index + 1) % this.config.agents.length;
          offset = -1; // start another fair pass from the next peer
        }
        await this.pulse.wait(epoch, this.store.nextDeadline(now), stop);
      }
    } finally {
      controller.abort();
      this.pulse.notify();
      await Promise.allSettled([...listeners, ...this.active.values(), ...this.outputs.values()]);
      this.emit("host.stopped");
    }
  }
}
