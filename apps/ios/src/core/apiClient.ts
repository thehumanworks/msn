import {
  decodeCatchup,
  decodeChannelList,
  decodeEventPage,
  decodeIdentity,
  decodeMessage,
  decodeMessagePage,
  decodePins,
  decodeSendResult,
  decodeSnapshot,
} from "./decode.ts";
import type { FetchLike } from "./httpClient.ts";
import { HttpClient, publicRequest } from "./httpClient.ts";
import type {
  CatchupResult,
  ChannelListResult,
  ContentType,
  EventPage,
  Identity,
  Message,
  MessagePage,
  PinnedMessage,
  Snapshot,
} from "./types.ts";
import { ProtocolError } from "./errors.ts";

export type SendMessageInput = {
  username: string;
  text: string;
  contentType?: ContentType;
  to?: string;
  replyTo?: number;
  correlationId?: string;
};

export type SendMessageResult = { message: Message; replayed: boolean };

/** One tenant + bearer token worth of authenticated calls. Every response is strictly decoded. */
export class ApiClient {
  private readonly http: HttpClient;
  private readonly tenant: string;
  private readonly scopeChannel: string | undefined;

  constructor(
    origin: string,
    tenant: string,
    token: string,
    fetchImpl?: FetchLike,
    scopeChannel?: string,
  ) {
    this.http = new HttpClient(origin, tenant, token, fetchImpl);
    this.tenant = tenant;
    this.scopeChannel = scopeChannel;
  }

  async getIdentity(signal?: AbortSignal): Promise<Identity> {
    return decodeIdentity(await this.http.request<unknown>("", { signal }), this.tenant);
  }

  async listChannels(after?: string, limit?: number, signal?: AbortSignal): Promise<ChannelListResult> {
    return decodeChannelList(
      await this.http.request<unknown>("/channels", { query: { after, limit }, signal }),
    );
  }

  async createChannel(channel: string, signal?: AbortSignal): Promise<{ channel: string; created: boolean }> {
    const result = await this.http.request<{ channel: string; created: boolean }>(
      `/channels/${encodeURIComponent(channel)}`,
      { method: "PUT", signal },
    );
    if (result?.channel !== channel || typeof result.created !== "boolean") {
      throw new ProtocolError("The server sent an invalid channel result.");
    }
    return result;
  }

  async listMessages(
    channel: string,
    after: number,
    limit: number,
    wait: number,
    signal?: AbortSignal,
  ): Promise<MessagePage> {
    return decodeMessagePage(
      await this.http.request<unknown>(`/channels/${encodeURIComponent(channel)}/messages`, {
        query: { after, limit, wait },
        timeoutMs: (wait + 15) * 1000,
        signal,
      }),
      after,
    );
  }

  /** The request timeout is bounded, so a send that times out is an *uncertain* outcome. */
  async sendMessage(
    channel: string,
    input: SendMessageInput,
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<SendMessageResult> {
    return decodeSendResult(
      await this.http.request<unknown>(`/channels/${encodeURIComponent(channel)}/messages`, {
        method: "POST",
        body: input,
        idempotencyKey,
        signal,
      }),
    );
  }

  async getMessage(
    channel: string,
    id: number,
    signal?: AbortSignal,
  ): Promise<{ message: Message; historyRevision: number }> {
    const r = await this.http.request<{ message: unknown; historyRevision: number }>(
      `/channels/${encodeURIComponent(channel)}/messages/${id}`,
      { signal },
    );
    return { message: decodeMessage(r?.message), historyRevision: r.historyRevision };
  }

  async catchup(
    channel: string,
    options: { after?: number; limit?: number; maxBytes?: number } = {},
    signal?: AbortSignal,
  ): Promise<CatchupResult> {
    return decodeCatchup(
      await this.http.request<unknown>(`/channels/${encodeURIComponent(channel)}/catchup`, {
        query: options,
        signal,
      }),
      options.after,
      { tenant: this.tenant, channel },
    );
  }

  /** GET …/pins: the board owner's pinned messages (ADR 0038). */
  async listPins(channel: string, signal?: AbortSignal): Promise<PinnedMessage[]> {
    const r = await this.http.request<{ pins: unknown }>(`/channels/${encodeURIComponent(channel)}/pins`, {
      signal,
    });
    return decodePins(r?.pins, this.tenant, channel);
  }

  async getSnapshot(
    channel: string,
    version: number,
    signal?: AbortSignal,
  ): Promise<{ snapshot: Snapshot; historyRevision: number }> {
    const r = await this.http.request<{ snapshot: unknown; historyRevision: number }>(
      `/channels/${encodeURIComponent(channel)}/snapshots/${version}`,
      { signal },
    );
    return { snapshot: decodeSnapshot(r?.snapshot), historyRevision: r.historyRevision };
  }

  /**
   * GET /api/tenants/:tenant/events — metadata-only change notifications, validated strictly
   * against the request (tenant, cursor order, scope). A channel-scoped key never sends a
   * `channel` filter here: the server already restricts it, and a conflicting filter is a 403.
   */
  async getEvents(
    options: { after: number; limit: number; wait: number; channel?: string },
    signal?: AbortSignal,
  ): Promise<EventPage> {
    const channel = this.scopeChannel ? undefined : options.channel;
    const raw = await this.http.request<unknown>("/events", {
      query: { after: options.after, limit: options.limit, wait: options.wait, channel },
      timeoutMs: (options.wait + 15) * 1000,
      signal,
    });
    return decodeEventPage(raw, {
      tenant: this.tenant,
      after: options.after,
      limit: options.limit,
      channel: this.scopeChannel ?? channel,
    });
  }
}

export type ProvisionResult = Identity & { token: string };

function requireToken(identity: Identity): ProvisionResult {
  if (typeof identity.token !== "string" || !/^[A-Za-z0-9_-]{32,256}$/.test(identity.token)) {
    throw new ProtocolError("The server did not return a usable access key.");
  }
  return identity as ProvisionResult;
}

/** PUT /api/tenants/:tenant (public) — create a brand-new self-service workspace. */
export async function provisionWorkspace(
  origin: string,
  tenant: string,
  username: string,
  channel?: string,
  fetchImpl?: FetchLike,
): Promise<ProvisionResult> {
  const raw = await publicRequest<unknown>(origin, tenant, "", {
    method: "PUT",
    body: { username, ...(channel ? { channel } : {}) },
    fetchImpl,
  });
  return requireToken(decodeIdentity(raw, tenant));
}

/** POST /api/tenants/:tenant/invites/redeem (public) — join with a scoped invitation code. */
export async function redeemInvite(
  origin: string,
  tenant: string,
  code: string,
  username: string,
  fetchImpl?: FetchLike,
): Promise<ProvisionResult> {
  const raw = await publicRequest<unknown>(origin, tenant, "/invites/redeem", {
    method: "POST",
    body: { code, username },
    fetchImpl,
  });
  return requireToken(decodeIdentity(raw, tenant));
}
