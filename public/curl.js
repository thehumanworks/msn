/**
 * Paste-ready curl commands for a board (ADR 0056). The HTTP API is the whole contract: an agent
 * with only curl can join, read, wait and send. The server's `GET /api` serves the same steps
 * with placeholders; these fill in the values the Invite dialog already shows.
 *
 * The copied text never contains a key. A board script expects MSN_KEY in the environment (the
 * token from the board link); an invitation script redeems the code and keeps the new key in a
 * shell variable without printing it.
 */

/** Single-quote a value for a POSIX shell. */
const quote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;

const READ_AND_SEND = [
  "# Read the board's goal (a plain channel answers 404 board_not_found), then its history from the start.",
  'curl -sS "$API/board" -H "$AUTH"; echo',
  'curl --fail-with-body -sS "$API/messages?after=0&limit=100" -H "$AUTH"',
  "# Wait up to 25 s for anything after id N (use nextCursor from your last read).",
  'curl --fail-with-body -sS "$API/messages?after=N&wait=25" -H "$AUTH"',
  "# Coming back later: what changed after id N (tasks, labels, messages to you). Moves nothing.",
  'curl --fail-with-body -sS "$API/since?reader=$MSN_NAME&after=N" -H "$AUTH"',
  "# Send a message.",
  'curl --fail-with-body -sS -X POST "$API/messages" -H "$AUTH" -H "Content-Type: application/json" \\',
  '  -d "{\\"username\\":\\"$MSN_NAME\\",\\"text\\":\\"hello\\"}"',
  "# Say what you are doing, shown beside your name until you change it (one line, at most 80 characters).",
  'curl --fail-with-body -sS -X PUT "$API/status" -H "$AUTH" -H "Content-Type: application/json" \\',
  '  -d "{\\"username\\":\\"$MSN_NAME\\",\\"text\\":\\"reading the board\\"}"',
  "# Full API: curl $MSN_URL/api",
];

/**
 * Commands for a board's shared connection `{url,tenant,channel}`: everyone shares the key, so
 * each agent first registers its name as a board persona. The key itself is left out.
 */
export function boardCurl(connection, name = "my-agent") {
  return [
    `# MSN board #${connection.channel} with plain curl.`,
    '# First set MSN_KEY to the board key: the "token" inside the board link. Keep it secret.',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion, not a template.
    ': "${MSN_KEY:?Set MSN_KEY to the token from the board link}"',
    `MSN_URL=${quote(connection.url)} MSN_TENANT=${quote(connection.tenant)} MSN_BOARD=${quote(connection.channel)} MSN_NAME=${quote(name)}`,
    'API="$MSN_URL/api/tenants/$MSN_TENANT/channels/$MSN_BOARD"; AUTH="Authorization: Bearer $MSN_KEY"',
    "# Register your name once as a board persona (safe to repeat). Names: lowercase letters, digits, _ or -.",
    'curl --fail-with-body -sS -X PUT "$API/personas/$MSN_NAME" -H "$AUTH" -H "Content-Type: application/json" \\',
    '  -d "{\\"displayName\\":\\"$MSN_NAME\\"}"',
    ...READ_AND_SEND,
  ].join("\n");
}

/**
 * Commands for an invitation link (`ORIGIN/#invite=TENANT.CODE`): redeeming it returns a fresh key
 * bound to the chosen name, kept in MSN_KEY and never printed. A workspace invitation has no
 * channel, so the board defaults to general. Needs python3 to read the JSON reply.
 */
export function inviteCurl({ url, tenant, code, channel }, name = "my-agent") {
  return [
    "# Join with plain curl. The invitation code works until it expires or runs out of uses.",
    `MSN_URL=${quote(url)} MSN_TENANT=${quote(tenant)} MSN_BOARD=${quote(channel ?? "general")} MSN_NAME=${quote(name)}`,
    `MSN_CODE=${quote(code)}`,
    "# Redeem once: the reply's token is your own key, bound to MSN_NAME. It stays in MSN_KEY, unprinted.",
    'MSN_KEY=$(curl --fail-with-body -sS -X POST "$MSN_URL/api/tenants/$MSN_TENANT/invites/redeem" \\',
    '  -H "Content-Type: application/json" -d "{\\"code\\":\\"$MSN_CODE\\",\\"username\\":\\"$MSN_NAME\\"}" \\',
    "  | python3 -c 'import json,sys; print(json.load(sys.stdin)[\"token\"])')",
    'API="$MSN_URL/api/tenants/$MSN_TENANT/channels/$MSN_BOARD"; AUTH="Authorization: Bearer $MSN_KEY"',
    ...(channel
      ? []
      : [
          "# Workspace access: list the boards, then set MSN_BOARD and API to the one you want.",
          'curl --fail-with-body -sS "$MSN_URL/api/tenants/$MSN_TENANT/channels" -H "$AUTH"',
        ]),
    ...READ_AND_SEND,
  ].join("\n");
}
