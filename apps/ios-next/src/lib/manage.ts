/**
 * What a person manages from the app beyond reading and posting: invitations, the board's shared
 * link, a persona's webhook (ADR 0062, ADR 0076) and deleting a board (ADR 0080). Archiving is
 * already in the shared list controller.
 *
 * Every call goes through the shared HttpClient, so it stays on the session's origin, refuses
 * redirects, times out and reads a bounded response. Responses are decoded strictly: a link or
 * key that does not have the documented shape is refused, never shown or shared.
 */
// Imported from the shared core directly, not through shared.ts, whose hooks need React Native
// and would keep this module out of the Node tests.
import { ApiError, isAbortError, ProtocolError } from "../../../ios/src/core/errors.ts";
import { HttpClient, type FetchLike } from "../../../ios/src/core/httpClient.ts";
import { putPersona, randomHex, type RandomBytes } from "./persona.ts";

export type Connection = { origin: string; tenant: string; token: string };

/** A management call is interactive: give up sooner than a long poll, and the answers are small. */
const LIMITS = { timeoutMs: 15_000, maxBytes: 512 * 1024 };

const SLUG = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const KEY = /^[A-Za-z0-9_-]{32,256}$/;

export const INVITE_USES = { min: 1, max: 100, default: 25 } as const;
/** How long an invitation can be redeemed. The server accepts 60 s to 7 days. */
export const INVITE_EXPIRY = [
  { label: "1 hour", seconds: 3600 },
  { label: "1 day", seconds: 86400 },
  { label: "7 days", seconds: 604800 },
] as const;

export type Invite = {
  id: string;
  /** The board it is held to, or null for the whole workspace. */
  channel: string | null;
  /** The link to send. Whoever opens it can join, so it is shown and shared only on request. */
  link: string;
  expiresAt: string;
  maxUses: number;
  watch: boolean;
};

export type AgentPersona = { id: string; displayName: string; listening: boolean };

export const SUBSCRIPTIONS = ["addressed", "board", "workspace"] as const;
export type Subscription = (typeof SUBSCRIPTIONS)[number];
export const WAKE_FORMATS = ["notice", "text", "claude-routine"] as const;
export type WakeFormat = (typeof WAKE_FORMATS)[number];
export const WAKE_LABEL: Record<WakeFormat, string> = {
  notice: "MSN notice (default)", text: "JSON with a text field", "claude-routine": "Claude Code task trigger",
};

export type Delivery = {
  status: string;
  at: string | null;
  httpStatus: number | null;
  error: string | null;
};

export type Webhook = {
  persona: string;
  url: string;
  subscribe: Subscription;
  format?: WakeFormat;
  /** Whether notices carry a bearer key. The key itself is never returned. */
  bearer: boolean;
  pending: number;
  lastDelivery: Delivery | null;
};

export type WebhookInput = { url: string; bearer?: string; subscribe: Subscription; format?: WakeFormat };

const text = (value: unknown): string | null => (typeof value === "string" ? value : null);

function decodeWebhook(value: unknown, persona?: string): Webhook {
  const hook = value as Record<string, unknown> | null;
  const url = text(hook?.url);
  const id = text(hook?.persona);
  if (!hook || !url || !id || (persona !== undefined && id !== persona))
    throw new ProtocolError("The server sent an invalid webhook.");
  const format = hook.format;
  if (format !== undefined && format !== "notice" && format !== "text" && format !== "claude-routine")
    throw new ProtocolError("This app does not support the saved webhook format.");
  const last = hook.lastDelivery as Record<string, unknown> | null | undefined;
  return {
    persona: id,
    url,
    ...(format ? { format } : {}),
    // Anything unknown reads as the default, as the web app does (public/webhook.js).
    subscribe: hook.subscribe === "board" || hook.subscribe === "workspace" ? hook.subscribe : "addressed",
    bearer: hook.bearer === true,
    pending: typeof hook.pending === "number" ? hook.pending : 0,
    lastDelivery:
      last && typeof last.status === "string"
        ? {
            status: last.status,
            at: text(last.at),
            httpStatus: typeof last.httpStatus === "number" ? last.httpStatus : null,
            error: text(last.error),
          }
        : null,
  };
}

/** The link the welcome screen and the web app both accept for an invitation code. */
export function inviteLink(origin: string, code: string): string {
  return `${origin}/#invite=${code}`;
}

/** A board's shared link, in the web app's form (`#board=TENANT/BOARD&key=KEY`). */
export function boardLink(origin: string, tenant: string, board: string, key: string): string {
  return `${origin}/#board=${tenant}/${board}&key=${key}`;
}

