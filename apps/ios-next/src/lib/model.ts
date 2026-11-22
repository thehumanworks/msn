import { fetch as expoFetch } from "expo/fetch";
import * as SecureStore from "expo-secure-store";
import { createContext, useContext } from "react";
import { AppModel, type SecretStore, type SessionController } from "./shared.ts";

// Keys live only in the iOS keychain, readable while the device is unlocked, never migrated to
// another device or included in backups (the same policy as apps/ios, ADR 0021).
const options = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY } as const;
const keychain: SecretStore = {
  get: (key) => SecureStore.getItemAsync(key, options),
  set: (key, value) => SecureStore.setItemAsync(key, value, options),
  remove: (key) => SecureStore.deleteItemAsync(key, options),
};

// The shared client sends every request with redirect: "manual" and refuses any 3xx or a
// response from another origin, so the bearer key never follows a redirect off the configured
// origin. expo/fetch supports manual redirects; it is passed in explicitly, not looked up lazily.
export const transport = ((input: string, init?: RequestInit) =>
  expoFetch(input, init as Parameters<typeof expoFetch>[1]) as unknown as Promise<Response>);

/** The one model: it owns every session controller and so the single event subscription. */
export const model = new AppModel(keychain, { fetchImpl: transport });

export { DEFAULT_ORIGIN } from "./joinLink.ts";

export const SessionContext = createContext<SessionController | null>(null);

export function useSession(): SessionController {
  const session = useContext(SessionContext);
  if (!session) throw new Error("useSession outside a connected session");
  return session;
}

/** A board to open as soon as a just-joined session is ready (a board link names one). */
export const pending: { board: string | null } = { board: null };
