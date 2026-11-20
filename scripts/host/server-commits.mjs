/**
 * Processing commits sent to the server by default (ADR 0053), so processed-by receipts (ADR 0040)
 * name agents run by `msn run` and the event dispatcher. The runner keeps its own local progress
 * (event cursor, job queue) as before; this only reports, per channel, the message watermark the
 * runner has explicitly finished with. Same claim/generation fence as `msn peek` (ADR 0034).
 *
 * Never a silent takeover: a reader that another machine holds (processing_held) stays theirs and
 * this runner simply reports nothing. A runner that has been taken over (processing_fenced) must
 * stop; the caller does that.
 */
import { hostname } from "node:os";

const FALSEY = new Set(["0", "false", "no", "off", "n", "f"]);

/** Whether to send commits: on unless the config says `serverCommits: false` or MSN_RESUMABLE is falsey. */
export function serverCommitsEnabled(configured, env = process.env) {
  if (configured === false) return false;
  return !FALSEY.has(
    String(env.MSN_RESUMABLE ?? "")
      .trim()
      .toLowerCase(),
  );
}

/** The holder label a person sees when deciding on `msn takeover` (at most 128 bytes on the server). */
export function holderLabel(role) {
  let host = "";
  try {
    host = hostname().trim();
  } catch {}
  return `${host || "unknown-host"} (${role})`.slice(0, 120);
}

function encode(reader) {
  return encodeURIComponent(reader);
}

/** Refusals after which this runner stops reporting for the reader, until it restarts. */
const UNAVAILABLE = new Map([
  [
    "processing_held",
    "Another machine or process holds this reader; this runner keeps working but reports no receipts.",
  ],
  ["watch_only", "This key is watch-only and cannot commit."],
  ["route_not_found", "This server does not keep processing progress."],
  ["board_archived", "The board is archived."],
  ["username_bound", "This key is bound to another name and cannot commit as this reader."],
  ["forbidden", "This key may not commit under this name."],
]);

export class Fenced extends Error {
  constructor(channel, reader) {
    super(
      `processing_fenced: reader ${reader} on ${channel} was taken over on another machine (msn takeover). Stop processing it.`,
    );
    this.code = "processing_fenced";
  }
}

/**
 * One reader on one channel. `generation` is the saved fence (0 when never claimed here); `save` is
 * called with a new generation before any commit uses it, so a crash cannot lock the runner out of
 * its own claim.
 */
export class ServerCommits {
  constructor({ request, connection, channel, reader, generation = 0, save, role }) {
    this.request = request;
    this.connection = connection;
    this.channel = channel;
    this.reader = reader;
    this.generation = generation;
    this.save = save;
    this.holder = holderLabel(role);
    this.committed = 0;
    this.unavailable = null;
  }
  base() {
    return `/api/tenants/${this.connection.tenant}/channels/${this.channel}/processing/${encode(this.reader)}`;
  }
  /**
   * Commits through `through` if it moved. Returns {status: "committed" | "unchanged" | "unavailable" |
   * "retry", reason?}. Throws Fenced when another machine took the reader over.
   */
  async commit(through, signal) {
    if (this.unavailable) return { status: "unavailable", reason: this.unavailable };
    if (!Number.isSafeInteger(through) || through <= 0 || through <= this.committed)
      return { status: "unchanged" };
    try {
      if (!this.generation) {
        const claimed = await this.request(this.connection, `${this.base()}/claim`, signal, {
          method: "POST",
          body: { expectGeneration: 0, holder: this.holder },
        });
        if (!Number.isSafeInteger(claimed?.generation) || claimed.generation < 1)
          return { status: "retry", reason: "invalid_claim" };
        await this.save(claimed.generation);
        this.generation = claimed.generation;
        this.committed = Number.isSafeInteger(claimed.committedThrough) ? claimed.committedThrough : 0;
        if (through <= this.committed) return { status: "unchanged" };
      }
      const saved = await this.request(this.connection, `${this.base()}/commit`, signal, {
        method: "POST",
        body: { generation: this.generation, through },
      });
      this.committed = Number.isSafeInteger(saved?.committedThrough) ? saved.committedThrough : through;
      return { status: "committed", through: this.committed };
    } catch (error) {
      if (signal?.aborted) return { status: "retry", reason: "stopped" };
      const code = error.code ?? (error.status === 403 ? "forbidden" : null);
      if (code === "processing_fenced") throw new Fenced(this.channel, this.reader);
      // Someone else's commit cannot move this generation; behind means the server is already ahead.
      if (code === "commit_behind") {
        this.committed = through;
        return { status: "unchanged" };
      }
      // The claim is gone (a server restore); claim again on the next commit.
      if (code === "processing_not_claimed") {
        this.generation = 0;
        return { status: "retry", reason: code };
      }
      if (UNAVAILABLE.has(code) || error.status === 403) {
        this.unavailable = code;
        return { status: "unavailable", reason: code };
      }
      return { status: "retry", reason: code ?? (error.status ? `http_${error.status}` : "transport") };
    }
  }
}

/** A short hint for logs, never server text. */
export function unavailableHint(reason) {
  return UNAVAILABLE.get(reason) ?? "";
}
