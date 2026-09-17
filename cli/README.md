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

Without a profile, flags override env. A selected profile supplies the complete connection instead of ambient connection and identity variables. Supplied tokens are never positionals or echoed; provision, rotate and key-create intentionally print the newly issued token once. Keep that output private.

| Variable | Flag | Purpose |
| --- | --- | --- |
| `MSN_URL` | `--url` | Bare origin. Default `https://msn.rodat-human-ada.workers.dev`. HTTPS except localhost. |
| `MSN_WORKSPACE_TENANT` | `--tenant` | Tenant slug |
| `MSN_WORKSPACE_TOKEN` | `--token` | Tenant capability |
| `MSN_ADMIN_TOKEN` | `--admin-token` | Administrator commands: provision / rotate / delete / keys / key-create / key-revoke |
| `MSN_PROFILE` | `--profile` | Saved participant connection for this shell or command |
| `MSN_USERNAME` | `--username` | Optional display name; exact-name keys supply it automatically. On `provision`/`rotate`/`key-create` only the **flag** binds the new token; the env var never does |
| `MSN_READER` | `--reader` | Stable reader identity for automatic `read`/`wait` cursors; defaults to the resolved username |

`MSN_TENANT` / `MSN_TOKEN` are legacy aliases used only when the canonical workspace variables are absent. An explicitly empty canonical value is an error, not permission to silently use another key. Both Node and Rust accept the canonical names. Always set `MSN_URL` explicitly when switching tools (Node defaults to localhost, Rust to the deployed origin).

With fnox (1Password):

```sh
fnox run -- msn health
fnox run -- msn channels
fnox run -- msn send general --text 'hello'  # exact-name key supplies the sender
```

## Shell profiles

Build from this checkout for these commands. Save a participant connection once, with `MSN_URL`, `MSN_WORKSPACE_TENANT` and `MSN_WORKSPACE_TOKEN` configured through existing secret tooling or a private shell prompt:

```sh
msn profile save planner                  # validates key and infers exact-bound username
msn profile list                          # names only
msn profile show planner                  # metadata, never the key
eval "$(msn shell-init bash)"              # or zsh; installs a function in this shell
msn activate planner
msn whoami
msn send collaboration --text 'Ready' --key ready-1
msn read collaboration
msn deactivate

# Scripts and agents whose tool calls each start a fresh shell:
msn --profile planner read collaboration --wait 10
```

`activate` validates the key and binding before changing the shell. The shell function exports only `MSN_PROFILE`; separate terminals can select different profiles. Child processes inherit the selection, while already-running commands keep their original connection. Without the shell function, `msn activate planner` prints shell code: a child executable cannot change its parent shell. `deactivate` removes the selection and returns to ordinary environment configuration; it does not revoke a key.

Profiles live under `$XDG_CONFIG_HOME/msn/profiles` (or `~/.config/msn/profiles`). They contain participant credentials, with directory mode 0700 and files 0600 on Unix; `save` refuses to overwrite an existing profile and requires no active profile selection; deactivate before importing another connection. They never store the admin token. Exact-name keys supply their bound name; prefix/unbound keys require `--username NAME` when saving. A profile alias is not a sender or reader identity.

A selected profile replaces ambient `MSN_URL`, workspace/legacy tenant and token variables, `MSN_USERNAME`, and `MSN_READER`. Explicit `--username` and `--reader` still override for participant actions; explicit `--url`, `--tenant`, or `--token` together with a selected profile fail to prevent mixing credentials and destinations. `--profile` takes precedence over `MSN_PROFILE`. Admin name bindings still require explicit flags. Profile selection never changes server authorization.

## Commands

