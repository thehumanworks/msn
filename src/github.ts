import type { Labels } from "./http";
import { HttpError } from "./http";

/** GitHub deliveries are bounded well below its own 25 MB cap; pull request payloads are far smaller. */
export const MAX_WEBHOOK_BYTES = 1024 * 1024;
/** GitHub text quoted in a board message, in characters; the link always leads to the rest. */
export const MAX_QUOTE_CHARS = 4000;
/** Byte cap for one quote, so title, body and link stay under the 16 KiB message limit. */
const MAX_QUOTE_BYTES = 12 * 1024;
/** Pull requests followed per workspace, across all boards. */
export const MAX_GITHUB_LINKS = 200;
/** Display name of board messages that come from GitHub. */
export const GITHUB_SENDER = "github";

export type PullRef = { repo: string; number: number };
/** One board message derived from one GitHub delivery. */
export type GithubNotice = {
  /** Pull requests this delivery is about; a workflow run may name none and match by `headSha`. */
  pulls: PullRef[];
  /** Repository the delivery came from (lowercase `owner/name`). */
  repo: string;
  /** Head commit, when the delivery names one, to match workflow runs from forks. */
  headSha?: string;
  /** New head commit of a pull request; stored so later workflow runs on it can be matched. */
  newHead?: { number: number; sha: string };
  event: "pull_request" | "review" | "review_comment" | "comment" | "workflow";
  state: string;
  author: string;
  url: string;
  /** Message text before the `owner/repo#N` reference is filled in per pull request. */
  text: (pull: PullRef) => string;
};

const OWNER = /^[a-z0-9](?:[a-z0-9-]{0,38})$/;
const REPO = /^[a-z0-9._-]{1,100}$/;

/** `owner/name`, lowercased: GitHub treats repository names case-insensitively. */
export function repoName(owner: string, name: string): string {
  const repo = `${owner}/${name}`.toLowerCase();
  const [o, n] = repo.split("/");
  if (!OWNER.test(o) || !REPO.test(n) || n === "." || n === "..")
    throw new HttpError(400, "invalid_repository", "Use a GitHub repository as owner/name.");
  return repo;
}

export function pullNumber(value: string): number {
  if (!/^[1-9]\d{0,9}$/.test(value))
    throw new HttpError(400, "invalid_pull_request", "Use the pull request number, such as 34.");
  return Number(value);
}

