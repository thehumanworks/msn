/** Test-only directory. The transport receives a verified identity; the REAL tenant Worker
 * issues and checks scoped keys. The production Worker does not import or mount this fixture.
 * No network URL from an invitation is ever fetched.
 */
import { HttpError } from "../../src/http";
import type { AgentChat, BoardRef, ChatPage, Membership } from "../../src/remote-mcp";
import type { Message } from "../../src/store";

export type Ticket = Membership & { token: string; keyId: string };
export interface TestDirectory {
  get(ref: BoardRef): Promise<Ticket | undefined>;
  put(member: Ticket): Promise<void>;
  list(): Promise<Ticket[]>;
}

export function fixtureAgent(
  user: AgentChat["user"],
  directory: TestDirectory,
  origin: string,
  api: (request: Request) => Promise<Response>,
): AgentChat {
  async function call<T>(tenant: string, path: string, token?: string, input?: object, key?: string) {
    const response = await api(
      new Request(`${origin}/api/tenants/${tenant}${path}`, {
        method: input ? "POST" : "GET",
        redirect: "manual",
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(input ? { "Content-Type": "application/json" } : {}),
          ...(key ? { "Idempotency-Key": key } : {}),
        },
        ...(input ? { body: JSON.stringify(input) } : {}),
      }),
    );
    if (!response.ok) {
      const { error } = await response.json<{ error: { code: string } }>();
      throw new HttpError(response.status, error.code, "Fixture request refused");
    }
    return response.json<T>();
  }
  async function member(ref: BoardRef) {
    const ticket = await directory.get(ref);
    if (!ticket) throw new HttpError(403, "channel_unavailable", "No membership");
    return ticket;
  }
  return {
    user,
    list: () => directory.list(),
    async join(tenant, code) {
      const issued = await call<{
        channel: string;
        username: string;
        token: string;
        keyId: string;
        watchOnly?: boolean;
      }>(tenant, "/invites/redeem", undefined, { code, username: user.name, channelOnly: true });
      if (!issued.channel || issued.username !== user.name) throw new Error("Invalid scoped fixture key");
      const ticket: Ticket = {
        tenant,
        channel: issued.channel,
        token: issued.token,
        keyId: issued.keyId,
        watchOnly: issued.watchOnly === true,
      };
      await directory.put(ticket);
      return ticket;
    },
    async read(ref, after, limit) {
      const ticket = await member(ref);
      return call<ChatPage>(
        ref.tenant,
        `/channels/${ref.channel}/messages?after=${after}&limit=${limit}`,
        ticket.token,
      );
    },
    async send(ref, { key, ...input }) {
      const ticket = await member(ref);
      return call<{ message: Message; replayed: boolean }>(
        ref.tenant,
        `/channels/${ref.channel}/messages`,
        ticket.token,
        { ...input, username: user.name },
        key,
      );
    },
  };
}
