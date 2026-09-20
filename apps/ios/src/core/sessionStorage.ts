import { validateOrigin } from "./httpClient.ts";
import type { Session } from "./session.ts";

/** Keychain-style secret storage. Implemented with expo-secure-store on device. */
export type SecretStore = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
};

/**
 * The single remembered session of versions before saved profiles (ADR 0021). It is only read now,
 * once, by `migrateLegacySession`; new saves go through `profileStorage.ts`.
 */
export const SESSION_KEY = "msn.session.v1";
const SLUG = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const TOKEN = /^[A-Za-z0-9_-]{32,256}$/;

export function isSession(value: unknown): value is Session {
  if (typeof value !== "object" || value === null) return false;
  const s = value as Record<string, unknown>;
  try {
    if (typeof s.origin !== "string" || validateOrigin(s.origin).origin !== s.origin) return false;
  } catch {
    return false;
  }
  return (
    typeof s.tenant === "string" &&
    SLUG.test(s.tenant) &&
    typeof s.token === "string" &&
    TOKEN.test(s.token) &&
    typeof s.username === "string" &&
    s.username.length > 0 &&
    (s.usernamePrefix === null || typeof s.usernamePrefix === "string") &&
    (s.channel === undefined || (typeof s.channel === "string" && SLUG.test(s.channel)))
  );
}

export async function saveSession(store: SecretStore, session: Session): Promise<void> {
  await store.set(SESSION_KEY, JSON.stringify(session));
}

/** Returns null for missing, corrupt or tampered data (which is also removed). Storage errors throw. */
export async function loadSession(store: SecretStore): Promise<Session | null> {
  const raw = await store.get(SESSION_KEY);
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (isSession(parsed)) return parsed;
  } catch {
    // fall through to removal
  }
  await store.remove(SESSION_KEY).catch(() => undefined);
  return null;
}

/** True if nothing remains stored afterwards; false means a token may still be on the device. */
export async function forgetSession(store: SecretStore): Promise<boolean> {
  try {
    await store.remove(SESSION_KEY);
    return true;
  } catch {
    return false;
  }
}
