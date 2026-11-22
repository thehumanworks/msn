import type { AppModel } from "../../../ios/src/core/appModel.ts";
import { validateOrigin } from "../../../ios/src/core/httpClient.ts";
import type { JoinLink } from "./joinLink.ts";
import { ensurePersona, type Fetch, type RandomBytes, validName } from "./persona.ts";

export type JoinResult = { error: string } | { board: string | null };

/** What a join needs from the app, passed in so the routing is testable without React Native. */
export type JoinDeps = {
  model: Pick<AppModel, "signInWithKey" | "redeemInvitation">;
  fetchImpl?: Fetch;
  randomBytes: RandomBytes;
};

/**
 * Signs in with what the person pasted. Every path ends in the shared AppModel, which verifies the
 * key, saves the profile to the keychain and starts the session. Returns the board to open first.
 */
export async function join(link: JoinLink, name: string, server: string, deps: JoinDeps): Promise<JoinResult> {
  const { model } = deps;
  const remember = true;
  try {
    if (link.kind === "account") {
      const error = await model.signInWithKey({
        origin: link.origin,
        tenant: link.tenant,
        username: link.username,
        token: link.token,
        remember,
      });
      return error ? { error } : { board: null };
    }
    const nameError = validName(name);
    if (nameError) return { error: nameError };
    if (link.kind === "invite") {
      const origin = link.origin ?? server;
      const error = await model.redeemInvitation({
        origin,
        tenant: link.tenant,
        username: name.trim(),
        code: link.code,
        remember,
      });
      return error ? { error } : { board: null };
    }
    const origin = validateOrigin(link.origin).origin;
    await ensurePersona(
      { origin, tenant: link.tenant, board: link.board, token: link.token, name },
      deps.fetchImpl,
      deps.randomBytes,
    );
    const error = await model.signInWithKey({
      origin,
      tenant: link.tenant,
      username: name.trim(),
      token: link.token,
      remember,
    });
    return error ? { error } : { board: link.board };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Could not join." };
  }
}
