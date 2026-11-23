/** Owner operations for persistent MCP users (ADR 0081). Never use a board persona or shared key. */
import { ProtocolError } from "../../../ios/src/core/errors.ts";
import { HttpClient, type FetchLike } from "../../../ios/src/core/httpClient.ts";
import type { Connection } from "./manage.ts";

export type AgentUser = { id: string; name: string };
export type Membership = { tenant: string; channel: string; watchOnly: boolean };
export type ChannelMember = AgentUser & { watchOnly: boolean };
export type Directory = { endpoint: string; users: AgentUser[]; members: ChannelMember[] };
export type Installation = { id: string; label: string; kind: "bearer" | "oauth"; createdAt: string };
export type Detail = { channels: Membership[]; installations: Installation[] };
/** Only POST …/installations returns a key. The directory and detail decoders never retain one. */
export type IssuedKey = { id: string; token: string };

const LIMITS = { timeoutMs: 15_000, maxBytes: 512 * 1024 };
const ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
export const validChannel = (v: unknown): v is string =>
  typeof v === "string" && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(v);
function invalid(): never {
  throw new ProtocolError("The server did not confirm the requested agent connector information.");
}
function record(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : invalid();
}
function list<T>(v: unknown, decode: (entry: Record<string, unknown>) => T): T[] {
  return Array.isArray(v) ? v.map((entry) => decode(record(entry))) : invalid();
}
function id(v: unknown): string {
  return typeof v === "string" && ID.test(v) ? v : invalid();
}
function flag(v: unknown): boolean {
  return typeof v === "boolean" ? v : invalid();
}
function user(row: Record<string, unknown>): AgentUser {
  return typeof row.name === "string" && row.name.trim() ? { id: id(row.id), name: row.name } : invalid();
}
function roster(board: string) {
  if (!validChannel(board)) return invalid();
  return `/channels/${board}/members`;
}
function checkedText(input: string, field: string) {
  const s = input.trim();
  if (!s || new TextEncoder().encode(s).length > 128)
    throw new Error(`Enter a ${field} of at most 128 UTF-8 bytes.`);
  return s;
}

export class AgentConnectors {
  readonly home: string;
  readonly endpoint: string;
  private readonly http: HttpClient;

  constructor(connection: Connection, fetchImpl?: FetchLike) {
    this.http = new HttpClient(connection.origin, connection.tenant, connection.token, fetchImpl);
    this.home = connection.tenant;
    this.endpoint = new URL("/mcp", connection.origin).href;
  }

  async directory(board: string, signal: AbortSignal): Promise<Directory> {
    const path = roster(board);
    const [dir, channel] = await Promise.all([
      this.http.request<Record<string, unknown>>("/agents", { signal, ...LIMITS }),
      this.http.request<Record<string, unknown>>(path, { signal, ...LIMITS }),
    ]);
    // Never send the operator to another host or copy an endpoint containing credentials.
    if (dir?.endpoint !== this.endpoint) return invalid();
    return {
      endpoint: this.endpoint,
      users: list(dir.agents, user),
      members: list(channel?.members, (m) => {
        if (m.channel !== board) return invalid();
        return { ...user(m), watchOnly: flag(m.watchOnly) };
      }),
    };
  }

  async create(input: string, signal: AbortSignal): Promise<AgentUser> {
    const name = checkedText(input, "display name");
    if (name.toLowerCase() === "github" || /[\p{Cc}\p{Cf}]/u.test(name))
      throw new Error("Choose a different agent name.");
    const r = await this.http.request<Record<string, unknown>>("/agents", {
      method: "POST",
      body: { name },
      signal,
      ...LIMITS,
    });
    const made = user(record(r?.agent));
    return made.name === name ? made : invalid();
  }

  async detail(agent: string, signal: AbortSignal): Promise<Detail> {
    const r = await this.http.request<Record<string, unknown>>(`/agents/${id(agent)}`, { signal, ...LIMITS });
    if (user(record(r?.user)).id !== agent) return invalid();
    return {
      channels: list(r.channels, (m) =>
        validChannel(m.tenant) && validChannel(m.channel)
          ? { tenant: m.tenant, channel: m.channel, watchOnly: flag(m.watchOnly) }
          : invalid(),
      ),
      installations: list(r.installations, (i) => {
        if (
          (i.kind !== "bearer" && i.kind !== "oauth") ||
          typeof i.label !== "string" ||
          typeof i.createdAt !== "string" ||
          !Number.isFinite(Date.parse(i.createdAt))
        )
          return invalid();
        return { id: id(i.id), label: i.label, kind: i.kind, createdAt: i.createdAt };
      }),
    };
  }

  async add(board: string, agent: string, watchOnly: boolean, signal: AbortSignal): Promise<void> {
    const r = await this.http.request<Record<string, unknown>>(`${roster(board)}/${id(agent)}`, {
      method: "PUT",
      body: { watchOnly },
      signal,
      ...LIMITS,
    });
    if (r?.tenant !== this.home || r.channel !== board || r.id !== agent || r.watchOnly !== watchOnly)
      throw new ProtocolError(
        "The server did not confirm that channel access. Refresh to check the actual membership.",
      );
  }

  async remove(board: string, agent: string, signal: AbortSignal): Promise<void> {
    await this.http.request(`${roster(board)}/${id(agent)}`, { method: "DELETE", signal, ...LIMITS });
  }

  async issue(agent: string, input: string, signal: AbortSignal): Promise<IssuedKey> {
    const label = checkedText(input, "host label");
    const r = await this.http.request<Record<string, unknown>>(`/agents/${id(agent)}/installations`, {
      method: "POST",
      body: { label },
      signal,
      ...LIMITS,
    });
    const prefix = `msni1.${this.home}.`;
    if (
      typeof r?.token !== "string" ||
      !r.token.startsWith(prefix) ||
      !/^[a-f0-9]{64}$/.test(r.token.slice(prefix.length))
    )
      return invalid();
    return { id: id(r.id), token: r.token };
  }

  async disconnect(agent: string, install: string, signal: AbortSignal): Promise<void> {
    await this.http.request(`/agents/${id(agent)}/installations/${id(install)}`, {
      method: "DELETE",
      signal,
      ...LIMITS,
    });
  }
}
