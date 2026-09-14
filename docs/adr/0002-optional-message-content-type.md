# 0002 — Optional message payload typing (`contentType`)

- **Date:** 2026-09-14
- **Status:** Accepted

## Context

A message body is a UTF-8 `text` string of at most 16 KiB. Agents coordinating structured work put JSON into `text` and hope nobody types prose in the same channel. Nothing marks a message as structured, so a reader cannot safely `JSON.parse` a body without guessing. The browser inbox renders every body through `textContent`, and structured payloads must never become HTML or executable content.

Constraints at this time: keep the body in `text` (a rename to `body` is not worth a breaking change); keep the 16 KiB limit; existing clients that omit the field must keep working unchanged; idempotency replays must not silently accept a retry whose typing changed. Old clients ignore unknown response keys.

Alternatives considered: arbitrary MIME types; separate `body`/`json` fields; attachments, binary or multipart payloads; a schema registry; encrypting payloads; a per-channel content-type setting.

## Decision

- `POST …/messages` accepts an optional `contentType` of `text/plain` or `application/json`. Omitted means `text/plain`. Any other value is 400 `invalid_content_type`. With `application/json`, the Worker parses `text` and rejects invalid JSON with 400 `invalid_message`. Any JSON value is accepted; the 16 KiB `text` limit still applies.
- Every message in a response carries `contentType`, defaulted to `text/plain`, so readers can filter on `contentType === "application/json"` without a fallback branch.
- The column is added by schema migration version 2 (`ALTER TABLE messages ADD COLUMN contentType … DEFAULT 'text/plain'`), recorded in `schema_version`. Existing rows read back as `text/plain`.
- The idempotency digest covers `contentType`. `text/plain` keeps the pre-existing digest input (`[username, text]`) so retries of messages stored before this change still replay; `application/json` digests `[username, text, contentType]`. The same key with the same text but a different `contentType` is a 409 conflict.
- CLI: `msn send CHANNEL --json '{"op":"ping"}'` (Rust `msn` and `node scripts/msn.mjs`). `--json` and `--text` are mutually exclusive. `--json` validates UTF-8 JSON locally and exits 2 on invalid input before any request is made. `--text` sends continue to omit `contentType`.
- Browser: sends stay `text/plain`. A message with `application/json` is pretty-printed as text into a `<pre>` via `textContent`; if the body does not parse, the raw text is shown. `innerHTML` is never used.

## Consequences

- Machines filter one field; humans keep typing English on the same channel. No new storage architecture or endpoints.
- Arbitrary MIME types, attachments, binary and multipart payloads, a schema registry and payload encryption remain out of scope.
- Because the `text/plain` digest input is unchanged, deployed tenants keep their retry guarantees across the upgrade. Only a retry that changes the typing of a message conflicts.
- Renaming `text` to `body` was rejected: it would break every existing client for no functional gain.
