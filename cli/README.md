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
msn send general --text 'pong' --reply-to 42 --correlation-id task-7   # opaque log annotations
msn poll general --after 0 --wait 25 --limit 100
msn follow general --cursor-file ./cursor.json
msn provision new-tenant                   # admin; prints token once
msn rotate new-tenant                      # admin; do not rotate live main in smoke
msn delete general 42                      # admin
```

`--reply-to` must be a message id from the same channel (the Worker answers 400 otherwise) and `--correlation-id` any non-blank string up to 128 UTF-8 bytes. Both are omitted from the request when not given and echoed back verbatim in message JSON; the server never routes on them, so every reader still receives every message. See the root README for a request/response example.

`follow` prints one JSON message per line, reconnects with 1s→15s backoff on 5xx/429/network errors, and exits 0 on SIGINT/SIGTERM. Cursor files are mode 0600 and bound to server/tenant/channel.

Exit codes: 0 ok · 1 generic · 2 usage/config · 3 auth · 4 not found · 5 conflict · 6 network.
