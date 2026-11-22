import type { JoinLink } from "./joinLink.ts";
import { model } from "./model.ts";
import { getRandomBytes } from "expo-crypto";
import { ensurePersona, type Fetch, validName } from "./persona.ts";
import { validateOrigin } from "./shared.ts";

export type JoinResult = { error: string } | { board: string | null };

/**
 * Signs in with what the person pasted. Every path ends in the shared AppModel, which verifies the
 * key, saves the profile to the keychain and starts the session. Returns the board to open first.
 */
export async function join(link: JoinLink, name: string, server: string, fetchImpl: Fetch): Promise<JoinResult> {
  const remember = true;
  try {
    if (link.kind === "account") {
      const error = await model.signInWithKey({ origin: link.origin, tenant: link.tenant, username: link.username, token: link.token, remember });
      return error ? { error } : { board: null };
    }
    const nameError = validName(name);
    if (nameError) return { error: nameError };
    if (link.kind === "invite") {
      const origin = link.origin ?? server;
      const error = await model.redeemInvitation({ origin, tenant: link.tenant, username: name.trim(), code: link.code, remember });
      return error ? { error } : { board: null };
    }
    const origin = validateOrigin(link.origin).origin;
    await ensurePersona({ origin, tenant: link.tenant, board: link.board, token: link.token, name }, fetchImpl, getRandomBytes);
    const error = await model.signInWithKey({ origin, tenant: link.tenant, username: name.trim(), token: link.token, remember });
    return error ? { error } : { board: link.board };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Could not join." };
  }
}
