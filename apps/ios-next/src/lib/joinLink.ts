/**
 * What the person pasted to join, in the same forms the web app accepts (public/app.js,
 * public/access.js):
 *
 * - an invitation link `ORIGIN/#invite=TENANT.CODE`, or the bare `TENANT.CODE`: redeemed for a
 *   fresh key bound to the name the person chooses;
 * - a board link `ORIGIN/#board=TENANT/BOARD&key=KEY`: the board's shared key, used with the
 *   name the person chooses;
 * - a portable account connection (the JSON file from `msn connection-export`, or a link with
 *   `#account=JSON`), which already names the user.
 *
 * A message link (`#board=…&msg=…`) carries no credential and is refused here.
 */
export type JoinLink =
  | { kind: "invite"; origin: string | null; tenant: string; code: string }
  | { kind: "board"; origin: string; tenant: string; board: string; token: string }
  | { kind: "account"; origin: string; tenant: string; token: string; username: string };

export type JoinParse = { ok: true; link: JoinLink } | { ok: false; error: string };

const SLUG = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const INVITE = /^([a-z0-9][a-z0-9_-]{0,63})\.([a-f0-9]{64})$/;
const KEY = /^[A-Za-z0-9_-]{32,256}$/;
const MAX_INPUT = 65536;

/** The production server. Invitation codes and access keys that carry no origin use it. */
export const DEFAULT_ORIGIN = "https://msn.thehuman.sh";

const fail = (error: string): JoinParse => ({ ok: false, error });

const USERINFO = "That link puts a name before its server, which can disguise where it goes. Ask for a new link.";

function originOf(value: string): string | null {
  try {
    const url = new URL(value);
    // http only for a server on this machine, as the shared client allows (validateOrigin).
    const local = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
    if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) return null;
    // `https://msn.thehuman.sh@evil.example/` goes to evil.example: never accept userinfo.
    if (url.username || url.password) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function account(data: unknown): JoinParse {
  if (!data || typeof data !== "object") return fail("That account connection is not valid.");
  const { url, tenant, token, username } = data as Record<string, unknown>;
  const origin = typeof url === "string" ? originOf(url) : null;
  if (!origin || typeof tenant !== "string" || !SLUG.test(tenant)) return fail("That account connection is not valid.");
  if (typeof token !== "string" || !KEY.test(token)) return fail("That account connection has no usable key.");
  if (typeof username !== "string" || !username.trim()) return fail("That account connection names no user.");
  return { ok: true, link: { kind: "account", origin, tenant, token, username } };
}

export function parseJoinLink(input: string): JoinParse {
  const text = input.trim();
  if (!text) return fail("Paste an invitation or board link.");
  if (text.length > MAX_INPUT) return fail("That is too long to be an MSN link.");

  const bare = INVITE.exec(text);
  if (bare) return { ok: true, link: { kind: "invite", origin: null, tenant: bare[1] as string, code: text } };

  if (text.startsWith("{")) {
    try {
      return account(JSON.parse(text));
    } catch {
      return fail("That account connection is not valid JSON.");
    }
  }

  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return fail("Paste a complete invitation or board link.");
  }
  if (url.username || url.password) return fail(USERINFO);
  const origin = originOf(text);
  if (!origin) return fail("MSN links start with https://.");
  if (url.search || (url.pathname !== "/" && url.pathname !== "")) return fail("That is not an MSN join link.");
  const params = new URLSearchParams(url.hash.slice(1));

  if (params.has("msg")) return fail("That links to a message. Ask for an invitation or board link to join.");

  const invite = params.get("invite");
  if (invite !== null) {
    const match = INVITE.exec(invite);
    if (!match) return fail("That invitation link is incomplete.");
    return { ok: true, link: { kind: "invite", origin, tenant: match[1] as string, code: invite } };
  }

  const board = params.get("board");
  if (board !== null) {
    const token = params.get("key");
    if (token === null) return fail("That board link has no key. Ask the board's owner for its Invite link.");
    const [tenant = "", name = "", ...rest] = board.split("/");
    if (rest.length || !SLUG.test(tenant) || !SLUG.test(name)) return fail("That board link is not valid.");
    if (!KEY.test(token)) return fail("That board link's key is not valid.");
    return { ok: true, link: { kind: "board", origin, tenant, board: name, token } };
  }

  const connection = params.get("account");
  if (connection !== null) {
    try {
      const parsed = account(JSON.parse(connection));
      if (parsed.ok && parsed.link.origin !== origin) return fail("Open this connection on its own MSN server.");
      return parsed;
    } catch {
      return fail("That account connection is not valid JSON.");
    }
  }

  return fail("That link has no invitation or board in it.");
}

/** Who the link lets you in as, for the join card. */
export function describeJoin(link: JoinLink): string {
  switch (link.kind) {
    case "invite":
      return `Invitation to ${link.tenant}`;
    case "board":
      return `Board # ${link.board} in ${link.tenant}`;
    case "account":
      return `${link.username} in ${link.tenant}`;
  }
}

/**
 * The server a join sends the key to, as the join card shows it. `host` is the URL parser's
 * (punycode for international names, with any port), so look-alikes such as
 * `msn.thehuman.sh.evil.example` read as what they are. `official` is false for any server
 * other than the production one, and the card then warns before Join.
 */
export function joinServer(link: JoinLink, server: string): { host: string; official: boolean } | null {
  const origin = link.origin ?? server.trim();
  try {
    const url = new URL(origin);
    if (url.username || url.password || originOf(url.origin) === null) return null;
    return { host: url.host, official: url.origin === DEFAULT_ORIGIN };
  } catch {
    return null;
  }
}
