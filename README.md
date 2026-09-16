# msn

Bidirectional channel messaging for humans and agents, backed by Cloudflare SQLite Durable Objects. A responsive browser inbox and a zero-runtime-dependency Node CLI use the same JSON HTTP API. A Rust CLI (`msn`) is in [cli/README.md](cli/README.md) (install from GitHub Releases; `fnox run -- msn …`).

- **Workspace isolation:** one object per tenant, random tenant access keys, independent concurrent tenants.
- **Channels, not queues:** all readers receive a copy. Reads never consume; any reader can send a reply.
- **Durable history:** ordered cursors, pagination, single poll, bounded long poll, reread and safe send retries.
- **No account login:** connect with a workspace or personal participant key. Administrators can issue independently revocable keys bound to a display name or prefix; unbound legacy workspace keys still allow any name. All keys grant access to all channels in their workspace.
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

Save the returned `token` securely. Open http://localhost:8787, enter workspace `team`, that **tenant** key and any display name. Create a channel and start chatting. The UI is mobile-first: on a phone you see the channel list or one conversation at a time; on wider screens both. With **Stay signed in on this device** checked (the default), the browser keeps the key and your last channel in same-origin `localStorage` and reconnects on the next visit; Disconnect or a 401 from any active request forgets it immediately. A rejected display name (403) does not log you out. Uncheck it on a shared device and the key stays in memory only. See [ADR 0006](docs/adr/0006-browser-remembered-workspace-credentials.md). Loaded conversations and scroll positions are cached in memory across channel switches (up to 5 channels / 2,000 messages total, at most 1,000 per channel). Reread resets only the selected conversation; reloading or cache eviction reloads history. New messages do not drag you away from older text; use **Jump to latest**. Reply and correlation annotations are visible. This is delivery progress, not durable read receipts. Drafts and uncertain-send retry keys stay scoped to their channel for the connection's lifetime. Editing the payload starts a new logical send; do not reload if you need to retry an uncertain send.

## Agents

```sh
export MSN_URL=https://YOUR-WORKER.workers.dev
export MSN_WORKSPACE_TENANT=team
read -rs -p 'Participant key: ' MSN_WORKSPACE_TOKEN; echo; export MSN_WORKSPACE_TOKEN
export MSN_USERNAME=planner-agent

node scripts/msn.mjs create general
node scripts/msn.mjs send general --text 'Ready for review' --key task-42-review
node scripts/msn.mjs send general --json '{"op":"review","task":42}' --key task-42-cmd
node scripts/msn.mjs poll general --after 0             # one immediate page (reread from the start)
node scripts/msn.mjs follow general --cursor-file ./planner-cursor.json
node scripts/msn.mjs --help
```

Between turns, an agent wants "messages since I last looked", not a forever `follow` or a hand-tracked `--after` loop. Use the Rust CLI's `msn wait` ([cli/README.md](cli/README.md); env `MSN_WORKSPACE_TENANT` / `MSN_WORKSPACE_TOKEN`):

```sh
msn wait general --reader planner          # block (long-poll, reconnecting) until new messages, print the page, persist the cursor, exit 0
msn wait general --reader planner          # next run prints only rows strictly after the previous nextCursor
msn follow general --cursor-file ./planner-cursor.json --once   # streaming sibling: one JSON line per message, exit after the first non-empty page
```

Automatic `wait` state is isolated by origin, workspace, reader and channel. Choose a stable `--reader` / `MSN_READER` for each independent reader; `MSN_USERNAME` is the fallback. Without either, pass `--cursor-file` or `--after` explicitly: the CLI refuses to silently share an unnamed cursor. Multiple processes must not use one cursor file concurrently. Both CLIs lock explicit cursor files and fail with a recovery message rather than racing; Rust also locks its automatic reader cursor. A crash can leave a `.lock` file: remove it only after confirming its owner is no longer running. Old unscoped default cursors are **not** automatically adopted; a new reader starts from history, so explicitly reuse an old file only if it really belongs to that reader.

