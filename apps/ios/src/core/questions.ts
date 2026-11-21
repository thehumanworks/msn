// Ask a question with buttons (ADR 0065). Pure helpers: a question is a message with `to` and
// `choices`; the addressed name answers with a reply carrying `answer`.
import type { Answered, Message } from "./types.ts";

/** The answer record a reply sets on its question, or null when the reply is not an answer. */
export function answeredBy(reply: Message): Answered | null {
  if (reply.answer === undefined || reply.replyTo === undefined) return null;
  return { id: reply.id, choice: reply.answer, username: reply.username, answeredAt: reply.createdAt };
}

/** Whether `me` is the name a question is addressed to: exactly, or trimmed and ignoring case. */
export function addressedTo(me: string | undefined, to: string | undefined): boolean {
  if (me === undefined || to === undefined) return false;
  return me === to || me.trim().toLowerCase() === to.trim().toLowerCase();
}

export type ChoiceMode = "answered" | "open" | "waiting";

/** "open" only for the addressed name on a board that takes posts, until the first answer. */
export function choiceMode(message: Message, me: string | undefined, canAnswer: boolean): ChoiceMode {
  if (message.answered) return "answered";
  return canAnswer && addressedTo(me, message.to) ? "open" : "waiting";
}

/** The line under the buttons. Names and choices are shown as plain text. */
export function choiceNote(message: Message, mode: ChoiceMode): string {
  if (mode === "answered" && message.answered)
    return `${message.answered.username} answered ${message.answered.choice}`;
  return mode === "open" ? "Your answer" : `Waiting for ${message.to ?? "someone"}`;
}
