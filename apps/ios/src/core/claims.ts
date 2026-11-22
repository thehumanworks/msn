import type { Claim, Message } from "./types.ts";

/**
 * Take a request (ADR 0075). One name marks a message as being handled, so others skip it. The
 * server keeps one holder per message and lets only the holder or the workspace owner release
 * it; these helpers only decide what a row offers.
 */

/** A claim from the server, or undefined when the value is not one. Never throws. */
export function decodeClaim(raw: unknown): Claim | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const { username, claimedAt } = raw as Record<string, unknown>;
  if (typeof username !== "string" || !username || typeof claimedAt !== "string") return undefined;
  return { username, claimedAt };
}

export type ClaimControl = "take" | "release" | null;

/**
 * What a writable row offers `me`: take a free message that nothing replaced, or release one
 * that `me` holds (the owner may release anyone's). Null where there is nothing to press.
 */
export function claimControl(message: Message, me: string | undefined, owner: boolean): ClaimControl {
  if (!me) return null;
  if (!message.claim) return message.replacedBy === undefined ? "take" : null;
  return message.claim.username === me || owner ? "release" : null;
}

/** "Taken by NAME", with "(you)" for the reader's own claim. */
export function claimNote(claim: Claim, me: string | undefined): string {
  return `Taken by ${claim.username}${claim.username === me ? " (you)" : ""}`;
}

/** A copy of the message with this claim; none leaves the field out, as the server does. */
export function withClaim(message: Message, claim: Claim | undefined): Message {
  const { claim: _old, ...rest } = message;
  return claim ? { ...rest, claim } : rest;
}
