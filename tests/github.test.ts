import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { MAX_QUOTE_CHARS, notice, noticeLabels, quote, sign, verifySignature } from "../src/github";

const ADMIN = "test-admin-secret-000000000000000000000";

type Message = {
  id: number;
  username: string;
  text: string;
  replyTo?: number;
  labels?: Record<string, string>;
};

const call = (path: string, token?: string, init: RequestInit = {}) =>
  exports.default.fetch(`https://msn.test${path}`, {
    ...init,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...init.headers },
  });

const repository = { full_name: "TheHumanWorks/msn" };
const fixtures = {
  opened: {
    action: "opened",
    repository,
    sender: { login: "tomas" },
    pull_request: {
      number: 34,
      title: "Resume an agent",
      body: "Moves processing to a new machine.",
      html_url: "https://github.com/thehumanworks/msn/pull/34",
      head: { sha: "aaaaaaa1111111111111111111111111111111111" },
      merged: false,
    },
  },
  synchronize: {
    action: "synchronize",
    repository,
    sender: { login: "tomas" },
    pull_request: {
      number: 34,
      title: "Resume an agent",
      html_url: "https://github.com/thehumanworks/msn/pull/34",
      head: { sha: "bbbbbbb2222222222222222222222222222222222" },
    },
  },
  merged: {
    action: "closed",
    repository,
    sender: { login: "tomas" },
    pull_request: {
      number: 34,
      title: "Resume an agent",
      html_url: "https://github.com/thehumanworks/msn/pull/34",
      head: { sha: "bbbbbbb2222222222222222222222222222222222" },
      merged: true,
    },
  },
  review: {
    action: "submitted",
    repository,
    pull_request: { number: 34 },
    review: {
      state: "CHANGES_REQUESTED",
      body: "Please add a test for the retry.",
      user: { login: "reviewer" },
      html_url: "https://github.com/thehumanworks/msn/pull/34#pullrequestreview-1",
    },
  },
  emptyCommentReview: {
    action: "submitted",
    repository,
    pull_request: { number: 34 },
    review: { state: "COMMENTED", body: null, user: { login: "reviewer" }, html_url: "x" },
  },
  reviewComment: {
    action: "created",
    repository,
    pull_request: { number: 34 },
    comment: {
      path: "src/store.ts",
      line: 120,
      body: "Off by one?",
      user: { login: "reviewer" },
      html_url: "https://github.com/thehumanworks/msn/pull/34#discussion_r1",
    },
  },
  prComment: {
    action: "created",
    repository,
    issue: { number: 34, pull_request: { url: "https://api.github.com/repos/x/y/pulls/34" } },
    comment: {
      body: "LGTM once CI is green",
      user: { login: "tomas" },
      html_url: "https://github.com/thehumanworks/msn/pull/34#issuecomment-1",
    },
  },
  issueComment: {
    action: "created",
    repository,
    issue: { number: 7 },
    comment: { body: "plain issue", user: { login: "tomas" }, html_url: "x" },
  },
  workflow: {
    action: "completed",
    repository,
    sender: { login: "tomas" },
    workflow_run: {
      name: "ci",
      conclusion: "failure",
      head_sha: "bbbbbbb2222222222222222222222222222222222",
      html_url: "https://github.com/thehumanworks/msn/actions/runs/1",
      pull_requests: [{ number: 34 }],
    },
  },
  forkWorkflow: {
    action: "completed",
    repository,
    sender: { login: "contributor" },
    workflow_run: {
      name: "ci",
      conclusion: "success",
      head_sha: "bbbbbbb2222222222222222222222222222222222",
      html_url: "https://github.com/thehumanworks/msn/actions/runs/2",
      pull_requests: [],
    },
  },
};