/** Reads at most `MAX_WEBHOOK_BYTES`, without trusting Content-Length. */
export async function readDelivery(request: Request): Promise<Uint8Array> {
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_WEBHOOK_BYTES) {
        await reader.cancel();
        throw new HttpError(413, "body_too_large", "GitHub deliveries above 1 MiB are not accepted.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function hex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** `sha256=<hex>` as GitHub sends it in `X-Hub-Signature-256`. */
export async function sign(secret: string, body: Uint8Array): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return `sha256=${hex(await crypto.subtle.sign("HMAC", key, body))}`;
}

/** Constant-time check of GitHub's HMAC-SHA256 signature over the exact delivered bytes. */
export async function verifySignature(
  secret: string,
  body: Uint8Array,
  header: string | null,
): Promise<boolean> {
  if (!header || !/^sha256=[0-9a-f]{64}$/.test(header)) return false;
  const expected = new TextEncoder().encode(await sign(secret, body));
  return crypto.subtle.timingSafeEqual(expected, new TextEncoder().encode(header));
}

type Json = Record<string, unknown>;
const object = (value: unknown): Json =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {};
const string = (value: unknown): string => (typeof value === "string" ? value : "");
const login = (value: unknown): string => string(object(value).login) || "someone";

const control = (c: string) => {
  const code = c.charCodeAt(0);
  return code < 0x20 || (code >= 0x7f && code <= 0x9f);
};

/** Strips control characters (except newline and tab) and caps quoted GitHub text. */
export function quote(value: unknown, maxChars = MAX_QUOTE_CHARS): string {
  const clean = string(value)
    .replace(/\r\n?/g, "\n")
    .split("")
    .filter((c) => c === "\n" || c === "\t" || !control(c))
    .join("")
    .trim();
  let chars = Array.from(clean);
  if (chars.length <= maxChars && new TextEncoder().encode(clean).length <= MAX_QUOTE_BYTES) return clean;
  chars = chars.slice(0, maxChars);
  while (new TextEncoder().encode(chars.join("")).length > MAX_QUOTE_BYTES) chars = chars.slice(0, -256);
  return `${chars.join("")}…`;
}

/** One line for labels: no control characters, at most 256 UTF-8 bytes. */
function labelValue(value: string): string {
  let clean =
    Array.from(value, (c) => (control(c) ? " " : c))
      .join("")
      .trim() || "unknown";
  while (new TextEncoder().encode(clean).length > 256) clean = Array.from(clean).slice(0, -1).join("");
  return clean;
}

function compose(head: string, body: string, url: string): string {
  return [head, body, url].filter(Boolean).join("\n\n");
}

const ref = (pull: PullRef) => `${pull.repo}#${pull.number}`;

/**
 * Turns one GitHub delivery into at most one board message, or `null` when the event or action
 * is not one a board follows. Pure: no I/O, so fixtures cover every shape.
 */
export function notice(event: string, payload: Json): GithubNotice | null {
  const repo = string(object(payload.repository).full_name).toLowerCase();
  if (!repo.includes("/")) return null;
  const action = string(payload.action);
  if (event === "pull_request") {
    const pr = object(payload.pull_request);
    const number = Number(pr.number);
    if (!Number.isSafeInteger(number) || number < 1) return null;
    const merged = pr.merged === true;
    const states: Record<string, string> = {
      opened: "opened",
      reopened: "reopened",
      closed: merged ? "merged" : "closed",
      synchronize: "pushed",
      ready_for_review: "ready_for_review",
      converted_to_draft: "draft",
    };
    const state = states[action];
    if (!state) return null;
    const sha = string(object(pr.head).sha);
    const author = login(payload.sender);
    const title = quote(pr.title, 256).replace(/\s+/g, " ");
    const verbs: Record<string, string> = {
      opened: "opened",
      reopened: "reopened",
      merged: "merged",
      closed: "closed without merging",
      pushed: `got new commits (head ${sha.slice(0, 7)})`,
      ready_for_review: "is ready for review",
      draft: "was turned back into a draft",
    };
    return {
      pulls: [{ repo, number }],
      repo,
      ...(sha ? { headSha: sha, newHead: { number, sha } } : {}),
      event: "pull_request",
      state,
      author,
      url: string(pr.html_url),
      text: (pull) =>
        compose(
          `${ref(pull)} ${verbs[state]} by @${author}: ${title}`,
          state === "opened" ? quote(pr.body) : "",
          string(pr.html_url),
        ),
    };
  }
  if (event === "pull_request_review") {
    if (action !== "submitted") return null;
    const review = object(payload.review);
    const number = Number(object(payload.pull_request).number);
    if (!Number.isSafeInteger(number) || number < 1) return null;
    const state = string(review.state).toLowerCase();
    const body = quote(review.body);
    // Line comments of a batched review arrive as their own deliveries; an empty "commented"
    // review would only repeat them.
    if (!["approved", "changes_requested", "commented"].includes(state)) return null;
    if (state === "commented" && !body) return null;
    const author = login(review.user);
    const words: Record<string, string> = {
      approved: "approved",
      changes_requested: "requested changes on",
      commented: "reviewed",
    };
    return {
      pulls: [{ repo, number }],
      repo,
      event: "review",
      state,
      author,
      url: string(review.html_url),
      text: (pull) => compose(`@${author} ${words[state]} ${ref(pull)}`, body, string(review.html_url)),
    };
  }
  if (event === "pull_request_review_comment") {
    if (action !== "created") return null;
    const comment = object(payload.comment);
    const number = Number(object(payload.pull_request).number);
    if (!Number.isSafeInteger(number) || number < 1) return null;
    const author = login(comment.user);
    const line = comment.line ?? comment.original_line;
    const where = `${quote(comment.path, 256)}${typeof line === "number" ? `:${line}` : ""}`;
    return {
      pulls: [{ repo, number }],
      repo,
      event: "review_comment",
      state: "commented",
      author,
      url: string(comment.html_url),
      text: (pull) =>
        compose(
          `@${author} commented on ${where} in ${ref(pull)}`,
          quote(comment.body),
          string(comment.html_url),
        ),
    };
  }
  if (event === "issue_comment") {
    const issue = object(payload.issue);
    // Issue comments on plain issues are not about a pull request.
    if (action !== "created" || !issue.pull_request) return null;
    const number = Number(issue.number);
    if (!Number.isSafeInteger(number) || number < 1) return null;
    const comment = object(payload.comment);
    const author = login(comment.user);
    return {
      pulls: [{ repo, number }],
      repo,
      event: "comment",
      state: "commented",
      author,
      url: string(comment.html_url),
      text: (pull) =>
        compose(`@${author} commented on ${ref(pull)}`, quote(comment.body), string(comment.html_url)),
    };
  }
  if (event === "workflow_run") {
    if (action !== "completed") return null;
    const run = object(payload.workflow_run);
    const conclusion = string(run.conclusion) || "unknown";
    const pulls: PullRef[] = [];
    for (const entry of Array.isArray(run.pull_requests) ? run.pull_requests : []) {
      const number = Number(object(entry).number);
      // pull_requests lists only pull requests whose base is this repository.
      if (Number.isSafeInteger(number) && number > 0) pulls.push({ repo, number });
    }
    const sha = string(run.head_sha);
    const name = quote(run.name, 128).replace(/\s+/g, " ") || "Workflow";
    const words: Record<string, string> = {
      success: "passed",
      failure: "failed",
      cancelled: "was cancelled",
      timed_out: "timed out",
      action_required: "needs approval",
      skipped: "was skipped",
      neutral: "finished (neutral)",
      stale: "went stale",
      startup_failure: "failed to start",
    };
    return {
      pulls,
      repo,
      ...(sha ? { headSha: sha } : {}),
      event: "workflow",
      state: conclusion,
      author: login(payload.sender),
      url: string(run.html_url),
      text: (pull) =>
        compose(
          `${name} ${words[conclusion] ?? `finished: ${conclusion}`} on ${ref(pull)} (${sha.slice(0, 7)})`,
          "",
          string(run.html_url),
        ),
    };
  }
  return null;
}

/** Labels on every GitHub board message, so agents can filter and wait on them (ADR 0032). */
export function noticeLabels(item: GithubNotice, pull: PullRef): Labels {
  return {
    "github.pr": labelValue(ref(pull)),
    "github.event": item.event,
    "github.state": labelValue(item.state),
    "github.author": labelValue(item.author),
  };
}