Both CLIs accept `MSN_WORKSPACE_TENANT` / `MSN_WORKSPACE_TOKEN`; the older `MSN_TENANT` / `MSN_TOKEN` aliases remain supported when the canonical variables are absent. Set `MSN_URL` explicitly: Node still defaults to localhost, Rust to the deployed origin. Rust alone provides `wait` and `follow --once`.

`send` prints its retry key to stderr and JSON to stdout. On an uncertain result, retry with the **same `--key` and payload** (typing and correlation fields included). `--text` sends plain text; `--json` sends the same `text` field tagged `contentType: "application/json"`, validating the JSON locally first and exiting 2 without any request when it is invalid. `follow` emits one JSON message per line, reconnects with exponential backoff on transient errors, and exits on authentication/client errors. Ctrl+C cancels polling; `wait` and `follow` never advance the cursor past what they have already printed. Cursor files are atomically replaced, mode 0600, and bound to origin/tenant/channel. Use one file per reader process. Delivery to a downstream consumer is not an exactly-once acknowledgment protocol; a crash can replay output, so deduplicate by tenant/channel/id when needed. Browser Live reconnects similarly. Browsers are same-origin only; server-side agents can call from anywhere over HTTPS.

### Request/response between agents on one channel

Run the requester and responder in separate shells, each configured with its own participant key and matching username. Channels stay a fan-out log: every reader gets every message, and reads never consume. Two optional, opaque fields make that log easy to interpret when many agents share a channel. `replyTo` names the same-channel message id a payload answers; `correlationId` is any client string (≤128 UTF-8 bytes) that ties related messages together. The server stores and returns them; it never matches, routes or inboxes on them. Filtering is the reader's job.

```sh
# Requester: ask, remembering the message id and a correlation id.
REQUEST=$(node scripts/msn.mjs send general --text 'Summarize PR 17' --correlation-id task-7 --key task-7-req)
REQUEST_ID=$(node -p 'JSON.parse(process.argv[1]).message.id' "$REQUEST")

# Responder (another shell using the summarizer's own participant key): answer only what is addressed to it, replying to the request id.
MSN_USERNAME=summarizer node scripts/msn.mjs follow general --cursor-file ./summarizer-cursor.json \
  | while read -r line; do
      if [ "$(node -p 'JSON.parse(process.argv[1]).replyTo === undefined && JSON.parse(process.argv[1]).username === "planner-agent"' "$line")" = true ]; then
        ID=$(node -p 'JSON.parse(process.argv[1]).id' "$line")
        CID=$(node -p 'JSON.parse(process.argv[1]).correlationId ?? ""' "$line")
        node scripts/msn.mjs send general --text 'Done: 3 files changed…' --reply-to "$ID" ${CID:+--correlation-id "$CID"} --key "reply-$ID"
      fi
    done

# Requester: wait for the line whose replyTo is the request id (or whose correlationId matches).
node scripts/msn.mjs follow general --after "$REQUEST_ID" \
  | node -e 'require("node:readline").createInterface({input:process.stdin}).on("line", l => { const m = JSON.parse(l); if (m.replyTo === Number(process.argv[1])) { console.log(m.text); process.exit(0); } })' "$REQUEST_ID"
```

Every other reader on `general` still sees both the request and the reply. Nothing is claimed or consumed, so two responders can both answer; use `correlationId` (or `username`) to decide which answers you trust. The Rust CLI takes the same flags: `msn send general --text 'pong' --reply-to 42 --correlation-id task-7`.

Agents and humans share one channel. A small command message and human-readable lines can interleave; readers filter on `contentType` and only `JSON.parse` the typed ones:

```sh
node scripts/msn.mjs send general --json '{"op":"ping"}' --key ping-1              # planner-agent
# In the human's separately configured shell (using Tomas's key):
MSN_USERNAME=Tomas node scripts/msn.mjs send general --text 'Looks good, ship it'
node scripts/msn.mjs follow general --cursor-file ./planner-cursor.json \
  | jq -c 'select(.contentType == "application/json") | .text | fromjson'   # {"op":"ping"}
```

The deployed `/guide.html` is a public curl/agent quickstart.

## HTTP contract

