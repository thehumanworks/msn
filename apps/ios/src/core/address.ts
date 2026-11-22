// Addressing a message to several names (ADR 0067), mirroring public/address.js.
import type { Message } from "./types.ts";

/** Every name a message is addressed to: `recipients` when present, else `to` alone, else none. */
export function addressees(message: Pick<Message, "to" | "recipients">): string[] {
  const list = message.recipients;
  if (Array.isArray(list) && list.length && list.every((name) => typeof name === "string")) return list;
  return typeof message.to === "string" ? [message.to] : [];
}

export const MAX_RECIPIENTS = 8;

/** Validate and copy the address before queuing it. One name keeps the original wire format. */
export function outgoingAddress(draft: Pick<Message, "to" | "recipients">): { to?: string | string[] } | { error: string } {
  const names = draft.recipients?.length ? draft.recipients : (draft.to?.trim() ? [draft.to] : []);
  if (!names.length) return {};
  if (names.length > MAX_RECIPIENTS) return { error: "Choose at most 8 recipients." };
  const trimmed = names.map((name) => name.trim());
  if (trimmed.some((name) => !name)) return { error: "A recipient name cannot be blank." };
  if (trimmed.some((name) => new TextEncoder().encode(name).length > 128)) return { error: "The recipient name is too long." };
  if (new Set(trimmed.map((name) => name.toLowerCase())).size !== trimmed.length)
    return { error: "Choose each recipient only once." };
  return { to: trimmed.length === 1 ? trimmed[0] : trimmed };
}

/** The names as one line, "reviewer, worker", or "" for a message to everyone. */
export function namesLine(message: Pick<Message, "to" | "recipients">): string {
  return addressees(message).join(", ");
}
