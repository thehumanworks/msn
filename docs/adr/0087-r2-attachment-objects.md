# ADR 0087: attachment bytes live in R2

Date: 2026-11-23. Status: Accepted.

Supersedes the storage, size, identity and media-type decisions in [ADR 0035](0035-message-attachments.md). ADR 0035 stays as the snapshot that put small files in Durable Object SQLite. Message JSON still omits `attachments` when a message has none. The fields ADR 0035 already returns (`index`, `id`, `name`, `mediaType`, `bytes`) stay, so older clients keep working.

## Context

ADR 0035 capped a file at 1 MiB and a message at 4 files because a SQLite value cannot exceed 8 MB (Durable Objects limits, retrieved 2026-11-23) and the bytes shared the workspace's 128 MiB text quota. People and agents need screenshots and logs larger than that, up to 25 MB per file and 10 files on one message.

A Worker request body on a Free or Pro zone is at most 100 MB (Workers limits, retrieved 2026-11-23). Ten files of 25 MB is 250 MB, which also exceeds a Worker's 128 MB memory. R2 holds objects up to 5 TiB; a single `put` of 25 MB is a normal upload (R2 limits, retrieved 2026-11-23). The bucket binding is `ATTACHMENTS`, bucket name `msn-attachments`. `wrangler deploy` fails when that bucket does not exist. Creating it is a pre-deploy step the owner runs; this change does not create the bucket and does not deploy. Tests use the local R2 simulator and do not need the real bucket.

This service has no cookies and no session login (ADR 0006, design.md). An `<img>` cannot send `Authorization`. A signed URL is the way a preview loads. Cookie auth would be a second login system.

## Decision

