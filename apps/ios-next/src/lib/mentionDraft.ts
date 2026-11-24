import { MAX_RECIPIENTS } from "../../../ios/src/core/address.ts";
import { insertMention, isChannelMention, keptMentions, mentionAt } from "../../../ios/src/core/mention.ts";

export type MentionDraft = { text: string; recipients: string[] };
export const emptyDraft: MentionDraft = { text: "", recipients: [] };

export function editMentionDraft(draft: MentionDraft, text: string): MentionDraft {
  return { text, recipients: keptMentions(text, draft.recipients) };
}

/** A tap, not arbitrary text in a message, addresses the recipient. Recheck the active @ at tap time. */
export function pickMention(draft: MentionDraft, caret: number, name: string): { draft: MentionDraft; caret: number } | null {
  const at = mentionAt(draft.text, caret);
  if (!at || !name.trim()) return null;
  const next = insertMention(draft.text, at.start, caret, name);
  const kept = editMentionDraft(draft, next.text);
  // @channel is expanded on the server and does not take one of the eight To names.
  if (isChannelMention(name)) return { draft: { text: next.text, recipients: kept.recipients }, caret: next.caret };
  const already = kept.recipients.some((other) => other.toLowerCase() === name.toLowerCase());
  if (!already && kept.recipients.length >= MAX_RECIPIENTS) return null;
  return { draft: { text: next.text, recipients: already ? kept.recipients : [...kept.recipients, name] }, caret: next.caret };
}
