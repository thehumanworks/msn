# Design / security decisions

Current Cloudflare documentation retrieved 2026-09-14:
- https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/
- https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/
- https://developers.cloudflare.com/durable-objects/platform/limits/
- https://developers.cloudflare.com/workers/platform/limits/
- https://developers.cloudflare.com/workers/configuration/secrets/
- https://developers.cloudflare.com/workers/static-assets/binding/
- https://developers.cloudflare.com/workers/testing/vitest-integration/write-your-first-test/

## Isolation and identity

One SQLite-backed `MsnDurableObject` per `JSON.stringify(['tenant', tenantId])`. This keeps channel creation, indexed messages, idempotency and quotas in one transaction. Different tenants run concurrently on independent objects; a very hot single tenant is bounded by one object's throughput. Preserve the starter's class name and migration v1. SQL schema uses a schema_version table (version 1), because DO SQLite does not support PRAGMA user_version; future schema changes need explicit version migrations.

Admin-provisioned 256-bit random bearer capabilities grant all-channel read/write within ONE tenant, not deletion. A username is an unverified display identifier and may be impersonated by other tenant members. No login, cookies, or user directory. Token hashes are SHA-256; comparisons use the runtime timingSafeEqual API. Administrator operations require a separate Worker secret, checked before object dispatch and inside the object. Keys never enter URLs, client storage, or application logs. Rotation invalidates the old key and wakes/rejects old pending polls. The browser is same-origin, CSP-restricted and renders untrusted content via textContent. It has no admin interface.

## Ordering and polling

Messages have server-generated ISO UTC creation timestamps and tenant-local AUTOINCREMENT integer IDs (never reused). Queries are indexed by channel/deleted/id and return ascending IDs strictly greater than `after`. Cursor advances only to the last delivered message; empty polls retain it. Pages have `hasMore`. Polls are fan-out, NOT a work queue: concurrent listeners all receive a copy; reading never changes history. Repeat any cursor to reread surviving messages. No channel or tenant deletion/recreation endpoint is exposed, avoiding cursor generation ambiguity.

A single synchronous read/register critical section prevents missed notifications. Long polls are bounded to 25 seconds and 128 pending requests per tenant. Timeout, abort, send and key rotation share idempotent timer/listener cleanup. All wakes query SQL again. A client disconnect is not assumed to propagate instantly across Worker→DO fetch; the timer independently guarantees bounded cleanup. Deployments/restarts may fail pending requests: clients reconnect using their last cursor with backoff. UI live history is capped at 1,000 displayed messages, not server retention.

## Writes, deletion and limits

Synchronous transactions atomically check idempotency, create channels, insert messages and update quota counters. Output gates hold responses until persistence. Idempotency keys are channel-scoped; same key+payload returns the existing result, conflicting content returns 409. Retries of deleted messages return 410; tombstones retain only metadata/digest, not username/text. Admin deletion immediately removes content from subsequent reads; it cannot recall already-delivered copies (UI Reread refreshes deletion). Cloudflare PITR/backups can retain historical storage for their platform recovery window; this is not a cryptographic erasure guarantee.

Application limits: 32 KiB streamed JSON bodies; 16 KiB UTF-8 message text; 128-byte usernames; 64-character tenant/channel slugs; 128-character retry keys; 100 messages/page; 1,000 channels/tenant; 100,000 lifetime messages/tenant; 128 MiB active text+username content/tenant. Deleted rows still count toward lifetime quota to preserve retry tombstones; deletion frees active content quota. IDs stay safely below JavaScript's safe integer ceiling. History does not expire automatically. Quota failures reject writes explicitly; there is no silent retention or data loss. A new tenant is required at the lifetime limit.

Cloudflare docs currently describe 10 GB/object on Paid and 1 GB/object on Free, plus account/plan request and storage quotas. Application content and row limits leave headroom, but billing, index overhead and account quotas still require monitoring. Continuous long polling keeps DOs active and incurs duration/request cost. This is a capability-secured team service, not a public abuse-resistant chat network; per-member identity, per-channel ACLs, read receipts, global rate limiting, queues and multi-region replication outside Cloudflare DO guarantees are not claimed.