Normal endpoints require `Authorization: Bearer <tenant-key>`. JSON writes require `Content-Type: application/json`. Never put keys in query strings. Identifiers are 1–64 lowercase ASCII letters/digits/`_`/`-`, starting with a letter or digit.

| Method | Endpoint | Behavior |
| --- | --- | --- |
| GET | `/api/health` | Public liveness, `{ok:true,service:"msn"}` |
| GET | `/api/tenants/:tenant` | The key's bind: `{tenant,username,usernamePrefix}` (both `null` when unbound) |
| GET | `/api/tenants/:tenant/channels?after=&limit=100` | Lexicographically paginated `{channels:[{name,createdAt}],nextCursor,hasMore}`; max 1,000/page |
| PUT | `/api/tenants/:tenant/channels/:channel` | Idempotent create, 201 or 200 |
| POST | `/api/tenants/:tenant/channels/:channel/messages` | `{username,text,contentType?,replyTo?,correlationId?}`; creates channel automatically; 201 `{message,replayed:false}`; bound key with another `username` → 403 `username_bound` |
| GET | `/api/tenants/:tenant/channels/:channel/messages?after=0&limit=100&wait=0` | Ordered `{messages,nextCursor,hasMore}`; `wait` 0–25 seconds |
| PUT | `/api/admin/tenants/:tenant` | **Admin only.** Provision once; 201 `{tenant,token,username,usernamePrefix}`, existing tenant 409. Optional JSON body `{username}` or `{usernamePrefix}` binds the key |
| POST | `/api/admin/tenants/:tenant/token` | **Admin only.** Emergency workspace-wide reset: rotate the workspace key and revoke **all** participant keys and their pending polls. No body keeps the workspace key's bind; `{username:null}` clears it; `{username}`/`{usernamePrefix}` rebinds |
| PUT | `/api/admin/tenants/:tenant/keys/:key` | **Admin only.** Issue a named participant key once, 201 `{id,token,username,usernamePrefix,createdAt}`. Requires `{username}` or `{usernamePrefix}`; duplicate id → 409 |
| GET | `/api/admin/tenants/:tenant/keys` | **Admin only.** `{keys:[{id,username,usernamePrefix,createdAt}]}`; participant metadata only, never secrets |
| DELETE | `/api/admin/tenants/:tenant/keys/:key` | **Admin only.** Revoke this participant key and its pending polls, 204; absent → 404. Other keys keep working |
| DELETE | `/api/admin/tenants/:tenant/channels/:channel/messages/:id` | **Admin only.** Delete content; 204, absent/already deleted 404 |

Message shape:

```json
{
  "id": 1,
  "tenant": "team",
  "channel": "general",
  "username": "planner-agent",
  "text": "Ready for review",
  "contentType": "text/plain",
  "createdAt": "2026-09-14T12:00:00.000Z"
}
```

`contentType` is optional on send and defaults to `text/plain`; the only other value is `application/json`, which requires `text` to parse as JSON (any JSON value) and is rejected with 400 otherwise. Every returned message carries `contentType`, so readers can filter on it and `JSON.parse` only typed bodies. The body always lives in `text` and the 16 KiB limit applies unchanged. Old clients that omit the field keep sending plain text, and they can ignore the extra response key. Arbitrary MIME types, attachments, binary and multipart payloads are not supported.

A send may add two optional, opaque correlation fields. They are stored verbatim, returned on every read, and **omitted from the JSON when unset**, so a message sent without them has exactly the shape above:

```json
{ "id": 2, "…": "…", "text": "pong", "replyTo": 1, "correlationId": "task-7" }
```

- `replyTo`: positive integer id of a message **in the same channel**. A missing id, an id from another channel, or a non-integer is 400 `invalid_reply_to` and nothing is stored. An id whose content was admin-deleted still counts as existing. `null` means unset.
- `correlationId`: non-blank string of at most 128 UTF-8 bytes (400 `invalid_message` otherwise). `null` means unset.

The server never matches, routes or filters on these fields; there are no inboxes, threads or request/response semantics. They only make the fan-out log easier to interpret.

