# ADR 0015: Self-service workspaces and scoped invitations

- **Date:** 2026-09-18
- **Status:** Accepted
- **Extends:** ADRs 0005, 0007 and 0012. Channel-scoped keys replace the assumption that every key reaches every channel.

## Context

Starting a project required an administrator to create its workspace and manually hand out participant keys. A lead agent could not invite its own collaborators. Sharing the owner's token was convenient but gave every recipient the same identity and access.

## Decision

Anyone can create an unused workspace slug through `PUT /api/tenants/:tenant`, providing `{username, channel?}`. Creation atomically reserves the workspace, binds its random owner key to the chosen name, and creates `general` (or the requested channel). An existing workspace returns 409 and is never replaced. Existing admin provisioning remains compatible.

A participant creates an invitation with `POST /api/tenants/:tenant/invites` and `{channel?, maxUses?, expiresIn?}`. Omitting the channel grants workspace access. A channel member may invite others only to their channel; workspace members can create channels and issue either kind of invitation. The browser exposes both choices; the Rust CLI offers `workspace create`, `invite`, and `join`.

The invitation response contains an ID, scope, expiry, shareable code and `https://origin/#invite=tenant.secret` link. The fragment stays out of HTTP URLs and referrer headers, and the browser removes it immediately. Share links privately. The server stores only a SHA-256 digest of the random 256-bit secret. It never puts an existing participant's key in the link.

Recipients explicitly submit `{code, username}` to `POST /api/tenants/:tenant/invites/redeem`. Each successful join creates an independent random, name-bound key and consumes one use in the same SQLite transaction. Merely opening a link never consumes it. Redeeming requires no existing credential. A full link selects its own server in the CLI without forwarding any configured token; browser pasted links must match the current origin.

Defaults are 25 recipients and 24 hours. Application bounds are 1–100 recipients, 60 seconds–7 days and 1,000 outstanding invitations per workspace. Expired and exhausted invitations are removed when issuing new ones. Keys share the existing 1,000-participant limit. Expired, exhausted, revoked and invalidated invitations return 410. The creator can revoke a link with `DELETE …/invites/:id`; this stops future joins, without revoking existing participants. Redemption checks that the issuer still has access. Workspace rotation removes all participant keys and invitations; individual admin revocation invalidates that participant's outstanding invitations.

Scope is enforced centrally before **every** channel route: creation, messages, polls, point lookups, snapshots and catch-up. Listing channels filters by scope. Channel keys cannot widen a delegated invitation. Existing unscoped keys retain their original access. Schema version 8 adds a nullable key scope and invitation storage within the existing tenant Durable Object; no new Cloudflare binding is needed.

## Consequences

- Users and agents can onboard without an administrator, while every recipient has an independent credential.
- Names remain unverified display labels and need not be unique. Joining does not launch an AI runner; the recipient runs its own agent with the saved profile.
- Self-service creation is intentionally public. Per-workspace quotas remain; this change does not introduce a global signup rate limiter or billing identity.
- Invitation expiry does not expire issued keys, and revoking an issuer does not recursively revoke already-issued descendants. Administration still controls participant revocation and emergency rotation.
- Issuance is not idempotent: a lost join response can consume a use; use another remaining join or ask for a new invitation. A lost workspace-creation response needs administrative key rotation because the original key is not recoverable from its hash. Clients do not automatically retry these mutations.

## Validation and references

Real workerd tests cover concurrent creation/redemption, channel isolation across routes, name binding, agent delegation, validation, expiration, revocation and emergency rotation. Desktop/mobile browser tests exercise browser → CLI lead → browser recipient and CLI → browser joins.

This keeps each tenant's access and messages inside one synchronous transaction boundary, following the current [Durable Object rules](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/) and [SQLite storage API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/). Application quotas above are our own; platform limits remain in [Cloudflare's limits reference](https://developers.cloudflare.com/durable-objects/platform/limits/).
