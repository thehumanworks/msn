// The webhook's life: local receiver, public tunnel, the webhook on the board, and delivery of
// each addressed message to whoever is attached. It knows nothing about Pi; index.ts attaches the
// session. That split lets the webhook stay up while Pi replaces the session (/new, /reload).
import { randomBytes } from "node:crypto";
import { type Config, ConfigError } from "./config.ts";
import { formatHint, formatMessage } from "./format.ts";
import {
  type BoardMessage,
  cliError,
  EXIT_AUTH,
  type RunCli,
  removeWebhook,
  setWebhook,
  showMessage,
  showWebhook,
  testWebhook,
} from "./msn.ts";
import { type Notice, type Receiver, startReceiver } from "./receiver.ts";
import { type Spawn, startTunnel, type Tunnel, TunnelError, waitUntilPublic } from "./tunnel.ts";

export type Delivery = { text: string; notice: Notice; message: BoardMessage | null };
export type Deliver = (delivery: Delivery) => void;

/** Messages kept while no session is attached. MSN keeps at most 50 notices waiting per webhook. */
export const MAX_QUEUED = 50;

export type Registration =
  | { state: "set" }
  /** The webhook was not set here; `reason` says why and `command` is what the owner runs. */
  | { state: "manual"; reason: string; command: string };

export type Status = {
  board: string;
  persona: string;
  publicUrl: string;
  localPort: number;
  tunnel: Config["tunnel"];
  tunnelAlive: boolean;
  reachable: boolean;
  registration: Registration;
  deliverAs: Config["deliverAs"];
  startedAt: string;
  accepted: number;
  duplicates: number;
  rejected: number;
  delivered: number;
  queued: number;
  lastNoticeAt: string | null;
  lastPingAt: string | null;
  /** The board's own record of the last delivery, when it can be read. */
  board_lastDelivery?: unknown;
};

export type Dependencies = {
  run: RunCli;
  spawn?: Spawn;
  fetcher?: typeof fetch;
  /** How long to wait for the public address to answer before setting the webhook. */
  reachableTimeoutMs?: number;
};

export class Webhook {
  private receiver: Receiver | null = null;
  private tunnel: Tunnel | null = null;
  private active: {
    config: Config;
    board: string;
    persona: string;
    publicUrl: string;
    bearer: string;
    registration: Registration;
    reachable: boolean;
    startedAt: string;
  } | null = null;
  private deliver: Deliver | null = null;
  private queue: Delivery[] = [];
  private delivered = 0;
  private starting = false;
  /** Set as soon as a start begins, so a notice that arrives before `start` returns can be read. */
  private context: { config: Config; board: string } | null = null;
  private readonly deps: Dependencies;

  constructor(deps: Dependencies) {
    this.deps = deps;
  }

  get running(): boolean {
    return this.active !== null;
  }

  /** Attaches the session that receives messages, and hands over any that waited. */
  attach(deliver: Deliver): void {
    this.deliver = deliver;
    for (const waiting of this.queue.splice(0)) this.send(waiting);
  }

  detach(): void {
    this.deliver = null;
  }

  async start(config: Config, board: string | undefined, persona: string | undefined): Promise<Status> {
    if (this.active || this.starting)
      throw new ConfigError("The webhook is already running. Stop it first with /msn-webhook-stop.");
    const theBoard = board ?? config.board;
    const thePersona = persona ?? config.persona;
    if (!theBoard || !thePersona)
      throw new ConfigError(
        "Give the board and the persona id: /msn-webhook-start BOARD PERSONA (or set board and persona in pi-msn.json).",
      );
    this.starting = true;
    this.context = { config, board: theBoard };
    try {
      const bearer = config.bearer ?? randomBytes(32).toString("base64url");
      this.receiver = await startReceiver({
        bearer,
        path: config.path,
        port: config.port,
        onNotice: (notice) => void this.onNotice(notice),
      });
      this.tunnel = await startTunnel(config, this.receiver.port, this.deps.spawn);
      const publicUrl = `${this.tunnel.url}${config.path}`;
      const reachable = await waitUntilPublic(
        this.tunnel.url,
        this.deps.reachableTimeoutMs ?? 30_000,
        this.deps.fetcher,
        this.tunnel.alive,
      );
      if (!this.tunnel.alive())
        throw new TunnelError(
          `The tunnel program stopped right after it gave the address ${this.tunnel.url}, so nothing can reach this computer through it.${this.tunnel.lastOutput()}`,
        );
      const registration = await this.register(config, theBoard, thePersona, publicUrl, bearer);
      this.active = {
        config,
        board: theBoard,
        persona: thePersona,
        publicUrl,
        bearer,
        registration,
        reachable,
        startedAt: new Date().toISOString(),
      };
      return this.status();
    } catch (error) {
      await this.teardown();
      throw error;
    } finally {
      this.starting = false;
    }
  }

  private async register(
    config: Config,
    board: string,
    persona: string,
    publicUrl: string,
    bearer: string,
  ): Promise<Registration> {
    const command = `msn persona webhook set ${board} ${persona} ${publicUrl} --bearer-env VAR`;
    if (!config.register)
      return { state: "manual", reason: "register is off, so the owner sets the webhook by hand.", command };
    const result = await setWebhook(this.deps.run, config, board, persona, publicUrl, bearer);
    if (result.code === 0) {
      // A ping shows in the status that notices get through. It is not delivered to the model.
      await testWebhook(this.deps.run, config, board, persona).catch(() => undefined);
      return { state: "set" };
    }
    const reason =
      result.code === EXIT_AUTH
        ? `Only the workspace owner can set a webhook, and this profile is not the owner's (${cliError(result)}). Set ownerProfile to a saved owner profile, or ask the owner to run the command below.`
        : `The board refused the webhook: ${cliError(result)}`;
    // A random key nobody can learn would make the manual path impossible.
    if (!config.bearer)
      throw new ConfigError(
        `${reason}\nFor the owner to set it by hand, give this receiver a key of your own in PI_MSN_WEBHOOK_BEARER and start again.`,
      );
    return { state: "manual", reason, command };
  }