describe("GitHub delivery parsing (ADR 0036)", () => {
  it("verifies GitHub's documented HMAC-SHA256 test vector", async () => {
    const body = new TextEncoder().encode("Hello, World!");
    const expected = "sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17";
    expect(await sign("It's a Secret to Everybody", body)).toBe(expected);
    expect(await verifySignature("It's a Secret to Everybody", body, expected)).toBe(true);
    expect(await verifySignature("wrong", body, expected)).toBe(false);
    expect(await verifySignature("It's a Secret to Everybody", body, null)).toBe(false);
    expect(await verifySignature("It's a Secret to Everybody", body, "sha1=abc")).toBe(false);
  });

  it("turns each followed event into one message with labels", () => {
    const pull = { repo: "thehumanworks/msn", number: 34 };
    const review = notice("pull_request_review", fixtures.review);
    expect(review).toMatchObject({ event: "review", state: "changes_requested", author: "reviewer" });
    expect(review?.text(pull)).toBe(
      "@reviewer requested changes on thehumanworks/msn#34\n\nPlease add a test for the retry.\n\nhttps://github.com/thehumanworks/msn/pull/34#pullrequestreview-1",
    );
    expect(review && noticeLabels(review, pull)).toEqual({
      "github.pr": "thehumanworks/msn#34",
      "github.event": "review",
      "github.state": "changes_requested",
      "github.author": "reviewer",
    });
    expect(notice("pull_request", fixtures.opened)?.text(pull)).toContain(
      "thehumanworks/msn#34 opened by @tomas: Resume an agent\n\nMoves processing",
    );
    expect(notice("pull_request", fixtures.opened)?.newHead?.sha).toMatch(/^aaaaaaa/);
    expect(notice("pull_request", fixtures.synchronize)).toMatchObject({ state: "pushed" });
    expect(notice("pull_request", fixtures.merged)).toMatchObject({ state: "merged" });
    expect(notice("pull_request_review_comment", fixtures.reviewComment)?.text(pull)).toContain(
      "@reviewer commented on src/store.ts:120 in thehumanworks/msn#34\n\nOff by one?",
    );
    expect(notice("issue_comment", fixtures.prComment)).toMatchObject({ event: "comment", author: "tomas" });
    expect(notice("workflow_run", fixtures.workflow)?.text(pull)).toBe(
      "ci failed on thehumanworks/msn#34 (bbbbbbb)\n\nhttps://github.com/thehumanworks/msn/actions/runs/1",
    );
    expect(notice("workflow_run", fixtures.forkWorkflow)).toMatchObject({
      pulls: [],
      headSha: expect.any(String),
    });
  });

  it("ignores events and actions a board does not follow", () => {
    expect(notice("pull_request_review", fixtures.emptyCommentReview)).toBeNull();
    expect(notice("issue_comment", fixtures.issueComment)).toBeNull();
    expect(notice("pull_request", { ...fixtures.opened, action: "labeled" })).toBeNull();
    expect(notice("workflow_run", { ...fixtures.workflow, action: "requested" })).toBeNull();
    expect(notice("push", { repository })).toBeNull();
    expect(notice("pull_request", { action: "opened" })).toBeNull();
  });

  it("strips control characters and caps quoted text under the message limit", () => {
    expect(quote("a\u0000b\r\nc\u0007")).toBe("ab\nc");
    expect(Array.from(quote("x".repeat(MAX_QUOTE_CHARS + 50))).length).toBe(MAX_QUOTE_CHARS + 1);
    const wide = quote("😀".repeat(MAX_QUOTE_CHARS));
    expect(new TextEncoder().encode(wide).length).toBeLessThanOrEqual(12 * 1024 + 3);
    const huge = { ...fixtures.review, review: { ...fixtures.review.review, body: "😀".repeat(20000) } };
    const text = notice("pull_request_review", huge)?.text({ repo: "thehumanworks/msn", number: 34 }) ?? "";
    expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(16384);
  });
});