- **Bytes.** A new upload is an R2 object. The key is `{tenant}/{channel}/{uuid}`. The UUID is the public id. The user's file name is never a key or a path. The SHA-256 of the stored bytes is kept only so a retry of the same bytes in the same channel returns the same id and does not store a second object. Rows already stored under ADR 0035 stay in SQLite (`backend = 'sqlite'`, id is the old content hash) and download as before.
- **Metadata** stays in the workspace Durable Object: name, sniffed type, size, width, height, and which messages reference the object. Deleting a message or a board drops unreferenced objects from R2 after the SQL commit. Deletes are batched (up to 1000 keys) and best-effort: a failure is logged and the key is remembered in `attachment_gc`, then retried on the next delete. The failure does not fail the send or skip waking listeners. UUID keys are not reused, so a retry cannot remove a live object. A bucket lifecycle rule is the owner's option for anything this table never hears about; the worker does not list the bucket, because a list could delete a live object. An upload no message references is deleted after 24 hours, on a later upload, including its R2 object.
- **Limits, counted while reading.** 25 MB (26,214,400 bytes) per file and 10 files per message. Crossing either returns 413 before the extra bytes are stored: `attachment_too_large` or `too_many_attachments`. The send checks the count again. A multipart request stores each accepted file before reading the next, so a Worker holds one file, not ten. The Durable Object reads one attachment body at a time, so two 25 MB uploads do not sit in memory together. A later rejection leaves the earlier files as unused uploads; they expire after 24 hours and the message is not created. Ten full-size files do not fit in one zone request (100 MB on Free/Pro), so that case is ten `POST …/attachments` calls and one JSON send. `POST …/messages` also accepts `multipart/form-data` (text fields plus file parts) when the whole body fits. Fields the send understands are `username`, `text`, `contentType`, `replyTo`, `correlationId` and `to`. Any other field, including `sendAt`, is 400 `invalid_attachment` and is not ignored. A bad field after a file has already been stored leaves that file as an unused upload.
- **Quota.** R2 bytes do not consume the 128 MiB text quota. They consume a separate 1 GiB per workspace (`attachmentBytes`). One workspace cannot fill the account, and a 25 MB file is no longer rejected because the text quota has 20 MB left.
- **Type.** The server sniffs the bytes. The extension, the part's `Content-Type`, and a JSON `mediaType` are not the stored type. `mediaType` is still accepted on send so an older client does not get 400, and it still feeds the idempotency digest so an older retry still replays. The value that is stored and served is the sniff. Unknown binary is `application/octet-stream`. UTF-8 text with no NUL is `text/plain`.
- **Images.** Only sniffed PNG, JPEG, GIF and WebP are served inline; everything else (including SVG and HTML) is downloaded with its sniffed type. Every attachment response sets `X-Content-Type-Options: nosniff`. Before hashing or storing any new supported image, the server parses its complete container and keeps only allowlisted image reconstruction and display information. It drops original EXIF, XMP, IPTC, comments, embedded thumbnails, arbitrary colour profiles, private/unknown metadata and trailing bytes. JPEG scan data, PNG image and APNG animation chunks, WebP frames and animation chunks, and GIF frames, timing and loop controls are retained. The original EXIF is never copied: valid IFD0 orientation 2–8 is rebuilt as a canonical orientation-only TIFF block in JPEG, PNG or WebP; normal orientation 1 needs no block. Width and height describe the intended display (orientations 5–8 swap axes). Clients use their native image decoders. Malformed/unsupported containers or conflicting orientation values are 400 `invalid_attachment`; there is no original-byte fallback. The stored size is capped again after sanitisation, hashed for deduplication and charged to the attachment quota. This is container sanitisation, not full compressed-pixel validation or removal of information visible in the image, embedded in compressed pixel data, or exposed by the sender's filename. Legacy SQLite files and unrecognised/non-inline file types are outside this guarantee.
- **JSON.** When a message has files, each item is `{index, id, name, mediaType, mime, bytes, size, url, downloadUrl, width?, height?, previewUrl?}`. `mime` equals `mediaType`. `size` equals `bytes`. `url` is the stable path and requires a channel key. `downloadUrl` and, for an inline image, `previewUrl` are the same path with `exp` and `sig`, valid for about 10 minutes, minted in one-minute buckets so a retry in the same minute matches. A replay builds the message again, so the signed query is minted at read time and is not a stored snapshot. The signature is HMAC-SHA256 with a random key stored once in the workspace. Replacing that row would invalidate links that are still inside their ten minutes, so the key is not rotated. It authorizes that one object and nothing else. Both `exp` and `sig` must be present and valid to skip the channel key. One without the other, or a stale pair, falls through to the channel key. There is no cookie.
- **Empty text.** A send with at least one attachment may omit text or send a blank string. A send without an attachment still needs text. The idempotency digest of a send without attachments is unchanged.
- **Readers.** Message lists, catch-up, search and a single-message read already attach the list. The tenant is passed in with the page, so a gap in the id range cannot sign a URL with an empty tenant. A webhook notice (`msn.webhook.v1`) gains `attachments` (index, id, name, mime, size, url) only when the message has files. `url` is absolute: the server origin plus the path. The name is the one the sender chose, so it leaves the workspace in the notice. The notice does not include bytes or a signed URL. The notice cap is 16 KiB. Ten files with 255-byte names and absolute URLs fit. If a future notice would not, the file list is left off and the wake is still queued, so the send is not rolled back. A text-only notice is still the short id list. Empty text is stored in search as an empty string, counts only the username toward the text quota, and a push to the owner says "Sent a file".
- **Clients.** The web composer sends up to 10 files of 25 MB, allows a file with no text, previews inline images through `previewUrl` and opens them full size, and shows other files as a chip with name and size. The CLI and MCP use the same limits. `msn send --attach` with blank `--text` is allowed. Both iOS apps decode the list in the shared decoder and render the same preview and chip. A chip opens the signed download URL.

## Consequences

- Deploying this revision needs the `msn-attachments` R2 bucket to exist first. `wrangler deploy` fails without it. Creating the bucket is an explicit pre-deploy step for the owner. This change does not create the bucket and does not deploy.
- Content-addressed public ids are gone for new files. Dedup remains, but the id is a UUID, so a client cannot confirm a file by its hash.
- A signed URL is a bearer for one object until it expires. It is minted only for a reader who can already see the message. `Referrer-Policy: no-referrer` is already set on responses.
- Orientation is preserved without decoding or recompressing pixels by generating an orientation-only EXIF block. Native orientation handling must be verified for each format on supported clients, especially PNG and WebP on iOS. Arbitrary ICC profiles are removed for privacy, so wide-gamut or device-specific colours can render differently. GIF plain-text rendering extensions are rejected rather than retaining arbitrary text or changing the animation.
- Workspace attachment storage is capped at 1 GiB, not unlimited.

