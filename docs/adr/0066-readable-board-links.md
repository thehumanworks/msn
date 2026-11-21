# ADR 0066: readable board links

Date: 2026-11-21. Status: implemented (web, curl quickstart, README). No Worker API or schema change.

## Context

The owner found the board links from **Invite** ugly to paste into a chat. The web app put URL-encoded JSON in the fragment, so a link looked like:

```
https://msn.thehuman.sh/#board=%7B%22url%22%3A%22https%3A%2F%2Fmsn.thehuman.sh%22%2C%22tenant%22%3A%22account-abc%22%2C%22token%22%3A%22<key>%22%2C%22channel%22%3A%22msn-chat%22%2C%22sharedChannel%22%3Atrue%7D
```

Constraints: the link must keep granting exactly what it granted (the board's shared key, ADR 0026), joining must take no extra step, the key must stay out of the path and query string so it never reaches server logs, and links already shared must keep working.

## Decision

**A board link is `ORIGIN/#board=TENANT/CHANNEL&key=KEY`.** For example `https://msn.thehuman.sh/#board=account-abc/msn-chat&key=<key>`. It reads like a message link (`#board=TENANT/CHANNEL&msg=ID`, ADR 0042). Tenants and boards are slugs and the key is hex, so nothing needs escaping. The JSON fields it drops were redundant: `url` is the origin the link opens, and `sharedChannel` is always true for a board link.

- The key stays in the fragment, which browsers never send to the server. Security properties are unchanged.
- The web app reads both forms. With `key`, `board` must be exactly two slugs and the key 16 to 256 URL-safe characters. Without `key`, the old JSON form is parsed as before, including the check that its `url` is this origin. Anything else shows "Invalid channel connection.", and the fragment is cleared from the address bar either way.
- A link with both `msg` and `key` is refused as a message link ("Invalid message link."), as a message link with `invite` or `account` already is: a message link never carries a credential.
- `GET /board/connection` still returns the JSON connection; only the web app's Invite dialog formats the link. The curl quickstart (`GET /api`), README and the "Copy curl commands" script say "the part after `key=`" instead of a decode step.

Other clients do not build or read board links: the CLI, desktop and iOS apps use connection files, invitation codes and message links, which are unchanged. Invitation links (`#invite=TENANT.CODE`) were already readable.

## Considered

**A short server-side code** (`/j/abc123` redeemed for the key) would be shorter still, but anyone holding the code could redeem it, the code would sit in the path (server logs), and it needs new storage and expiry rules. Not needed to fix the complaint; the readable link is about as long as an invitation link plus the key.

**base64url of the JSON** removes the `%22` but is still opaque and no shorter.
