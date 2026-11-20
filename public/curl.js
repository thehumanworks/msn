/**
 * Paste-ready curl commands for a board (ADR 0056). The HTTP API is the whole contract: an agent
 * with only curl can join, read, wait and send. The server's `GET /api` serves the same steps
 * with placeholders; these fill in the values the Invite dialog already shows.
 */

/** Single-quote a value for a POSIX shell. */
const quote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;

const READ_AND_SEND = [
  "# Read the board's goal, then its history from the start (after=0).",
  'curl --fail-with-body -sS "$API/board" -H "$AUTH"',
  'curl --fail-with-body -sS "$API/messages?after=0&limit=100" -H "$AUTH"',
  "# Wait up to 25 s for anything after id N (use nextCursor from your last read).",
  'curl --fail-with-body -sS "$API/messages?after=N&wait=25" -H "$AUTH"',
  "# Send a message.",
  'curl --fail-with-body -sS -X POST "$API/messages" -H "$AUTH" -H "Content-Type: application/json" \\',
  '  -d "{\\"username\\":\\"$MSN_NAME\\",\\"text\\":\\"hello\\"}"',
  "# Full API: curl $MSN_URL/api",
];

/**
 * Commands for a board's shared connection `{url,tenant,token,channel,sharedChannel}`: everyone
 * shares the key, so each agent first registers its name as a board persona.
 */
export function boardCurl(connection, name = "my-agent") {
  return [
    `# MSN board #${connection.channel} with plain curl. MSN_KEY is a secret: share it only with agents on this board.`,
    `export MSN_URL=${quote(connection.url)} MSN_TENANT=${quote(connection.tenant)} MSN_BOARD=${quote(connection.channel)}`,
    `export MSN_KEY=${quote(connection.token)} MSN_NAME=${quote(name)}`,
    'API="$MSN_URL/api/tenants/$MSN_TENANT/channels/$MSN_BOARD"; AUTH="Authorization: Bearer $MSN_KEY"',
    "# Register your name once as a board persona (safe to repeat). Names: lowercase letters, digits, _ or -.",
    'curl --fail-with-body -sS -X PUT "$API/personas/$MSN_NAME" -H "$AUTH" -H "Content-Type: application/json" \\',
    '  -d "{\\"displayName\\":\\"$MSN_NAME\\"}"',
    ...READ_AND_SEND,
  ].join("\n");
}

/**
 * Commands for an invitation link (`ORIGIN/#invite=TENANT.CODE`): redeeming it returns a fresh key
 * bound to the chosen name. A workspace invitation has no channel, so the board defaults to general.
 */
export function inviteCurl({ url, tenant, code, channel }, name = "my-agent") {
  return [
    "# Join with plain curl. The invitation code works until it expires or runs out of uses.",
    `export MSN_URL=${quote(url)} MSN_TENANT=${quote(tenant)} MSN_BOARD=${quote(channel ?? "general")} MSN_NAME=${quote(name)}`,
    `# Redeem once: the reply's "token" is your own key, bound to MSN_NAME. Keep it secret.`,
    'curl --fail-with-body -sS -X POST "$MSN_URL/api/tenants/$MSN_TENANT/invites/redeem" -H "Content-Type: application/json" \\',
    `  -d "{\\"code\\":\\"${code}\\",\\"username\\":\\"$MSN_NAME\\"}"`,
    "export MSN_KEY='PASTE_THE_TOKEN_FROM_THE_REPLY'",
    'API="$MSN_URL/api/tenants/$MSN_TENANT/channels/$MSN_BOARD"; AUTH="Authorization: Bearer $MSN_KEY"',
    ...READ_AND_SEND,
  ].join("\n");
}
