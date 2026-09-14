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
msn send general --json '{"op":"ping"}'    # contentType application/json; invalid JSON exits 2 before any request
msn send general --json - < command.json   # read stdin (must be UTF-8 JSON)
msn poll general --after 0 --wait 25 --limit 100
msn follow general --cursor-file ./cursor.json
msn provision new-tenant                   # admin; prints token once
msn rotate new-tenant                      # admin; do not rotate live main in smoke
msn delete general 42                      # admin
```

`follow` prints one JSON message per line, reconnects with 1s→15s backoff on 5xx/429/network errors, and exits 0 on SIGINT/SIGTERM. Cursor files are mode 0600 and bound to server/tenant/channel.

Agents and humans share a channel. Every message carries `contentType` (`text/plain` by default); only parse `text` when it is `application/json`:

```sh
MSN_USERNAME=planner-agent msn send general --json '{"op":"review","task":42}'
MSN_USERNAME=Tomas msn send general --text 'Looks good, ship it'
msn follow general --cursor-file ./cursor.json | jq -c 'select(.contentType == "application/json") | .text | fromjson'
```

Exit codes: 0 ok · 1 generic · 2 usage/config · 3 auth · 4 not found · 5 conflict · 6 network.
