import {
  decodeCatchup,
  decodeChannelList,
  decodeEventPage,
  decodeIdentity,
  decodeMessage,
  decodeMessagePage,
  decodePins,
  decodeSearchPage,
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
  SearchPage,
  Snapshot,
} from "./types.ts";
import { ProtocolError } from "./errors.ts";
import { decodeMute, decodeMutes, type Mute } from "./mutes.ts";

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

  async listChannels(
    after?: string,
    limit?: number,
    signal?: AbortSignal,
    includeArchived = false,
  ): Promise<ChannelListResult> {
    const include = includeArchived ? "archived" : undefined;
    return decodeChannelList(
      await this.http.request<unknown>("/channels", { query: { after, limit, include }, signal }),
    );
  }

  /** PUT archives a board, DELETE unarchives it (ADR 0046). The server allows only the owner. */
  async setArchived(channel: string, archived: boolean, signal?: AbortSignal): Promise<boolean> {
    const result = await this.http.request<{ channel: string; archived: boolean }>(
      `/channels/${encodeURIComponent(channel)}/archive`,
      { method: archived ? "PUT" : "DELETE", signal },
    );
    if (result?.channel !== channel || typeof result.archived !== "boolean") {
      throw new ProtocolError("The server sent an invalid archive result.");
    }
    return result.archived;
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

  /** The owner's active board mutes (ADR 0044). Owner keys only; others get 403. */
  async listMutes(signal?: AbortSignal): Promise<Mute[]> {
    return decodeMutes(await this.http.request<unknown>("/push/mutes", { signal }));
  }

  /** Mutes one board for 1h, 1d or (`null`) until turned back on. */
  async setMute(
    channel: string,
    span: "1h" | "1d" | null,
    everything: boolean,
    signal?: AbortSignal,
  ): Promise<Mute> {
    return decodeMute(
      await this.http.request<unknown>(`/push/mutes/${encodeURIComponent(channel)}`, {
        method: "PUT",
        body: { ...(span ? { for: span } : {}), everything },
        signal,
      }),
    );
  }

  async clearMute(channel: string, signal?: AbortSignal): Promise<void> {
    await this.http.request<unknown>(`/push/mutes/${encodeURIComponent(channel)}`, {
      method: "DELETE",
      signal,
    });
  }

  /** Every reader's explicit commit position on a channel (ADR 0040); decode with decodeReceipts. */
  async channelReceipts(channel: string, signal?: AbortSignal): Promise<unknown> {
    return this.http.request<unknown>(`/channels/${encodeURIComponent(channel)}/receipts`, { signal });
  }

  /** Board search (ADR 0037): words in `q`, an optional sender, older pages with `before`. */
  async searchMessages(
    channel: string,
    query: { q?: string; from?: string; before?: number; limit?: number },
    signal?: AbortSignal,
  ): Promise<SearchPage> {
    return decodeSearchPage(
      await this.http.request<unknown>(`/channels/${encodeURIComponent(channel)}/search`, {
        query: { q: query.q || undefined, from: query.from || undefined, before: query.before, limit: query.limit },
        signal,
      }),
      channel,
    );
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