  private async onNotice(notice: Notice): Promise<void> {
    const context = this.context;
    if (notice.type === "ping" || !context) return;
    const board = notice.channel ?? context.board;
    let message: BoardMessage | null = null;
    if (typeof notice.messageId === "number") {
      try {
        message = await showMessage(this.deps.run, context.config, board, notice.messageId);
      } catch {
        message = null;
      }
    }
    this.send({ text: message ? formatMessage(message) : formatHint(notice), notice, message });
  }

  private send(delivery: Delivery): void {
    if (!this.deliver) {
      this.queue.push(delivery);
      if (this.queue.length > MAX_QUEUED) this.queue.shift();
      return;
    }
    try {
      this.deliver(delivery);
      this.delivered += 1;
    } catch {
      // The session went away between the check and the call: keep the message for the next one.
      this.deliver = null;
      this.queue.push(delivery);
    }
  }

  status(): Status {
    const active = this.active;
    if (!active || !this.receiver || !this.tunnel) throw new ConfigError("The webhook is not running.");
    return {
      board: active.board,
      persona: active.persona,
      publicUrl: active.publicUrl,
      localPort: this.receiver.port,
      tunnel: this.tunnel.provider,
      tunnelAlive: this.tunnel.alive(),
      reachable: active.reachable,
      registration: active.registration,
      deliverAs: active.config.deliverAs,
      startedAt: active.startedAt,
      accepted: this.receiver.stats.accepted,
      duplicates: this.receiver.stats.duplicates,
      rejected: this.receiver.stats.rejected,
      delivered: this.delivered,
      queued: this.queue.length,
      lastNoticeAt: this.receiver.stats.lastNoticeAt,
      lastPingAt: this.receiver.stats.lastPingAt,
    };
  }

  /** The status plus what the board itself recorded about its last delivery. */
  async fullStatus(): Promise<Status> {
    const status = this.status();
    const active = this.active;
    if (active?.registration.state === "set") {
      try {
        const shown = await showWebhook(this.deps.run, active.config, active.board, active.persona);
        if (shown.code === 0) {
          const parsed = JSON.parse(shown.stdout) as {
            webhook?: { lastDelivery?: unknown };
            lastDelivery?: unknown;
          };
          status.board_lastDelivery = parsed.webhook?.lastDelivery ?? parsed.lastDelivery;
        }
      } catch {
        // The local status still stands.
      }
    }
    return status;
  }

  /** Removes the webhook from the board (when this process set it), then closes the tunnel and the receiver. */
  async stop(): Promise<{ removed: boolean; note?: string }> {
    const active = this.active;
    if (!active) throw new ConfigError("The webhook is not running.");
    let removed = false;
    let note: string | undefined;
    if (active.registration.state === "set") {
      try {
        const result = await removeWebhook(this.deps.run, active.config, active.board, active.persona);
        removed = result.code === 0;
        if (!removed) note = `The webhook could not be removed from the board: ${cliError(result)}`;
      } catch (error) {
        note = `The webhook could not be removed from the board: ${(error as Error).message}`;
      }
    } else {
      note = "The webhook was set by hand, so remove it by hand: msn persona webhook remove BOARD PERSONA.";
    }
    await this.teardown();
    return { removed, note };
  }

  private async teardown(): Promise<void> {
    this.active = null;
    this.context = null;
    const [tunnel, receiver] = [this.tunnel, this.receiver];
    this.tunnel = null;
    this.receiver = null;
    this.queue = [];
    await tunnel?.stop().catch(() => undefined);
    await receiver?.close().catch(() => undefined);
  }
}

export function describe(status: Status): string {
  const lines = [
    `MSN webhook for persona ${status.persona} on board ${status.board}`,
    `Public URL: ${status.publicUrl}`,
    `Tunnel: ${status.tunnel}${status.tunnelAlive ? "" : " (STOPPED: run /msn-webhook-stop, then start again)"}, forwarding to 127.0.0.1:${status.localPort}`,
    status.reachable
      ? "Reachable: yes, checked through the public URL"
      : "Reachable: not confirmed (the public URL did not answer the check yet)",
    status.registration.state === "set"
      ? "Board: webhook set by this session; it is removed on stop"
      : `Board: not set here. ${status.registration.reason}\n  ${status.registration.command}`,
    `Messages enter the session as: ${status.deliverAs}`,
    `Notices: ${status.accepted} accepted, ${status.duplicates} repeats dropped, ${status.rejected} refused`,
    `Messages delivered: ${status.delivered}${status.queued ? `, ${status.queued} waiting for a session` : ""}`,
    `Last notice: ${status.lastNoticeAt ?? "none yet"}; last ping: ${status.lastPingAt ?? "none yet"}`,
  ];
  if (status.board_lastDelivery)
    lines.push(`Board's last delivery: ${JSON.stringify(status.board_lastDelivery)}`);
  return lines.join("\n");
}
