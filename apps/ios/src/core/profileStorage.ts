import type { Session } from "./session.ts";
import { isSession, loadSession, SESSION_KEY, type SecretStore } from "./sessionStorage.ts";

/**
 * Saved profiles (ADR 0021): several remembered connections, each named after the user and the
 * workspace, all in the keychain and nowhere else.
 *
 * Layout: `msn.profiles.v1` is the index (a JSON array of names, which keeps it far below the
 * keychain's per-item size guidance), `msn.profile.v1.<name>` holds one Session, and
 * `msn.active.v1` names the profile to reopen on launch. Secure storage cannot enumerate keys, so
 * the index is the only way to find a stored key again. Writes are therefore ordered so that every
 * stored key is always listed: a save lists the name before it writes the key, and a removal
 * deletes the key before it unlists the name. An interruption leaves at worst a listed name with
 * no key, which the next read removes.
 */
export const PROFILE_INDEX_KEY = "msn.profiles.v1";
export const ACTIVE_PROFILE_KEY = "msn.active.v1";
export const MAX_PROFILES = 16;

const NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export const profileKey = (name: string): string => `msn.profile.v1.${name}`;

/** What a profile picker may show. Never contains the key. */
export type ProfileSummary = {
  name: string;
  origin: string;
  tenant: string;
  username: string;
  channel?: string;
};

export function summarize(name: string, session: Session): ProfileSummary {
  return {
    name,
    origin: session.origin,
    tenant: session.tenant,
    username: session.username,
    ...(session.channel ? { channel: session.channel } : {}),
  };
}

function sameIdentity(profile: ProfileSummary, session: Session): boolean {
  return (
    profile.origin === session.origin &&
    profile.tenant === session.tenant &&
    profile.username === session.username &&
    (profile.channel ?? null) === (session.channel ?? null)
  );
}

/**
 * The name a session is saved under: the existing profile for the same user, workspace and server
 * (so a rotated key replaces the old one instead of piling up), otherwise `alice-my-team`, then
 * `alice-my-team-2`, …. Returns null when the device already holds MAX_PROFILES other profiles.
 */
export function planProfileName(profiles: readonly ProfileSummary[], session: Session): string | null {
  const existing = profiles.find((profile) => sameIdentity(profile, session));
  if (existing) return existing.name;
  if (profiles.length >= MAX_PROFILES) return null;
  const user = session.username
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "");
  const base = (user ? `${user}-${session.tenant}` : session.tenant).slice(0, 60).replace(/[-_]+$/g, "");
  const safe = NAME.test(base) ? base : "profile";
  const taken = new Set(profiles.map((profile) => profile.name));
  for (let attempt = 1; ; attempt += 1) {
    const candidate = attempt === 1 ? safe : `${safe}-${attempt}`;
    if (!taken.has(candidate)) return candidate;
  }
}

async function readIndex(store: SecretStore): Promise<string[]> {
  const raw = await store.get(PROFILE_INDEX_KEY);
  if (raw === null) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      const names = parsed.filter((name): name is string => typeof name === "string" && NAME.test(name));
      return [...new Set(names)].slice(0, MAX_PROFILES);
    }
  } catch {
    // fall through: an unreadable index is treated as empty
  }
  return [];
}

async function writeIndex(store: SecretStore, names: readonly string[]): Promise<void> {
  if (names.length === 0) await store.remove(PROFILE_INDEX_KEY);
  else await store.set(PROFILE_INDEX_KEY, JSON.stringify(names));
}

/** Null for a missing, corrupt or tampered profile, which is also removed and unlisted. */
export async function readProfile(store: SecretStore, name: string): Promise<Session | null> {
  if (!NAME.test(name)) return null;
  const raw = await store.get(profileKey(name));
  if (raw !== null) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (isSession(parsed)) return parsed;
    } catch {
      // fall through to removal
    }
  }
  await removeProfile(store, name).catch(() => undefined);
  return null;
}

/** Every valid saved profile, sorted by name. Invalid entries heal themselves away. */
export async function listProfiles(store: SecretStore): Promise<ProfileSummary[]> {
  const summaries: ProfileSummary[] = [];
  for (const name of await readIndex(store)) {
    const session = await readProfile(store, name);
    if (session) summaries.push(summarize(name, session));
  }
  return summaries.sort((a, b) => a.name.localeCompare(b.name));
}

/** Creates or replaces `name`. The name is listed before the key is written. */
export async function writeProfile(store: SecretStore, name: string, session: Session): Promise<void> {
  if (!NAME.test(name)) throw new Error("Invalid profile name.");
  const names = await readIndex(store);
  if (!names.includes(name)) {
    if (names.length >= MAX_PROFILES) throw new Error("Too many saved profiles.");
    await writeIndex(store, [...names, name]);
  }
  await store.set(profileKey(name), JSON.stringify(session));
}

/** Deletes the key first, then unlists the name. Throws if the key may still be on the device. */
export async function removeProfile(store: SecretStore, name: string): Promise<void> {
  if (!NAME.test(name)) return;
  await store.remove(profileKey(name));
  const names = await readIndex(store);
  if (names.includes(name)) await writeIndex(store, names.filter((other) => other !== name));
  if ((await store.get(ACTIVE_PROFILE_KEY)) === name) await store.remove(ACTIVE_PROFILE_KEY);
}

export async function readActive(store: SecretStore): Promise<string | null> {
  const name = await store.get(ACTIVE_PROFILE_KEY);
  return name !== null && NAME.test(name) ? name : null;
}

export async function writeActive(store: SecretStore, name: string | null): Promise<void> {
  if (name === null) await store.remove(ACTIVE_PROFILE_KEY);
  else await store.set(ACTIVE_PROFILE_KEY, name);
}

/**
 * One-time upgrade from the single remembered session (`msn.session.v1`): it becomes a profile and
 * stays the active one, so an existing user is still signed in after updating. The legacy key is
 * removed only after the profile has been written.
 */
export async function migrateLegacySession(store: SecretStore): Promise<void> {
  if ((await store.get(SESSION_KEY)) === null) return;
  const session = await loadSession(store); // removes corrupt data itself
  if (!session) return;
  const name = planProfileName(await listProfiles(store), session);
  if (name !== null) {
    await writeProfile(store, name, session);
    await writeActive(store, name);
  }
  await store.remove(SESSION_KEY);
}
