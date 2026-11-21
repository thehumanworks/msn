// Addressing a message to several names (ADR 0067), mirroring public/address.js.
import type { Message } from "./types.ts";

/** Every name a message is addressed to: `recipients` when present, else `to` alone, else none. */
export function addressees(message: Pick<Message, "to" | "recipients">): string[] {
  const list = message.recipients;
  if (Array.isArray(list) && list.length && list.every((name) => typeof name === "string")) return list;
  return typeof message.to === "string" ? [message.to] : [];
}

/** The names as one line, "reviewer, worker", or "" for a message to everyone. */
export function namesLine(message: Pick<Message, "to" | "recipients">): string {
  return addressees(message).join(", ");
}
