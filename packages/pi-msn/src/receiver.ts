// The local HTTP receiver for MSN webhook notices (msn.webhook.v1, ADR 0062). It listens on
// loopback only; a tunnel or the user's own proxy makes it public. It checks the bearer key in
// constant time, drops repeats by MSN-Webhook-Id, answers at once and hands the notice on.
import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/** A notice holds ids only, so anything larger is not one. MSN's own limit is 1 KiB. */
export const MAX_BODY_BYTES = 8 * 1024;
/** Notice ids remembered to drop repeats. MSN keeps at most 50 notices waiting per webhook. */
export const MAX_SEEN = 2000;

export type Notice = {
  schema: "msn.webhook.v1";
  type: string;
  id: string;
  tenant?: string;
  channel?: string;
  persona?: string;
  messageId?: number | null;
  eventId?: number | null;
  messageUrl?: string | null;
  createdAt?: string;
};

export type ReceiverStats = {
  accepted: number;
  duplicates: number;
  rejected: number;
  lastNoticeAt: string | null;
  lastPingAt: string | null;
};

export type Receiver = {
  port: number;
  stats: ReceiverStats;
  close(): Promise<void>;
};

export type ReceiverOptions = {
  bearer: string;
  path: string;
  port: number;
  onNotice(notice: Notice): void;
};

function sameKey(given: string, expected: string): boolean {
  // Hash both sides so the comparison takes the same time whatever the given length.
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

function readBody(request: IncomingMessage): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const finish = (value: Buffer | null) => {
      if (done) return;
      done = true;
      resolve(value);
    };
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        finish(null);
        request.resume();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => finish(Buffer.concat(chunks)));
    request.on("error", () => finish(null));
  });
}

function parseNotice(body: Buffer, headerId: string): Notice | null {
  let raw: unknown;
  try {
    raw = JSON.parse(body.toString("utf8"));
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const notice = raw as Record<string, unknown>;
  if (notice.schema !== "msn.webhook.v1" || typeof notice.type !== "string") return null;
  const id = headerId || (typeof notice.id === "string" ? notice.id : "");
  if (!id || id.length > 200) return null;
  return { ...(notice as Notice), id };
}

export function startReceiver(options: ReceiverOptions): Promise<Receiver> {
  const stats: ReceiverStats = {
    accepted: 0,
    duplicates: 0,
    rejected: 0,
    lastNoticeAt: null,
    lastPingAt: null,
  };
  const seen = new Set<string>();
  const expected = `Bearer ${options.bearer}`;

  const answer = (response: ServerResponse, status: number, body = "") => {
    response.writeHead(status, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
    response.end(body);
  };

  const handle = async (request: IncomingMessage, response: ServerResponse) => {
    const path = (request.url ?? "").split("?")[0];
    // Lets `start` see that the public address reaches this process. It discloses nothing.
    if (request.method === "GET" && path === "/healthz") return answer(response, 200, "ok\n");
    if (path !== options.path) return answer(response, 404);
    if (request.method !== "POST") return answer(response, 405);
    const given = request.headers.authorization;
    if (typeof given !== "string" || !sameKey(given, expected)) {
      stats.rejected += 1;
      return answer(response, 401);
    }
    const body = await readBody(request);
    if (body === null) {
      stats.rejected += 1;
      return answer(response, 413);
    }
    const headerId = request.headers["msn-webhook-id"];
    const notice = parseNotice(body, typeof headerId === "string" ? headerId : "");
    if (notice === null) {
      stats.rejected += 1;
      return answer(response, 400);
    }
    if (seen.has(notice.id)) {
      // A retry of a notice already handled: say yes again so MSN stops retrying.
      stats.duplicates += 1;
      return answer(response, 204);
    }
    seen.add(notice.id);
    if (seen.size > MAX_SEEN) seen.delete(seen.values().next().value as string);
    stats.accepted += 1;
    const now = new Date().toISOString();
    stats.lastNoticeAt = now;
    if (notice.type === "ping") stats.lastPingAt = now;
    // Answer first: MSN waits 5 seconds at most, and reading the message can take longer.
    answer(response, 204);
    try {
      options.onNotice(notice);
    } catch {
      // The receiver must keep serving whatever the handler does.
    }
  };

  return new Promise((resolve, reject) => {
    const server: Server = createServer((request, response) => {
      handle(request, response).catch(() => {
        if (!response.headersSent) answer(response, 500);
      });
    });
    server.once("error", reject);
    server.listen(options.port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve({
        port: (server.address() as AddressInfo).port,
        stats,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
            server.closeAllConnections();
          }),
      });
    });
  });
}