export class Manage {
  private readonly http: HttpClient;
  private readonly origin: string;
  private readonly tenant: string;

  constructor(connection: Connection, fetchImpl?: FetchLike) {
    this.http = new HttpClient(connection.origin, connection.tenant, connection.token, fetchImpl);
    this.origin = new URL(connection.origin).origin;
    this.tenant = connection.tenant;
  }

  /** POST /invites: a link that lets `maxUses` people join the workspace, or one board of it. */
  async createInvite(
    input: { channel: string | null; maxUses: number; expiresIn: number; watch: boolean },
    signal?: AbortSignal,
  ): Promise<Invite> {
    const made = await this.http.request<Record<string, unknown>>("/invites", {
      method: "POST",
      body: {
        channel: input.channel,
        maxUses: input.maxUses,
        expiresIn: input.expiresIn,
        ...(input.watch ? { watch: true } : {}),
      },
      signal,
      ...LIMITS,
    });
    const id = text(made?.id);
    const code = text(made?.code);
    const expiresAt = text(made?.expiresAt);
    // The link is built here from the checked code, so it can only point at this session's server.
    if (!id || !expiresAt || Number.isNaN(Date.parse(expiresAt)) || !code)
      throw new ProtocolError("The server sent an invalid invitation.");
    if (!code.startsWith(`${this.tenant}.`) || !/^[a-f0-9]{64}$/.test(code.slice(this.tenant.length + 1)))
      throw new ProtocolError("The server sent an invalid invitation.");
    if ((made.channel ?? null) !== input.channel || made.maxUses !== input.maxUses)
      throw new ProtocolError("The server sent a different invitation than was asked for.");
    // A watch-only request answered with a full invitation would hand out write access.
    if ((made.watch === true) !== input.watch)
      throw new ProtocolError("The server sent a different invitation than was asked for.");
    return {
      id,
      channel: input.channel,
      link: inviteLink(this.origin, code),
      expiresAt,
      maxUses: input.maxUses,
      watch: input.watch,
    };
  }

  /** DELETE /invites/ID: nobody else can use the link. People who already joined keep access. */
  async revokeInvite(id: string, signal?: AbortSignal): Promise<void> {
    await this.http.request<unknown>(`/invites/${encodeURIComponent(id)}`, { method: "DELETE", signal, ...LIMITS });
  }

  /**
   * GET …/board/connection: the board's shared link, which the owner and holders of that link
   * may read. Null when the board has none (a plain channel) or this key may not read it; the
   * caller then offers an invitation instead.
   */
  async sharedBoardLink(board: string, signal?: AbortSignal): Promise<string | null> {
    let shared: Record<string, unknown>;
    try {
      shared = await this.http.request<Record<string, unknown>>(
        `/channels/${encodeURIComponent(board)}/board/connection`,
        { signal, ...LIMITS },
      );
    } catch (error) {
      if (error instanceof ApiError && (error.status === 403 || error.status === 404)) return null;
      throw error;
    }
    const key = text(shared?.token);
    if (shared?.tenant !== this.tenant || shared?.channel !== board || !SLUG.test(board) || !key || !KEY.test(key))
      throw new ProtocolError("The server sent an invalid board link.");
    return boardLink(this.origin, this.tenant, board, key);
  }

  /** GET …/personas with ids, which a webhook is set on. Null on a channel that is not a board. */
  async personas(board: string, signal?: AbortSignal): Promise<AgentPersona[] | null> {
    let roster: { personas?: unknown };
    try {
      roster = await this.http.request<{ personas?: unknown }>(`/channels/${encodeURIComponent(board)}/personas`, {
        signal,
        ...LIMITS,
      });
    } catch (error) {
      if (error instanceof ApiError && error.code === "board_not_found") return null;
      throw error;
    }
    if (!Array.isArray(roster?.personas)) throw new ProtocolError("The server sent an invalid list of agents.");
    const out: AgentPersona[] = [];
    for (const item of roster.personas as (Record<string, unknown> | null)[]) {
      const id = text(item?.id);
      const displayName = text(item?.displayName);
      if (id && displayName) out.push({ id, displayName, listening: item?.listening === true });
    }
    return out;
  }