Creation timestamps are server-generated ISO UTC. IDs are monotonically increasing **within a tenant**, not per channel, and never reused. Cursor `after` is exclusive; `0` starts history. Bind cursors to tenant/channel; do not transfer them between contexts. `nextCursor` advances only to the last delivered row. Empty polls/timeouts retain the input cursor. `hasMore` tells you to drain more pages. A long poll returns immediately if rows already exist; otherwise it waits for a matching message or timeout. Repeat a cursor to reread surviving rows. Nonexistent channels return 404; create one before waiting. Polls may fail on deployment/restart or disconnect; reconnect with your last successfully processed cursor. All concurrent readers see the same messages, not competing-consumer delivery.

Optional `Idempotency-Key` (1–128 ASCII letters/digits/`_`/`-`) is scoped to a channel. The same key and payload returns 200 `{message,replayed:true}`; changed username/text/contentType/replyTo/correlationId returns 409 (the payload digest covers all five, and a plain text/plain message stored before either field existed still replays on its original username/text). Keys remain reserved after deletion, returning 410 for a retry rather than resurrecting content. Without a key, every POST is a new message.

Errors are `{error:{code,message}}`: 400 validation, 401 missing/wrong tenant key, 403 forbidden admin/origin or `username_bound` (a bound key sent as another name; permanent for that key, do not retry), 404 absent resource/unsupported route or method, 409 conflicts/quotas, 410 deleted retry, 413 body too large, 415 non-JSON write, 429 poll capacity, 503 admin secret unconfigured. Back off on 429/5xx/network failures, not permanent 4xx errors. API responses are `no-store`. No cookie auth or permissive CORS.

## Admin operations

Set `MSN_ADMIN_TOKEN` separately in an administrator shell. **Never give it to members or enter it in the browser.**

```sh
node scripts/msn.mjs provision another-team
node scripts/msn.mjs rotate team
MSN_WORKSPACE_TENANT=team node scripts/msn.mjs delete general 123
```

Every member key holder can read/write all channels and, with an **unbound** key, choose any username. Members are mutually trusted; this is not a public abuse-resistant network or public identity verification service. There are no private chats, channel ACLs, durable human read receipts or automatic agent routing.

### Give each participant a separate key

In an **administrator-only shell**, configure `MSN_URL`, `MSN_WORKSPACE_TENANT=team` and `MSN_ADMIN_TOKEN`. Keep the original workspace key private, or bind it to the human who uses it. Never distribute an unbound workspace key if you rely on participant name enforcement.

```sh
msn key-create tomas --username Tomas
msn key-create planner --username planner-agent
msn keys                         # lists key metadata, never tokens
msn key-revoke planner            # Tomas stays connected
# Reissue a revoked key using key-create; it gets a new random secret.
```

Creation prints each new token **once**. Deliver only that participant's token to them securely. The key id (`planner`) is an administrative handle, not a username or a secret. Only explicit `--username` / `--username-prefix` flags create a binding; an administrator's ambient `MSN_USERNAME` cannot accidentally bind a key. The Node CLI has the same commands. `msn whoami` (or `node scripts/msn.mjs whoami`) shows the current key's permitted name, without printing the key.

Use exact names for distinct humans and agents. A prefix key allows its holder to send as **any** name within that prefix. Keys still allow all-channel read/write, not private channel membership. Several keys may deliberately represent the same name (e.g. two devices); names are not a public identity verification system. Revocation does not retract already delivered messages.

**Emergency reset:** `msn rotate team` invalidates the old workspace key **and every participant key**. Use `key-revoke` for one participant. Creating a key whose id already exists fails instead of replacing its secret; if the creation response is lost, revoke that id and create it again.

### Bind the original workspace key to a display name

To stop spoofing without any client-side crypto, bind a key to one display name (or a name prefix) when you provision or rotate it. The server then rejects every send under another name with `403 username_bound`; nothing is stored and no waiting reader is woken. Everyone sharing one key shares its bind. Use separate participant keys in the **same workspace** (above), rather than provisioning isolated workspaces for each person.

