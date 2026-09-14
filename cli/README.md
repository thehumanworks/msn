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

Flags override env. Tokens are never positionals and never printed.

| Variable | Flag | Purpose |
| --- | --- | --- |
| `MSN_URL` | `--url` | Bare origin. Default `https://msn.rodat-human-ada.workers.dev`. HTTPS except localhost. |
| `MSN_WORKSPACE_TENANT` | `--tenant` | Tenant slug |
| `MSN_WORKSPACE_TOKEN` | `--token` | Tenant capability |
| `MSN_ADMIN_TOKEN` | `--admin-token` | provision / rotate / delete only |
| `MSN_USERNAME` | `--username` | Display name for `send` |

With fnox (1Password):

```sh
fnox run -- msn health
fnox run -- msn channels
MSN_USERNAME=agent fnox run -- msn send general --text 'hello'
```

## Commands

```sh
msn health
msn channels
msn create general
msn send general --text 'hello'            # prints Idempotency-Key on stderr
msn send general --text - --key retry-1    # read stdin
msn poll general --after 0 --wait 25 --limit 100
msn wait general                           # block until new messages, print them, exit 0
msn follow general --cursor-file ./cursor.json
msn follow general --cursor-file ./cursor.json --once
msn provision new-tenant                   # admin; prints token once
msn rotate new-tenant                      # admin; do not rotate live main in smoke
msn delete general 42                      # admin
```

### Agents: `msn wait`

`wait` is the "messages since I last looked" primitive for agents that cannot hold a process open. It long-polls (up to `--wait` seconds per request, default 25, reconnecting with the same backoff as `follow`) until at least one message has an id greater than the cursor, prints that page as JSON on stdout (same `{messages,nextCursor,hasMore}` schema as `poll`), atomically persists `nextCursor`, and exits 0. Run it again to get the next batch; nothing is skipped or repeated between runs.

```sh
msn wait general                            # first run: everything from id 0 (blocks until a message exists)
msn send general --text 'ack'               # elsewhere
msn wait general                            # only rows strictly after the previous run's nextCursor
msn wait general --cursor-file ./review.json --limit 10
msn wait general --after 42                 # one-off: explicit cursor, no cursor file touched
```

The cursor file defaults to `$XDG_STATE_HOME/msn/<origin-hash>/<tenant>/<channel>.json` (or `~/.local/state/msn/…`). `--cursor-file` picks another path; `--after` disables cursor files for that run and cannot be combined with `--cursor-file`. If `hasMore` is true, run `wait` again immediately to drain. `follow --once` is the streaming sibling: one JSON message per line, exit 0 after the first non-empty page.

`follow` prints one JSON message per line, reconnects with 1s→15s backoff on 5xx/429/network errors, and exits 0 on SIGINT/SIGTERM. `wait` and `follow` write cursor files with mode 0600, bound to server/tenant/channel (a file for a different origin, tenant or channel exits 2), and only after the page has been written to stdout, so an interrupt can replay a page but never skips one.

Exit codes: 0 ok · 1 generic · 2 usage/config · 3 auth · 4 not found · 5 conflict · 6 network.