  /**
   * Enable shared board access in place, only on the owner's explicit request. A second device
   * may have done this first. Its credential wins: never replace it or call the rotation route.
   * The caller reloads the roster after either outcome.
   */
  async enableAgents(board: string, secureBytes: RandomBytes, signal?: AbortSignal): Promise<void> {
    if (!SLUG.test(board)) throw new Error("Invalid board name.");
    try {
      const made = await this.http.request<{ board?: { channel?: string }; sharedChannel?: boolean }>(
        `/channels/${board}/board`,
        {
          method: "PUT",
          body: { goal: `Collaborate in #${board}.`, credential: randomHex(32, secureBytes) },
          signal, ...LIMITS,
        },
      );
      if (made?.sharedChannel !== true || made.board?.channel !== board)
        throw new ProtocolError("The server did not confirm shared access for this board.");
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 409 && error.code === "board_exists")) throw error;
    }
  }

  registerAgent(board: string, id: string, name: string, signal?: AbortSignal) {
    return putPersona(this.http, board, id, name, signal);
  }

  /** GET …/webhooks: the board's webhooks by persona id. Owner only. */
  async webhooks(board: string, signal?: AbortSignal): Promise<Map<string, Webhook>> {
    const listed = await this.http.request<{ webhooks?: unknown }>(`/channels/${encodeURIComponent(board)}/webhooks`, {
      signal,
      ...LIMITS,
    });
    if (!Array.isArray(listed?.webhooks)) throw new ProtocolError("The server sent an invalid list of webhooks.");
    const out = new Map<string, Webhook>();
    for (const item of listed.webhooks) {
      const hook = decodeWebhook(item);
      out.set(hook.persona, hook);
    }
    return out;
  }

  private hookPath(board: string, persona: string): string {
    return `/channels/${encodeURIComponent(board)}/personas/${encodeURIComponent(persona)}/webhook`;
  }

  /** GET …/webhook: one persona's webhook, or null when it has none. */
  async webhook(board: string, persona: string, signal?: AbortSignal): Promise<Webhook | null> {
    try {
      const read = await this.http.request<{ webhook?: unknown }>(this.hookPath(board, persona), { signal, ...LIMITS });
      return decodeWebhook(read?.webhook, persona);
    } catch (error) {
      if (error instanceof ApiError && error.code === "webhook_not_found") return null;
      throw error;
    }
  }

  /**
   * PUT …/webhook replaces the whole webhook: a bearer key that is not sent again is removed
   * (ADR 0062). The key goes in the request body only and is never read back.
   */
  async setWebhook(board: string, persona: string, input: WebhookInput, signal?: AbortSignal): Promise<Webhook> {
    const made = await this.http.request<{ webhook?: unknown }>(this.hookPath(board, persona), {
      method: "PUT",
      body: { url: input.url, subscribe: input.subscribe,
        ...(input.format && input.format !== "notice" ? { format: input.format } : {}),
        ...(input.bearer ? { bearer: input.bearer } : {}) },
      signal,
      ...LIMITS,
    });
    const saved = decodeWebhook(made?.webhook, persona);
    if ((saved.format ?? "notice") !== (input.format ?? "notice")) throw new ProtocolError("The server did not confirm the webhook format.");
    return saved;
  }

  async removeWebhook(board: string, persona: string, signal?: AbortSignal): Promise<void> {
    await this.http.request<unknown>(this.hookPath(board, persona), { method: "DELETE", signal, ...LIMITS });
  }

  /** POST …/webhook/test queues a `ping` notice through the normal delivery path. */
  async testWebhook(board: string, persona: string, signal?: AbortSignal): Promise<void> {
    await this.http.request<unknown>(`${this.hookPath(board, persona)}/test`, { method: "POST", signal, ...LIMITS });
  }

  /**
   * DELETE …/channels/BOARD?confirm=BOARD (ADR 0080): the board and everything on it is removed
   * for everyone. Owner only. `confirm` repeats the name so a mistyped path cannot delete a board.
   */
  async deleteBoard(board: string, signal?: AbortSignal): Promise<void> {
    const done = await this.http.request<{ channel?: unknown; deleted?: unknown }>(
      `/channels/${encodeURIComponent(board)}`,
      { method: "DELETE", query: { confirm: board }, signal, ...LIMITS },
    );
    if (done?.channel !== board || done.deleted !== true)
      throw new ProtocolError("The server did not confirm that the board was deleted.");
  }
}

/**
 * The words to show for a failed management call. `expired` is true when the key itself no
 * longer works, so the caller can end the session.
 */
/**
 * Whether what the person typed confirms deleting `board`. Board names are lowercase only, and the
 * keyboard may capitalise the first letter, so case is ignored; anything else must match exactly.
 */
export function confirmsDelete(typed: string | undefined, board: string): boolean {
  return board !== "" && (typed ?? "").trim().toLowerCase() === board;
}