## Rejected

- Keeping bytes in SQLite. A 25 MB object cannot be a row.
- Public R2 URLs. Anyone with the URL could read the object, with no channel check.
- Cookie auth for `<img>`. The service has no cookies.
- Trusting the client MIME type or the extension. A `.png` that is HTML would render inline.
- Putting the signed URL in the webhook. It would expire before a slow receiver ran, and it is a capability the notice does not need.
- Editing ADR 0035 in place.
- Full pixel decode/re-encode or a remote image service solely for metadata removal. The 25 MiB compressed upload limit does not bound decoded pixel memory; Workers have a 128 MB isolate memory limit. See [Workers limits](https://developers.cloudflare.com/workers/platform/limits/). The parser uses one bounded additional buffer and does not decode pixels. No new runtime dependency or binding.

## Verification

```
Goal: files and images attach to a message; images preview inline; other files are a chip; downloads need channel access or a short-lived signature; old messages stay unchanged.
Invariants:
 I1 a file over 25 MB is 413 and is not stored -> tests/attachments.test.ts "validates uploads and references"
 I2 an 11th file is 413 at send -> tests/attachments.test.ts "validates uploads and references"
 I3 a .png whose bytes are HTML is served as text/html, attachment, not inline -> tests/attachments.test.ts "serves markup as a download and hardens file names"
 I4 SVG is stored and downloaded as attachment, never inline -> tests/attachments.test.ts "serves markup as a download and hardens file names"
 I5 a download without a channel key or a valid signature is 401 or 403 -> tests/attachments.test.ts "serves a short-lived image link without a bearer and refuses a bad or missing one" and "keeps uploads and downloads inside a channel-scoped key's channel"
 I6 a message with a file and blank text is stored; a blank message without a file is not -> tests/attachments.test.ts "accepts empty text when a file is attached and refuses it otherwise"
 I7 supported image container metadata is removed before storage; all eight orientations have correct display dimensions; output is deterministic and idempotent -> tests/image-sanitisation.test.ts and tests/attachments.test.ts "sanitises every upload route before hashing, storing, accounting and signing"
 I8 an unused upload is removed after 24 hours, including its R2 bytes from the attachment quota -> tests/attachments.test.ts "deletes unused uploads after 24 hours, but never a referenced file"
 I9 lists, catch-up and the webhook notice carry the attachment metadata and not the bytes -> tests/attachments.test.ts "uploads by content hash, sends, lists and downloads a file" and tests/webhooks.test.ts "includes attachment names in the notice and leaves the bytes out"
 I10 a message with no files has no attachments field -> tests/attachments.test.ts "keeps plain messages unchanged and replays retries with the same files"
 I11 malformed new images are rejected and invalid legacy dimensions are omitted -> tests/attachments.test.ts "rejects a malformed image before storage and omits invalid legacy dimensions"
 I12 an unknown multipart field is 400 and stores nothing when it arrives first -> tests/attachments.test.ts "sends a multipart message, rejects an unknown field, and keeps an earlier file when a later one is bad"
 I13 a webhook attachment url is absolute -> tests/webhooks.test.ts "includes attachment names in the notice and leaves the bytes out"
Edge cases: empty body, duplicate bytes, channel-scoped key, deleted message, name with bidi overrides, signed URL expiry and tamper, multipart send, two concurrent uploads, a clock-expired signature with a channel key, a legacy sqlite row sniffed on download.
Out of scope: attaching to a message already sent, exporting files in a channel archive, physically rotating or recompressing pixels, retroactively sanitising legacy SQLite files, sanitising unsupported formats, composing an attachment from the iOS keyboard (the phone displays and opens files; web, CLI and the API send them).
QA:
 - bun run test (Vitest includes image-sanitisation.test.ts, attachments.test.ts and attachment-bytes.test.ts; exact-cap image fixture and all upload routes)
 - bun run test:browser (verify oriented image rendering)
 - Check all eight orientations on the paired iPhone Air in both iOS apps; verify PNG, JPEG and WebP independently. Not covered by container-level tests.
 - node --test apps/ios/tests/decode.test.ts
 - cargo test --manifest-path cli/Cargo.toml -- attachments
```