```sh
node scripts/msn.mjs provision thehuman --username thehuman      # prints the token once
node scripts/msn.mjs provision agents --username-prefix agent-   # agent-1, agent-planner, …
node scripts/msn.mjs rotate thehuman                             # new key, same bind
node scripts/msn.mjs rotate thehuman --username someone-else     # new key, new bind
node scripts/msn.mjs rotate thehuman --unbind                    # new key, any name again
```

`GET /api/tenants/:tenant` with the key returns its bind. The browser reads it on connect and locks the display name to an exact bind (or refuses a name outside a prefix bind). `send` still takes `--username`/`MSN_USERNAME`; the server, not the client, enforces the bind. Only explicit binding flags bind on `provision`/`rotate`/`key-create`; `MSN_USERNAME` from the environment never does. Names are compared byte-for-byte (no trimming or case folding). Admin deletion clears username/text from subsequent reads, retaining a small idempotency tombstone. It cannot recall copies already delivered to readers; click **Reread** to refresh a browser. Cloudflare recovery/backups may retain historical content. No tenant/channel deletion/recreation route is exposed.

## Limits and operations

- Message text: 16 KiB UTF-8; username: 128 UTF-8 bytes; correlationId: 128 UTF-8 bytes; streamed JSON body: 32 KiB.
- Page: 100 messages; tenant: 1,000 channels, 1,000 active participant keys and 128 pending long polls.
- Storage policy: 128 MiB active text+username content and 100,000 **lifetime** messages per tenant. No silent history expiration. Deletion frees content bytes but not lifetime slots, preserving retry guarantees. Create a new tenant at the lifetime limit.
- Browser displays the latest 1,000 rows it has loaded per cached channel (up to 5 channels / 2,000 rows in memory); server history is unaffected. Reread with Live paused to step through older pages.
- Browser sends are always `text/plain`. An `application/json` message is pretty-printed as text inside a `<pre>` via `textContent`; nothing is ever interpreted as HTML.
- Monitor account storage/request limits and DO billing in Cloudflare. A hot tenant uses one DO; long polling keeps it active and costs duration. A trusted member can consume shared quota or poll slots. Rotate compromised keys; quotas are not per-user fairness controls.
- Production credentials should be kept in a secret manager. Rotating the Worker admin secret uses `wrangler secret put ADMIN_TOKEN`. Tenant key rotation uses the admin API and does not require a deploy.

See [design decisions and current Cloudflare references](docs/design.md).

## Verify

```sh
npx playwright install chromium  # once; install OS browser libraries if needed
bun run cf-typegen              # required after binding changes
bun run check                  # strict tsc, Biome recommended lint/format, API + CLI + browser tests
bun run test:participants      # requires Rust; real local Worker + both CLIs, isolated temp state
```

`tests/api.test.ts` executes on real workerd SQLite DOs via current `@cloudflare/vitest-plugin`, not storage mocks; it includes the bound-key cases and schema v1/v2/v3/v4→v5 migrations on restarted objects. `tests/cli.test.mjs` tests command contracts and durable cursor files. Playwright launches `wrangler dev`, tests desktop/mobile UI against the real Worker, and invokes the actual CLI for bidirectional human/agent exchange. Tests use local-only fixture secrets, never production credentials. Negative rollback tests intentionally log one sanitized service error. Local workerd may log broken pipes when tests cancel long polls; browser assertions and explicit poll cleanup tests still must pass.

## Deploy

The v1 SQLite DO migration/class identity from the starter is preserved. Existing tenants upgrade their SQLite schema in place on first use; their original keys and history remain intact. These checkout changes require a Worker deployment and a rebuilt Rust CLI before they are available remotely.

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

The `.secrets` directory is gitignored and is not in public assets. Do not overwrite an existing secret file casually. Use `/api/admin/tenants/:tenant` to provision the first workspace, save the returned workspace key securely, then issue individually bound participant keys to members instead of sharing an unbound key. `scripts/live-smoke.mjs` checks a deployment using an explicitly provided `MSN_URL` and `MSN_ADMIN_TOKEN`; it creates two uniquely named test tenants and deletes only its own test messages afterward.
