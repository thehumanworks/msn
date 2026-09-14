# msn

Bidirectional channel messaging for humans and agents, backed by Cloudflare SQLite Durable Objects. A responsive browser inbox and a zero-runtime-dependency Node CLI use the same JSON HTTP API.

- **Workspace isolation:** one object per tenant, random tenant access keys, independent concurrent tenants.
- **Channels, not queues:** all readers receive a copy. Reads never consume; any reader can send a reply.
- **Durable history:** ordered cursors, pagination, single poll, bounded long poll, reread and safe send retries.
- **No user login:** choose any display username. A workspace key controls access, not identity.
- **Restricted deletion:** a separate admin secret and `/api/admin/…` endpoints; no browser admin key.

## Run locally

Requires Node 22+ and Bun. No runtime application dependencies.

```sh
bun install --frozen-lockfile
# Start locally with the deliberately non-production example secret:
set -a; . ./.dev.vars.example; set +a
bun run dev
```

In another shell, provision a local workspace:

```sh
export MSN_URL=http://localhost:8787
export MSN_ADMIN_TOKEN=local-development-admin-token-at-least-32-characters
node scripts/msn.mjs provision team
```

Save the returned `token` securely. Open http://localhost:8787, enter workspace `team`, that **tenant** key and any display name. Create a channel and start chatting. Workspace keys stay in browser memory only; disconnect/reload clears them. Drafts and uncertain-send retry keys stay scoped to their channel for the connection's lifetime. Editing the payload starts a new logical send; do not reload if you need to retry an uncertain send.

## Agents

```sh
export MSN_URL=https://YOUR-WORKER.workers.dev
export MSN_TENANT=team
read -rs -p 'Workspace key: ' MSN_TOKEN; echo; export MSN_TOKEN
export MSN_USERNAME=planner-agent

node scripts/msn.mjs create general
node scripts/msn.mjs send general --text 'Ready for review' --key task-42-review
node scripts/msn.mjs poll general --after 0             # one immediate page
node scripts/msn.mjs poll general --after 1 --wait 25   # one long poll
node scripts/msn.mjs follow general --cursor-file ./planner-cursor.json
node scripts/msn.mjs --help
```

`send` prints its retry key to stderr and JSON to stdout. On an uncertain result, retry with the **same `--key` and payload**. `follow` emits one JSON message per line, reconnects with exponential backoff on transient errors, and exits on authentication/client errors. Ctrl+C cancels polling. Cursor files are atomically replaced, mode 0600, and bound to origin/tenant/channel. Use one file per reader process. Delivery to a downstream consumer is not an exactly-once acknowledgment protocol; a crash can replay output, so deduplicate by tenant/channel/id when needed. Browser Live reconnects similarly. Browsers are same-origin only; server-side agents can call from anywhere over HTTPS.

The deployed `/guide.html` is a public curl/agent quickstart.

## HTTP contract

Normal endpoints require `Authorization: Bearer <tenant-key>`. JSON writes require `Content-Type: application/json`. Never put keys in query strings. Identifiers are 1–64 lowercase ASCII letters/digits/`_`/`-`, starting with a letter or digit.

| Method | Endpoint | Behavior |
| --- | --- | --- |
| GET | `/api/health` | Public liveness, `{ok:true,service:"msn"}` |
| GET | `/api/tenants/:tenant/channels?after=&limit=100` | Lexicographically paginated `{channels:[{name,createdAt}],nextCursor,hasMore}`; max 1,000/page |
| PUT | `/api/tenants/:tenant/channels/:channel` | Idempotent create, 201 or 200 |
| POST | `/api/tenants/:tenant/channels/:channel/messages` | `{username,text}`; creates channel automatically; 201 `{message,replayed:false}` |
| GET | `/api/tenants/:tenant/channels/:channel/messages?after=0&limit=100&wait=0` | Ordered `{messages,nextCursor,hasMore}`; `wait` 0–25 seconds |
| PUT | `/api/admin/tenants/:tenant` | **Admin only.** Provision once; 201 `{tenant,token}`, existing tenant 409 |
| POST | `/api/admin/tenants/:tenant/token` | **Admin only.** Rotate and return a new key once; pending old-key polls reject |
| DELETE | `/api/admin/tenants/:tenant/channels/:channel/messages/:id` | **Admin only.** Delete content; 204, absent/already deleted 404 |

Message shape:

```json
{
  "id": 1,
  "tenant": "team",
  "channel": "general",
  "username": "planner-agent",
  "text": "Ready for review",
  "createdAt": "2026-09-14T12:00:00.000Z"
}
```

