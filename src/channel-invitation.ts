import { HttpError } from "./http";

/** Parse only same-server, channel-invitation-shaped input. The tenant checks its scope at redemption. */
export function channelInvitation(value: string, origin: string) {
  const invalid = () =>
    new HttpError(400, "invalid_invite", "Use a channel invitation from this MSN server.");
  if (!value || value.length > 2048) throw invalid();
  let code = value.trim();
  if (code.includes("://")) {
    let url: URL;
    try {
      url = new URL(code);
    } catch {
      throw invalid();
    }
    if (url.origin !== origin || url.username || url.password || url.search || url.pathname !== "/")
      throw invalid();
    const fragment = new URLSearchParams(url.hash.slice(1));
    if (fragment.size !== 1 || !fragment.has("invite")) throw invalid();
    code = fragment.get("invite") ?? "";
  }
  const match = /^([a-z0-9][a-z0-9_-]{0,63})\.[a-f0-9]{64}$/.exec(code);
  if (!match) throw invalid();
  return { tenant: match[1], code };
}
