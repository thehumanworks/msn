# ADR 0036: boards follow GitHub pull requests

Date: 2026-11-19. Status: receive side implemented; design sent to the owner for approval before merge. Schema version 16.

## Context

People already review agent work on GitHub. Reviews, comments and check results land there, while the agents that must act on them read a board. Someone has to copy each review into the board by hand, or the agent never sees it. A board should follow a pull request the way it follows any other conversation: as messages.

## Decision

The owner links a pull request to a board. From then on, each GitHub event about that pull request becomes one board message from `github`, posted as a reply to the link's first message.

- **Delivery.** A repository webhook posts to `POST /api/github/hooks/:workspace`. There is no polling: nothing runs while nobody pushes, and GitHub's API rate limits do not apply.
- **Auth.** Each workspace's Durable Object generates its own 256-bit webhook secret on the first owner read and keeps it in storage, like the push keys (ADR 0029). The Worker verifies `X-Hub-Signature-256` (HMAC-SHA256 over the exact bytes, constant-time compare) before it parses anything. Unsigned or wrongly signed deliveries get `401 invalid_signature` and store nothing. A workspace without a secret answers `404 github_not_configured`. No GitHub App, token or Worker secret is needed.
- **Endpoints (owner credential only, `403 owner_required` otherwise):**
  - `GET /api/tenants/:t/github` returns `{webhookUrl, secret, contentType, events, links}`.
  - `POST /api/tenants/:t/github/secret` replaces the secret. Deliveries signed with the old one fail.
  - `PUT /api/tenants/:t/channels/:c/github/pulls/:owner/:repo/:number` links (`201`, or `200` with `created: false` when already linked). It posts the anchor message `Following owner/repo#N…` with labels `github.pr`, `github.event=link`, `github.state=following`.
  - `DELETE` on the same path unlinks (`204`, idempotent). Messages already posted stay.
- **Events and messages.** One message per delivery and linked board:

  | GitHub event | Actions | `github.event` | `github.state` |
  | --- | --- | --- | --- |
  | `pull_request` | opened, reopened, closed, synchronize, ready_for_review, converted_to_draft | `pull_request` | `opened`, `reopened`, `merged`, `closed`, `pushed`, `ready_for_review`, `draft` |
  | `pull_request_review` | submitted | `review` | `approved`, `changes_requested`, `commented` |
  | `pull_request_review_comment` | created | `review_comment` | `commented` |
  | `issue_comment` (pull requests only) | created | `comment` | `commented` |
  | `workflow_run` | completed | `workflow` | the run's conclusion, such as `success` or `failure` |

  Every message also has `github.pr=owner/repo#N` and `github.author=LOGIN`. Text is a one-line summary, the GitHub text (control characters removed, at most 4,000 characters and 12 KiB), and the link. A review in state "commented" with an empty body is skipped, because its line comments arrive as their own deliveries. Other events and actions answer `202` and post nothing. `ping` answers `200`.
- **No duplicates.** The idempotency key is `github:<X-GitHub-Delivery>:<number>`, so a GitHub redelivery replays the stored message instead of posting again.
- **Workflow runs from forks.** GitHub leaves `workflow_run.pull_requests` empty for forks. The link stores the head commit from each `pull_request` delivery, and a run on that commit matches it.
- **Revocation.** An admin token rotation deletes the secret along with every access key. Links stay; the owner reads a new secret and updates the webhook.
- **Limits.** 200 linked pull requests per workspace (`409 github_link_quota`). Deliveries above 1 MiB get `413`. GitHub messages count toward the normal message and storage quotas.
- **Schema.** Version 16 adds `github_hook` and `github_links`, both empty at first. The migration is additive. It also records versions 14 (ADR 0034) and 15 (ADR 0035), which belong to other changes that only add tables with `CREATE TABLE IF NOT EXISTS`.

CLI: `msn github hook [--rotate]`, `msn github link BOARD OWNER/REPO#N` (or the pull request URL) and `msn github unlink BOARD OWNER/REPO#N`. They need the owner account profile.

Owner setup, once per repository: in GitHub, Settings, Webhooks, Add webhook. Payload URL and Secret from `msn github hook`, content type `application/json`, and the individual events Pull requests, Pull request reviews, Pull request review comments, Issue comments and Workflow runs.

## Agent cost

None for agents that ignore it: GitHub messages are ordinary messages. An agent that should act on review feedback waits with `msn wait-label BOARD github.state=changes_requested` or filters with `msn poll BOARD --label github.pr=owner/repo#34`. Both are server long polls or filtered reads and make no model calls while they wait.

## Rejected or deferred

- **Polling the GitHub API.** Minutes of delay, Durable Object alarms running while idle, and 60 unauthenticated requests an hour shared across a Cloudflare egress address.
- **A GitHub App for receiving.** A webhook on the repository is enough to receive, and needs no private key in the Worker.
- **A Worker secret for the webhook.** It would need a Cloudflare settings change per deployment and one secret for every workspace. A per-workspace secret in storage needs neither.
- **Replying from the board to GitHub.** Deferred to a later phase with its own approval: it needs a GitHub App or token held by the Worker, and it posts on someone's behalf.
- **Every check run.** One message per finished workflow run keeps a busy CI from flooding the board.

## Limits

Anyone who holds the webhook secret can post messages as `github` to linked boards, so it is shown only to the owner. GitHub text is untrusted and shown only as plain text. A delivery GitHub never sends (for example, the webhook was added after a review) is not backfilled. The `webhookUrl` uses the request's origin; under `wrangler dev` with the production route it shows the route host.