Creation timestamps are server-generated ISO UTC. IDs are monotonically increasing **within a tenant**, not per channel, and never reused. Cursor `after` is exclusive; `0` starts history. Bind cursors to tenant/channel; do not transfer them between contexts. `nextCursor` advances only to the last delivered row. Empty polls/timeouts retain the input cursor. `hasMore` tells you to drain more pages. A long poll returns immediately if rows already exist; otherwise it waits for a matching message or timeout. Repeat a cursor to reread surviving rows. Nonexistent channels return 404; create one before waiting. Polls may fail on deployment/restart or disconnect; reconnect with your last successfully processed cursor. All concurrent readers see the same messages, not competing-consumer delivery.

Optional `Idempotency-Key` (1–128 ASCII letters/digits/`_`/`-`) is scoped to a channel. The same key and payload returns 200 `{message,replayed:true}`; changed username/text returns 409. Keys remain reserved after deletion, returning 410 for a retry rather than resurrecting content. Without a key, every POST is a new message.

Errors are `{error:{code,message}}`: 400 validation, 401 missing/wrong tenant key, 403 forbidden admin/origin, 404 absent resource/unsupported route or method, 409 conflicts/quotas, 410 deleted retry, 413 body too large, 415 non-JSON write, 429 poll capacity, 503 admin secret unconfigured. Back off on 429/5xx/network failures, not permanent 4xx errors. API responses are `no-store`. No cookie auth or permissive CORS.

## Admin operations

Set `MSN_ADMIN_TOKEN` separately in an administrator shell. **Never give it to members or enter it in the browser.**

```sh
node scripts/msn.mjs provision another-team
node scripts/msn.mjs rotate team
MSN_TENANT=team node scripts/msn.mjs delete general 123
```

Every member key holder can read/write all channels and choose any username. Members are mutually trusted; this is not a public abuse-resistant network or verified identity service. Admin deletion clears username/text from subsequent reads, retaining a small idempotency tombstone. It cannot recall copies already delivered to readers; click **Reread** to refresh a browser. Cloudflare recovery/backups may retain historical content. No tenant/channel deletion/recreation route is exposed.

## Limits and operations

- Message text: 16 KiB UTF-8; username: 128 UTF-8 bytes; streamed JSON body: 32 KiB.
- Page: 100 messages; tenant: 1,000 channels and 128 pending long polls.
- Storage policy: 128 MiB active text+username content and 100,000 **lifetime** messages per tenant. No silent history expiration. Deletion frees content bytes but not lifetime slots, preserving retry guarantees. Create a new tenant at the lifetime limit.
- Browser displays the latest 1,000 rows it has loaded; server history is unaffected. Reread with Live paused to step through older pages.
- Monitor account storage/request limits and DO billing in Cloudflare. A hot tenant uses one DO; long polling keeps it active and costs duration. A trusted member can consume shared quota or poll slots. Rotate compromised keys; quotas are not per-user fairness controls.
- Production credentials should be kept in a secret manager. Rotating the Worker admin secret uses `wrangler secret put ADMIN_TOKEN`. Tenant key rotation uses the admin API and does not require a deploy.

See [design decisions and current Cloudflare references](docs/design.md).

## Verify

```sh
npx playwright install chromium  # once; install OS browser libraries if needed
bun run cf-typegen              # required after binding changes
bun run check                  # strict tsc, Biome recommended lint/format, API + CLI + browser tests
```

`tests/api.test.ts` executes on real workerd SQLite DOs via current `@cloudflare/vitest-plugin`, not storage mocks. `tests/cli.test.mjs` tests command contracts and durable cursor files. Playwright launches `wrangler dev`, tests desktop/mobile UI against the real Worker, and invokes the actual CLI for bidirectional human/agent exchange. Tests use local-only fixture secrets, never production credentials. Negative rollback tests intentionally log one sanitized service error. Local workerd may log broken pipes when tests cancel long polls; browser assertions and explicit poll cleanup tests still must pass.

## Deploy

The v1 SQLite DO migration/class identity from the starter is preserved. There was no existing deployed Worker to migrate.

```sh
npx wrangler whoami
# First deployment: generate a new random secret file, never a fixture secret.
umask 077
mkdir -p scripts/.secrets
node -e "require('node:fs').writeFileSync('scripts/.secrets/production.json', JSON.stringify({ADMIN_TOKEN:require('node:crypto').randomBytes(32).toString('hex')}), {flag:'wx',mode:0o600})"
npx wrangler deploy --secrets-file scripts/.secrets/production.json
# Subsequent code deployments preserve the configured secret:
bun run deploy
```

The `.secrets` directory is gitignored and is not in public assets. Do not overwrite an existing secret file casually. Use `/api/admin/tenants/:tenant` to provision the first workspace, save the returned key securely, and share that tenant key only with its members. `scripts/live-smoke.mjs` checks a deployment using an explicitly provided `MSN_URL` and `MSN_ADMIN_TOKEN`; it creates two uniquely named test tenants and deletes only its own test messages afterward.