export function explain(error: unknown, doing: string): { message: string; expired: boolean } {
  const say = (message: string) => ({ message, expired: false });
  if (error instanceof ApiError) {
    if (error.status === 401) return { message: "Your access key was revoked or reset.", expired: true };
    switch (error.code) {
      case "owner_required":
        return say("Only the workspace owner can do this.");
      case "watch_only":
        return say("Your access is watch only, so you cannot change anything.");
      case "channel_forbidden":
        return say("Your access covers one board only.");
      case "persona_name_conflict":
        return say("An agent with that name is already registered on this board.");
      case "shared_channel_invitation":
        return say("This board is shared with one link. Send that link instead of an invitation.");
      case "board_archived":
        return say("This board is archived and read-only. Unarchive it first.");
      case "route_not_found":
        return say(`This server cannot ${doing} yet. It needs to be updated first.`);
    }
    return say(error.message);
  }
  if (isAbortError(error)) return say("Cancelled because the app became inactive. Try again.");
  return say(error instanceof Error ? error.message : `Could not ${doing}.`);
}

/** A first check before sending: the server applies the full rules (ADR 0062, Security). */
export function checkWebhookUrl(input: string): string | null {
  const value = input.trim();
  if (!value) return "Enter the address the notices go to.";
  if (value.length > 2048) return "The address is at most 2048 characters.";
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "Enter a complete address, starting with https://.";
  }
  if (url.protocol !== "https:") return "The address must start with https://.";
  if (url.username || url.password) return "The address cannot carry a user name or password.";
  if (url.hash) return "The address cannot have a # part.";
  return null;
}

/** A bearer key is optional: 8 to 1024 visible ASCII characters, as the server requires. */
export function checkBearer(input: string): string | null {
  const value = input.trim();
  if (!value) return null;
  if (!/^[\x21-\x7e]{8,1024}$/.test(value)) return "A bearer key is 8 to 1024 letters, digits or symbols, with no spaces.";
  return null;
}

// The rest is plain-language text for a webhook, ported from the web app (public/webhook.js).

function since(iso: string, now: number): string {
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  for (const [size, unit] of [
    [86400, "d"],
    [3600, "h"],
    [60, "min"],
  ] as const)
    if (seconds >= size) return `${Math.floor(seconds / size)} ${unit} ago`;
  return "just now";
}

export function webhookHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

const ERRORS: Record<string, string> = {
  timeout: "no answer within 5 seconds",
  network_error: "could not connect",
  redirect_refused: "it answered with a redirect, which is not followed",
  backlog_full: "50 notices were already waiting, so a new one was dropped",
};

export function failureText(delivery: Delivery | null): string {
  if (!delivery?.error) return "";
  const known = ERRORS[delivery.error];
  if (known) return known;
  const status = /^http_(\d{3})$/.exec(delivery.error)?.[1];
  return status ? `it answered HTTP ${status}` : delivery.error;
}

export const SUBSCRIBE_LABEL: Record<Subscription, string> = {
  addressed: "Messages to this agent",
  board: "Every message on this board",
  workspace: "Every message in the workspace",
};

const HEARS: Record<Subscription, string> = {
  addressed: "",
  board: " for every message on this board",
  workspace: " for every message on every board",
};

/** What the chosen level means for the receiver. */
export function subscribeNote(level: Subscription): string {
  if (level === "addressed") return "The default: one notice for each message that names this agent.";
  return "Messages that arrive while a notice waits share that notice, so the agent should read everything new on the notice's board. The agent's own messages never wake it.";
}

/** One line for an agent's row: where it wakes and how the last notice went. */
export function webhookSummary(hook: Webhook | null, now = Date.now()): string {
  if (!hook) return "No webhook: its agent wakes only when it listens.";
  const host = `${webhookHost(hook.url)}${HEARS[hook.subscribe]}`;
  const last = hook.lastDelivery;
  if (!last) return `Wakes ${host} · nothing sent yet`;
  const when = last.at ? since(last.at, now) : "";
  switch (last.status) {
    case "delivered":
      return `Wakes ${host} · delivered ${when}`;
    case "retrying":
      return `Wakes ${host} · retrying: ${failureText(last)}`;
    case "dropped":
      return `Wakes ${host} · ${failureText(last)}`;
    default:
      return `Wakes ${host} · failed ${when}: ${failureText(last)}`;
  }
}

export function authText(hook: Webhook): string {
  return hook.bearer
    ? "Sent with a bearer key."
    : "No bearer key: the receiver cannot tell these notices are from this board.";
}
