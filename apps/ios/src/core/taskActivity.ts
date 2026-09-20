import type { Message, TaskActivityEntry, TaskEventBody } from "./types.ts";

const TASK_ACTIONS = new Set(["open", "claim", "assign", "block", "ready", "close", "cancel"]);

/**
 * Best-effort parse of one message as an msn.task.v1 activity entry. Returns null for anything
 * that is not a well-formed task event — including unknown schema versions, which ADR 0010 is
 * explicit must never be treated as a completed/authoritative task action.
 *
 * This intentionally stops at "here is the raw event", It does NOT compute `state`,
 * `assertedState`, authority, or conflicts (duplicate-open, claim-conflict, dependency cycles,
 * orphan evidence, ...) the way cli/src/tasks.rs's `project()` does. Reimplementing that reducer
 * in the client would risk showing a wrong authoritative-looking status; the timeline this feeds
 * is explicitly labelled as a raw log excerpt instead (see docs/adr/0019-ios-client.md).
 */
export function parseTaskActivity(message: Message): TaskActivityEntry | null {
  if (message.contentType !== "application/json") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(message.text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const body = parsed as Record<string, unknown>;
  if (body.schema !== "msn.task.v1") return null;
  if (typeof body.task !== "string" || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(body.task)) return null;
  if (typeof body.action !== "string" || !TASK_ACTIONS.has(body.action)) return null;
  return {
    messageId: message.id,
    createdAt: message.createdAt,
    actor: message.username,
    body: body as unknown as TaskEventBody,
  };
}

/** Filters and parses a page of messages into task activity entries, preserving log order. */
export function extractTaskActivity(messages: Message[]): TaskActivityEntry[] {
  const entries: TaskActivityEntry[] = [];
  for (const message of messages) {
    const entry = parseTaskActivity(message);
    if (entry) entries.push(entry);
  }
  return entries;
}