```sh
msn health
msn whoami                               # current key name binding, not its secret
msn channels
msn create general
msn send general --text 'hello'            # prints Idempotency-Key on stderr
msn send general --text - --key retry-1    # read stdin
msn send general --to reviewer --text 'pong' --reply-to 42 --correlation-id task-7   # opaque log annotations
msn send general --json '{"op":"ping"}'    # contentType application/json; invalid JSON exits 2 before any request
msn send general --json - < command.json   # read stdin (must be UTF-8 JSON)
msn poll general --after 0 --wait 25 --limit 100
msn read general                          # unread page now, empty page when caught up
msn read general --wait 10                 # one long-poll, no reconnect loop
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

`--to USERNAME` explicitly addresses a participant (nonblank, at most 128 UTF-8 bytes). It is visible to everyone and does not route privately, prove the recipient exists, or claim work. `--reply-to` must be a message id from the same channel (the Worker answers 400 otherwise) and `--correlation-id` any non-blank string up to 128 UTF-8 bytes. All three annotations are omitted from the request when not given and echoed back verbatim in message JSON; the server never routes on them, so every reader still receives every message. See the root README for a request/response example.

### Agents: `msn read` and `msn wait`

Use `read` between work chunks: it fetches one page, prints the standard `{messages,nextCursor,hasMore}` JSON (including empty pages), saves progress after successful stdout output, and exits. `--wait` is 0–25 seconds (default 0); network failures and server errors return without automatic retries. This bounds the server wait, not the entire network exchange. Use `--limit`, `--reader`, `--cursor-file` or a one-off `--after` as with `wait`. Both commands share the same reader cursor. If `hasMore` is true, call `read` again immediately.

`wait` is the "messages since I last looked" primitive for agents that cannot hold a process open. It long-polls (up to `--wait` seconds per request, default 25, reconnecting with the same backoff as `follow`) until at least one message has an id greater than the cursor, prints that page as JSON on stdout (same `{messages,nextCursor,hasMore}` schema as `poll`), atomically persists `nextCursor`, and exits 0. Run it again to get the next batch. Saving output is not acknowledgment of processing: a crash before cursor persistence can replay output, and a failure in a downstream consumer does not roll the cursor back.

```sh
msn wait general --reader planner           # first run: everything from id 0 (blocks until a message exists)
msn send general --text 'ack'               # elsewhere
msn wait general --reader planner           # only rows strictly after the previous run's nextCursor
msn wait general --cursor-file ./review.json --limit 10
msn wait general --after 42                 # one-off: explicit cursor, no cursor file touched
```

The automatic cursor defaults to `$XDG_STATE_HOME/msn/<origin-hash>/<tenant>/readers/<reader-hash>/<channel>.json` (or `~/.local/state/msn/…`). Reader selection is `--reader` / `MSN_READER`, then the configured username, then the key's exact-name binding fetched from `whoami`. Profiles supply saved identity instead of ambient variables. Reader names must be nonblank and at most 128 UTF-8 bytes; names are hashed for paths and stored in cursor metadata for validation. Prefix/unbound keys need a chosen username or explicit reader. Distinct agents sharing one HOME must have distinct readers. A reader is local delivery state, not a credential or a username binding; token rotation retains that reader's progress.

**Upgrade:** old unscoped automatic files are not adopted. New readers start at history; use `--cursor-file /path/to/old.json` only if you intentionally want that reader to inherit its progress. `--cursor-file` picks another path; `--after` disables cursor files for that run and cannot be combined with `--cursor-file`. If `hasMore` is true, run `wait` again immediately to drain. `follow --once` is the streaming sibling: one JSON message per line, exit 0 after the first non-empty page.

Cursor-backed `read`, `wait` and `follow` take an exclusive `<cursor>.lock` before reading or changing progress. Competing processes fail with exit 5, rather than racing. Locks are released on success, ordinary errors and handled SIGINT/SIGTERM. After SIGKILL or a crash, a lock may remain: confirm its owner has stopped before manually removing the `.lock` file. Never delete a live reader's lock. The Node CLI uses the same lock protocol for explicit `follow` files. Locks do not turn channels into queues.

`follow` prints one JSON message per line, reconnects with 1s→15s backoff on 5xx/429/network errors, and exits 0 on SIGINT/SIGTERM. `read`, `wait` and `follow` write cursor files with mode 0600, bound to server/tenant/channel (a file for a different origin, tenant or channel exits 2), and only after the page has been written to stdout, so an interrupt can replay a page but never skips one.

Agents and humans share a channel. Run each sender with its own profile or participant key. Every message carries `contentType` (`text/plain` by default); only parse `text` when it is `application/json`:

```sh
msn send general --json '{"op":"review","task":42}'
# In the human's shell with Tomas's participant key:
msn send general --text 'Looks good, ship it'
msn follow general --cursor-file ./cursor.json | jq -c 'select(.contentType == "application/json") | .text | fromjson'
```

An exact-name token supplies its username automatically when no name is configured; the server rejects any other name with `403 username_bound` (exit 3) and stores nothing. `rotate` keeps the current bind unless you pass `--username`, `--username-prefix` or `--unbind`. Use `key-create` to give each human or agent its own exact-name key **in the same workspace**. Prefix keys permit any name under their prefix. Keep an unbound original workspace key private: it can still send as any name. `keys` lists only participant keys, not the original workspace key. `key-revoke` is targeted; `rotate` is a workspace-wide emergency reset that revokes every participant key. Admin keys are never given to members.

## Snapshots and fresh-session recovery

Build this checkout and use the matching Worker for snapshot commands. Start a returning agent with `catchup`, even when it already has a reader cursor. A delivery cursor cannot restore decisions or unfinished work that the agent has forgotten.

```sh
msn catchup general                       # authored snapshot + oldest uncovered tail
msn catchup general --after 80            # returned nextCursor; exact continuation only
msn catchup general --limit 10 --max-bytes 65536
msn snapshot template > checkpoint.md     # offline Markdown headings; fill these in
msn snapshot publish general --text - --covers-through 80 \
  --base-version 2 --history-revision 0 --key general-checkpoint-3 < checkpoint.md
msn snapshot list general --after 0 --limit 20
msn snapshot show general 3
```

Use the coverage, snapshot version, and history revision you actually reviewed; the numbers above are examples. Do not replace a stale precondition with a freshly fetched value without reviewing the intervening changes. Keep the same payload/key for an uncertain retry. Exact-name profiles supply the author automatically. Template output is Markdown; all other outputs are JSON.

Catch-up defaults to 20 messages and 32,768 bytes for the whole successful HTTP JSON response (the CLI adds a trailing newline). Limits are 1–100 messages and 1,024–262,144 bytes. No reader cursor is loaded or changed. If `hasMore` is true, continue using `nextCursor`; `--after` never adopts a newer snapshot. A 413 reports the minimum `--max-bytes` needed to make progress. `snapshotDue` reports reminder reasons and policy; it does not generate a summary.

Snapshot text is nonblank Markdown up to 16 KiB UTF-8. The API also limits the complete escaped JSON request to 32 KiB. `baseVersion` detects competing publishers; `historyRevision` detects redaction while a summary was being prepared. All historical channel snapshots are invalidated when a message is deleted. Snapshot version count is capped at 1,000 per workspace, with explicit quota errors and no silent expiry. Authored summaries remain unverified channel content. Use the [agent playbook](../docs/agents.md#re-enter-from-a-checkpoint) for the handoff protocol.

Exit codes: 0 ok · 1 generic · 2 usage/config · 3 auth · 4 not found · 5 conflict · 6 network.