async function workspace() {
  const name = `gh-${crypto.randomUUID()}`;
  const created = await call(`/api/admin/tenants/${name}`, ADMIN, { method: "PUT" });
  expect(created.status).toBe(201);
  const { token } = await created.json<{ token: string }>();
  const channel = `/api/tenants/${name}/channels/project`;
  const first = await call(`${channel}/messages`, token, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "lead", text: "start" }),
  });
  expect(first.status).toBe(201);
  return { name, token, channel };
}
type Workspace = Awaited<ReturnType<typeof workspace>>;

async function hook(w: Workspace) {
  const response = await call(`/api/tenants/${w.name}/github`, w.token);
  expect(response.status).toBe(200);
  return response.json<{ webhookUrl: string; secret: string; events: string[]; links: unknown[] }>();
}

async function deliver(w: Workspace, secret: string, event: string, data: unknown, id = crypto.randomUUID()) {
  const body = new TextEncoder().encode(JSON.stringify(data));
  return call(`/api/github/hooks/${w.name}`, undefined, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-GitHub-Event": event,
      "X-GitHub-Delivery": id,
      "X-Hub-Signature-256": await sign(secret, body),
    },
    body,
  });
}

async function messages(w: Workspace, query = "") {
  const response = await call(`${w.channel}/messages${query}`, w.token);
  expect(response.status).toBe(200);
  return (await response.json<{ messages: Message[] }>()).messages.filter((m) => m.username === "github");
}

const link = (w: Workspace, method = "PUT", pull = "TheHumanWorks/msn/34") =>
  call(`${w.channel}/github/pulls/${pull}`, w.token, { method });

