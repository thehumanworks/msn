import * as SecureStore from "expo-secure-store";
import type { SecretStore } from "../core/sessionStorage.ts";

// Tokens live only in the iOS keychain, readable only while unlocked and never migrated to a
// new device or included in backups. They are never written to AsyncStorage, logs or URLs.
const options = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY } as const;

export const keychainStore: SecretStore = {
  get: (key) => SecureStore.getItemAsync(key, options),
  set: (key, value) => SecureStore.setItemAsync(key, value, options),
  remove: (key) => SecureStore.deleteItemAsync(key, options),
};
