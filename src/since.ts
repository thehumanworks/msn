// "Since you last looked" for agents (ADR 0061). The rows come from the same pure module the web
// client uses (public/since.js, ADR 0033), so an agent and a person reading the same range get the
// same list. This file only adds what the web panel does not show: where the summary starts, the
// board head, and messages whose labels changed.

import { headline, SINCE_ITEMS, SINCE_PAGES, summarize } from "../public/since.js";

/** Messages read after the starting point: the same 3 pages of 100 the web panel reads. */
export const SINCE_MESSAGES = SINCE_PAGES * 100;
/** Newest channel events scanned for label changes; older changes are reported as truncated. */
export const SINCE_EVENTS = 2000;
/** Labeled messages listed before the rest are counted in `hidden`. */
export const SINCE_LABELS = SINCE_ITEMS;
/** Ids per IN (...) lookup; a Durable Object's SQLite takes at most 100 bound parameters. */
export const SINCE_LABEL_BATCH = 90;
/** Plain-text messages are read only this far: rows show a 120-character excerpt. */
export const SINCE_TEXT_CHARS = 512;

/** Where the summary starts. `processing` is the reader's server commit (ADR 0034/0053). */
export type SinceSource = "processing" | "after" | "start";

export type SinceMessage = {
  id: number;
  username: string;
  text: string;
  contentType: string;
  to?: string;
  personaId?: string;
};

export type LabelChange = {
  id: number;
  username: string;
  changes: number;
  labels: Record<string, string>;
};

export function sinceSummary(input: {
  channel: string;
  reader: string;
  /** The display name the rows call "you": the reader's persona, or the reader itself. */
  name: string;
  /** The reader's board persona, whose messages are the reader's own whatever their name. */
  personaId: string | null;
  source: SinceSource;
  after: number;
  head: number;
  messages: SinceMessage[];
  truncated: boolean;
  /** The SINCE_LABELS most changed messages, most changed first. */
  labels: LabelChange[];
  labelsHidden: number;
  labelChanges: number;
  labelsTruncated: boolean;
}) {
  const summary = summarize(input.messages, {
    after: input.after,
    me: input.name,
    personaId: input.personaId,
    truncated: input.truncated,
  });
  // The reader's own label changes are news too: the event journal does not record who changed
  // a label, so nothing here can tell them apart.
  const lastId = input.truncated ? (input.messages.at(-1)?.id ?? input.after) : input.head;
  return {
    channel: input.channel,
    reader: input.reader,
    name: input.name,
    from: { source: input.source, after: input.after },
    head: input.head,
    // The last message the summary read: the head unless more than SINCE_MESSAGES are new.
    lastId,
    headline: headline(summary),
    count: summary.count,
    truncated: summary.truncated,
    authors: summary.authors,
    firstId: summary.firstId,
    items: summary.items,
    hidden: summary.hidden,
    labels: {
      messages: input.labels.slice(0, SINCE_LABELS),
      hidden: Math.max(0, input.labelsHidden),
      changes: input.labelChanges,
      truncated: input.labelsTruncated,
    },
  };
}
