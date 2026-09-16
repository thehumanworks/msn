# msn CLI

Static Rust client for the msn Worker. JSON on stdout, errors on stderr, distinct exit codes.

## Install

Download the archive for your target from [GitHub Releases](https://github.com/thehumanworks/msn/releases), extract `msn`, and put it on `PATH`.

```sh
gh release download --repo thehumanworks/msn --pattern 'msn-*-x86_64-unknown-linux-gnu.tar.gz'
tar -xzf msn-*-x86_64-unknown-linux-gnu.tar.gz
./msn-*/msn --version
```

Build from this repo:

```sh
cd cli && cargo build --release
./target/release/msn --help
```

## Environment

Flags override env. Supplied tokens are never positionals or echoed; provision, rotate and key-create intentionally print the newly issued token once. Keep that output private.

| Variable | Flag | Purpose |
| --- | --- | --- |
| `MSN_URL` | `--url` | Bare origin. Default `https://msn.rodat-human-ada.workers.dev`. HTTPS except localhost. |
| `MSN_WORKSPACE_TENANT` | `--tenant` | Tenant slug |
| `MSN_WORKSPACE_TOKEN` | `--token` | Tenant capability |
| `MSN_ADMIN_TOKEN` | `--admin-token` | Administrator commands: provision / rotate / delete / keys / key-create / key-revoke |
| `MSN_USERNAME` | `--username` | Display name for `send`. On `provision`/`rotate`/`key-create` only the **flag** binds the new token; the env var never does |
| `MSN_READER` | `--reader` | Stable reader identity for automatic `wait` cursors; defaults to `MSN_USERNAME` |

`MSN_TENANT` / `MSN_TOKEN` are legacy aliases used only when the canonical workspace variables are absent. An explicitly empty canonical value is an error, not permission to silently use another key. Both Node and Rust accept the canonical names. Always set `MSN_URL` explicitly when switching tools (Node defaults to localhost, Rust to the deployed origin).

With fnox (1Password):

```sh
fnox run -- msn health
fnox run -- msn channels
MSN_USERNAME=agent fnox run -- msn send general --text 'hello'
```

## Commands

```sh
msn health
msn whoami                               # current key name binding, not its secret
msn channels
msn create general
msn send general --text 'hello'            # prints Idempotency-Key on stderr
msn send general --text - --key retry-1    # read stdin
msn send general --text 'pong' --reply-to 42 --correlation-id task-7   # opaque log annotations
msn send general --json '{"op":"ping"}'    # contentType application/json; invalid JSON exits 2 before any request
msn send general --json - < command.json   # read stdin (must be UTF-8 JSON)
msn poll general --after 0 --wait 25 --limit 100
msn wait general --reader planner          # reader-scoped progress; blocks until a nonempty page
msn follow general --cursor-file ./cursor.json
msn follow general --cursor-file ./cursor.json --once
msn provision new-tenant                   # admin; prints token once
msn provision thehuman --username thehuman # admin; token may only send as "thehuman"
msn provision agents --username-prefix agent-  # admin; token may only send as agent-*
msn rotate new-tenant                      # admin; keeps bind, revokes ALL participant keys
msn rotate new-tenant --unbind             # admin; new token may send as any name again
msn keys                                   # admin; configured workspace, metadata only
msn key-create planner --username planner-agent  # admin; secret printed once
msn key-revoke planner                     # admin; only this key and its pending reads
msn delete general 42                      # admin
```

`--reply-to` must be a message id from the same channel (the Worker answers 400 otherwise) and `--correlation-id` any non-blank string up to 128 UTF-8 bytes. Both are omitted from the request when not given and echoed back verbatim in message JSON; the server never routes on them, so every reader still receives every message. See the root README for a request/response example.

### Agents: `msn wait`

`wait` is the "messages since I last looked" primitive for agents that cannot hold a process open. It long-polls (up to `--wait` seconds per request, default 25, reconnecting with the same backoff as `follow`) until at least one message has an id greater than the cursor, prints that page as JSON on stdout (same `{messages,nextCursor,hasMore}` schema as `poll`), atomically persists `nextCursor`, and exits 0. Run it again to get the next batch. Saving output is not acknowledgment of processing: a crash before cursor persistence can replay output, and a failure in a downstream consumer does not roll the cursor back.

```sh
msn wait general --reader planner           # first run: everything from id 0 (blocks until a message exists)
msn send general --text 'ack'               # elsewhere
msn wait general --reader planner           # only rows strictly after the previous run's nextCursor
msn wait general --cursor-file ./review.json --limit 10
msn wait general --after 42                 # one-off: explicit cursor, no cursor file touched
```

The automatic cursor defaults to `$XDG_STATE_HOME/msn/<origin-hash>/<tenant>/readers/<reader-hash>/<channel>.json` (or `~/.local/state/msn/…`). Reader selection is `--reader` / `MSN_READER`, then `--username` / `MSN_USERNAME`. Reader names must be nonblank and at most 128 UTF-8 bytes; names are hashed for paths and stored in cursor metadata for validation. Missing reader identity fails before networking instead of silently sharing progress. Distinct agents sharing one HOME must have distinct readers. A reader is local delivery state, not a credential or a username binding; token rotation retains that reader's progress.

**Upgrade:** old unscoped automatic files are not adopted. New readers start at history; use `--cursor-file /path/to/old.json` only if you intentionally want that reader to inherit its progress. `--cursor-file` picks another path; `--after` disables cursor files for that run and cannot be combined with `--cursor-file`. If `hasMore` is true, run `wait` again immediately to drain. `follow --once` is the streaming sibling: one JSON message per line, exit 0 after the first non-empty page.

Cursor-backed `wait` and `follow` take an exclusive `<cursor>.lock` before reading or changing progress. Competing processes fail with exit 5, rather than racing. Locks are released on success, ordinary errors and handled SIGINT/SIGTERM. After SIGKILL or a crash, a lock may remain: confirm its owner has stopped before manually removing the `.lock` file. Never delete a live reader's lock. The Node CLI uses the same lock protocol for explicit `follow` files. Locks do not turn channels into queues.

`follow` prints one JSON message per line, reconnects with 1s→15s backoff on 5xx/429/network errors, and exits 0 on SIGINT/SIGTERM. `wait` and `follow` write cursor files with mode 0600, bound to server/tenant/channel (a file for a different origin, tenant or channel exits 2), and only after the page has been written to stdout, so an interrupt can replay a page but never skips one.

Agents and humans share a channel, but run each sender in a shell configured with its own key and matching username. Every message carries `contentType` (`text/plain` by default); only parse `text` when it is `application/json`:

```sh
MSN_USERNAME=planner-agent msn send general --json '{"op":"review","task":42}'
# In the human's shell with Tomas's participant key:
MSN_USERNAME=Tomas msn send general --text 'Looks good, ship it'
msn follow general --cursor-file ./cursor.json | jq -c 'select(.contentType == "application/json") | .text | fromjson'
```

A bound token still uses `msn send … --username <name>`; the server rejects any other name with `403 username_bound` (exit 3) and stores nothing. `rotate` keeps the current bind unless you pass `--username`, `--username-prefix` or `--unbind`. Use `key-create` to give each human or agent its own exact-name key **in the same workspace**. Prefix keys permit any name under their prefix. Keep an unbound original workspace key private: it can still send as any name. `keys` lists only participant keys, not the original workspace key. `key-revoke` is targeted; `rotate` is a workspace-wide emergency reset that revokes every participant key. Admin keys are never given to members.

Exit codes: 0 ok · 1 generic · 2 usage/config · 3 auth · 4 not found · 5 conflict · 6 network.
