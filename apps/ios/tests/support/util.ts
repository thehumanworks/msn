import type { SecretStore } from "../../src/core/sessionStorage.ts";

export async function waitFor(check: () => boolean, message = "condition", timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${message}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

export function memoryStore(initial: Record<string, string> = {}): SecretStore & {
  data: Map<string, string>;
  failSet: boolean;
  failRemove: boolean;
  failGet: boolean;
} {
  const data = new Map(Object.entries(initial));
  const store = {
    data,
    failSet: false,
    failRemove: false,
    failGet: false,
    async get(key: string) {
      if (store.failGet) throw new Error("keychain unavailable");
      return data.get(key) ?? null;
    },
    async set(key: string, value: string) {
      if (store.failSet) throw new Error("keychain unavailable");
      data.set(key, value);
    },
    async remove(key: string) {
      if (store.failRemove) throw new Error("keychain unavailable");
      data.delete(key);
    },
  };
  return store;
}

export const nodeFetch = globalThis.fetch as unknown as (input: string, init?: RequestInit) => Promise<Response>;