describe("boards follow GitHub pull requests (ADR 0036)", () => {
  it("links a pull request with an anchor message and posts signed deliveries as replies", async () => {
    const w = await workspace();
    const { webhookUrl, secret, events } = await hook(w);
    expect(webhookUrl).toBe(`https://msn.test/api/github/hooks/${w.name}`);
    expect(secret).toMatch(/^[a-f0-9]{64}$/);
    expect(events).toContain("workflow_run");
    expect((await hook(w)).secret).toBe(secret);

    const linked = await link(w);
    expect(linked.status).toBe(201);
    const { link: row } = await linked.json<{ link: { repo: string; number: number; anchorId: number } }>();
    expect(row).toMatchObject({ repo: "thehumanworks/msn", number: 34 });
    const again = await link(w);
    expect(again.status).toBe(200);
    expect((await again.json<{ created: boolean }>()).created).toBe(false);
    const [anchor] = await messages(w);
    expect(anchor.id).toBe(row.anchorId);
    expect(anchor.labels).toMatchObject({ "github.pr": "thehumanworks/msn#34", "github.state": "following" });

    const id = crypto.randomUUID();
    const posted = await deliver(w, secret, "pull_request_review", fixtures.review, id);
    expect(posted.status).toBe(200);
    expect(await posted.json()).toEqual({ posted: 1, matched: 1 });
    // GitHub redelivers with the same delivery id: the message replays instead of duplicating.
    const replay = await deliver(w, secret, "pull_request_review", fixtures.review, id);
    expect(await replay.json()).toEqual({ posted: 0, matched: 1 });

    const all = await messages(w);
    expect(all).toHaveLength(2);
    expect(all[1]).toMatchObject({ replyTo: anchor.id, labels: { "github.state": "changes_requested" } });
    const filtered = await messages(w, "?label=github.state%3Dchanges_requested");
    expect(filtered.map((m) => m.id)).toEqual([all[1].id]);

    expect((await deliver(w, secret, "ping", { zen: "hi" })).status).toBe(200);
    const unlinked = await deliver(w, secret, "pull_request_review", {
      ...fixtures.review,
      pull_request: { number: 99 },
    });
    expect(unlinked.status).toBe(202);
    expect((await deliver(w, secret, "issue_comment", fixtures.issueComment)).status).toBe(202);
    expect(await messages(w)).toHaveLength(2);
  });

  it("matches fork workflow runs by the head commit of the last push", async () => {
    const w = await workspace();
    const { secret } = await hook(w);
    await link(w);
    expect((await deliver(w, secret, "workflow_run", fixtures.forkWorkflow)).status).toBe(202);
    await deliver(w, secret, "pull_request", fixtures.synchronize);
    const run = await deliver(w, secret, "workflow_run", fixtures.forkWorkflow);
    expect(await run.json()).toEqual({ posted: 1, matched: 1 });
    const last = (await messages(w)).at(-1);
    expect(last?.labels).toMatchObject({ "github.event": "workflow", "github.state": "success" });
  });

  it("rejects unsigned, wrongly signed and oversized deliveries without storing anything", async () => {
    const w = await workspace();
    const { secret } = await hook(w);
    await link(w);
    const body = JSON.stringify(fixtures.review);
    const unsigned = await call(`/api/github/hooks/${w.name}`, undefined, {
      method: "POST",
      headers: { "X-GitHub-Event": "pull_request_review", "X-GitHub-Delivery": "d1" },
      body,
    });
    expect(unsigned.status).toBe(401);
    expect((await deliver(w, "f".repeat(64), "pull_request_review", fixtures.review)).status).toBe(401);
    const big = new Uint8Array(1024 * 1024 + 1);
    const oversized = await call(`/api/github/hooks/${w.name}`, undefined, {
      method: "POST",
      headers: { "X-GitHub-Event": "ping", "X-Hub-Signature-256": await sign(secret, big) },
      body: big,
    });
    expect(oversized.status).toBe(413);
    expect(await messages(w)).toHaveLength(1);
  });

  it("answers 404 until the owner reads the webhook secret", async () => {
    const w = await workspace();
    const response = await deliver(w, "f".repeat(64), "ping", {});
    expect(response.status).toBe(404);
    expect(
      (await call(`/api/github/hooks/nobody-${crypto.randomUUID()}`, undefined, { method: "POST" })).status,
    ).toBe(404);
  });

  it("keeps linking and the secret to the owner, and rotation cuts old signatures", async () => {
    const w = await workspace();
    const { secret } = await hook(w);
    const key = await call(`/api/admin/tenants/${w.name}/keys/agent`, ADMIN, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "agent" }),
    });
    const { token: agent } = await key.json<{ token: string }>();
    expect((await call(`/api/tenants/${w.name}/github`, agent)).status).toBe(403);
    expect(
      (await call(`${w.channel}/github/pulls/thehumanworks/msn/34`, agent, { method: "PUT" })).status,
    ).toBe(403);
    expect(
      (await call(`${w.channel}/github/pulls/bad owner/msn/34`, w.token, { method: "PUT" })).status,
    ).toBe(400);
    expect(
      (await call(`${w.channel}/github/pulls/thehumanworks/msn/0`, w.token, { method: "PUT" })).status,
    ).toBe(400);
    expect(
      (await call(`/api/tenants/${w.name}/channels/missing/github/pulls/a/b/1`, w.token, { method: "PUT" }))
        .status,
    ).toBe(404);

    await link(w);
    const rotated = await call(`/api/tenants/${w.name}/github/secret`, w.token, { method: "POST" });
    const fresh = (await rotated.json<{ secret: string }>()).secret;
    expect(fresh).not.toBe(secret);
    expect((await deliver(w, secret, "pull_request_review", fixtures.review)).status).toBe(401);
    expect((await deliver(w, fresh, "pull_request_review", fixtures.review)).status).toBe(200);

    expect((await link(w, "DELETE")).status).toBe(204);
    expect((await deliver(w, fresh, "pull_request_review", fixtures.review)).status).toBe(202);
    expect((await hook(w)).links).toEqual([]);
  });

  it("drops the webhook secret when the admin rotates the workspace credential", async () => {
    const w = await workspace();
    const { secret } = await hook(w);
    const rotated = await call(`/api/admin/tenants/${w.name}/token`, ADMIN, { method: "POST" });
    expect(rotated.status).toBe(200);
    expect((await deliver(w, secret, "ping", {})).status).toBe(404);
  });
});
