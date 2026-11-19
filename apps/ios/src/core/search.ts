import type { ApiClient } from "./apiClient.ts";
import { Store } from "./store.ts";
import type { Message } from "./types.ts";

/**
 * Splits what a person typed into search words and a `from:name` sender, like the web and desktop
 * search boxes. The last `from:` wins; everything else is sent as the search text.
 */
export function parseSearch(input: string): { q: string; from: string } {
  let from = "";
  const words: string[] = [];
  for (const word of input.split(/\s+/).filter(Boolean)) {
    if (word.startsWith("from:") && word.length > 5) from = word.slice(5);
    else words.push(word);
  }
  return { q: words.join(" "), from };
}

export type SearchState = {
  /** A search has been asked for; false shows the hint instead of results. */
  active: boolean;
  q: string;
  from: string;
  results: Message[];
  hasMore: boolean;
  nextBefore?: number;
  complete: boolean;
  loading: boolean;
  error: string | null;
};

const IDLE: SearchState = {
  active: false,
  q: "",
  from: "",
  results: [],
  hasMore: false,
  complete: true,
  loading: false,
  error: null,
};

type Searcher = Pick<ApiClient, "searchMessages">;

/** One channel's search view (ADR 0037). A newer search cancels the older one's answer. */
export class ChannelSearch {
  readonly state = new Store<SearchState>(IDLE);
  private request = 0;
  private abort: AbortController | null = null;

  private readonly api: Searcher;
  private readonly channel: string;

  constructor(api: Searcher, channel: string) {
    this.api = api;
    this.channel = channel;
  }

  search(input: string): Promise<void> {
    const { q, from } = parseSearch(input);
    this.cancel();
    if (!q && !from) {
      this.state.set(IDLE);
      return Promise.resolve();
    }
    this.state.set({ ...IDLE, active: true, q, from });
    return this.load();
  }

  older(): Promise<void> {
    const current = this.state.get();
    if (!current.hasMore || current.loading || current.nextBefore === undefined) return Promise.resolve();
    return this.load(current.nextBefore);
  }

  clear(): void {
    this.cancel();
    this.state.set(IDLE);
  }

  /** Stops any request in flight; call when the view goes away. */
  cancel(): void {
    this.request++;
    this.abort?.abort();
    this.abort = null;
  }

  private async load(before?: number): Promise<void> {
    const request = ++this.request;
    const abort = new AbortController();
    this.abort = abort;
    const { q, from } = this.state.get();
    this.state.update({ loading: true, error: null });
    try {
      const page = await this.api.searchMessages(this.channel, { q, from, before, limit: 20 }, abort.signal);
      if (request !== this.request) return;
      const current = this.state.get();
      this.state.set({
        ...current,
        results: [...current.results, ...page.messages],
        hasMore: page.hasMore,
        nextBefore: page.nextBefore,
        complete: page.complete,
        loading: false,
      });
    } catch (error) {
      if (request !== this.request) return;
      this.state.update({ loading: false, error: error instanceof Error ? error.message : String(error) });
    }
  }
}

/** "3 messages matching “deploy” from ada, newest first", as the web app words it. */
export function searchSummary(state: SearchState): string {
  const count = state.results.length;
  let summary = `${count}${state.hasMore ? "+" : ""} message${count === 1 ? "" : "s"} matching`;
  if (state.q) summary += ` “${state.q}”`;
  if (state.from) summary += ` from ${state.from}`;
  summary += ", newest first";
  if (!state.complete) summary += " · older messages are still being indexed";
  return summary;
}
