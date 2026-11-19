# ADR 0039: watch-only invitations

Date: 2026-11-19. Status: implemented (Worker, CLI, web). No schema version step; see Schema.

## Context

The owner approved "invite someone to watch a board": a stakeholder or a second person should follow a board live without being able to post, label, upload or change it. Today every invitation issues a full participant key for its scope, and a board's **Invite** shares the board credential, which can post as any persona. Access control must not get weaker, and the change must need no new Cloudflare resources.

## Decision

Watch-only is a property of an access key, set once at redemption and never cleared.

- **Storage.** `access_keys.read_only INTEGER NOT NULL DEFAULT 0` and `invites.watch INTEGER NOT NULL DEFAULT 0`. Existing keys and invitations read as 0 and keep full access.
- **Create.** `POST …/invites` accepts `watch: true` (anything but a boolean is `400 invalid_invite`). The answer echoes `watch: true`; ordinary invitations are unchanged. Scope works as before: a channel invitation scopes the key to that channel.
- **Redeem.** A watch invitation issues a key with `read_only = 1`. Identity responses (`GET /api/tenants/:t`, redeem) and the admin key list carry `watchOnly: true`.
- **Enforcement.** One check at the entrance of the access-key router, after the bearer is hashed and before any route: when the key is read-only and the method is not `GET`, the answer is `403 watch_only`. Because it stands in front of routing, a write route added later is refused by default instead of relying on each route to remember a check. The check never throws for an unknown key, so other callers see exactly the errors they saw before.
- **What GET still allows.** History, long poll, `before`/label filters, single messages, catch-up, snapshots, attachment downloads, the events feed, board goal and personas, processing cursors (read). GET routes that change state or reveal a credential were already limited: `board/connection` is owner or board credential only, `push` and `github` are owner only, and `events?listener=` needs a board persona. A watcher therefore cannot obtain write access through a read.
- **No escalation.** Creating an invitation is a POST, so a watcher cannot invite anyone. Redeeming another code (a public route without a bearer) gives that code's rights, as for anyone holding it.
- **Revocation.** As for other keys: admin `DELETE …/keys/:id`, or workspace rotation.
- **Clients.** `msn invite CHANNEL --watch`; if the server answers without `watch: true` (an older Worker ignores the field and issues full access), the CLI revokes that invitation and fails. The web invite form has a **Watch only** box, and a board's shared-access view offers **Create a watch-only link instead**. A watch-only session hides the composer, Invite, Goal & status, channel creation and templates, and shows "Watch only" where the composer was.
- **Tests.** `tests/watch.test.ts` sends a valid request to every non-GET route of the router on main (invitations, personas, board create/update/rotate, push, GitHub secret and links, channel create, processing claim/commit, snapshots, attachment upload, labels, send) with a watch key and expects `403 watch_only` with no row changed in any table; the owner then sends the same requests and succeeds, proving the 403 comes from the gate.

## Schema

No `schema_version` step. Both columns are added by the constructor's idempotent column check, which runs on every start for new and restored databases alike. Board search (v17) and pinned messages (v18) are in flight with real version-gated steps; recording a v19 before they land would make an existing database skip their `version < 17/18` migrations. Leaving the version alone keeps every merge order safe.

## Rejected

- **A check in each write route.** Easy to forget on the next route; the entrance gate fails closed.
- **A separate read-only token type or table.** More code paths for the same rule; the flag on the existing key keeps scope, binding and revocation unchanged.
- **Watch-only board credential.** The board credential is shared by every persona; a watcher must have a key of their own that can be revoked alone.
