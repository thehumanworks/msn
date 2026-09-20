import type { SendMessageInput } from "./apiClient.ts";

const KEY_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/** Matches the server's `^[A-Za-z0-9_-]{1,128}$` Idempotency-Key format. */
export function generateIdempotencyKey(random: () => number = Math.random): string {
  let key = "";
  for (let i = 0; i < 32; i += 1) key += KEY_ALPHABET[Math.floor(random() * KEY_ALPHABET.length)];
  return key;
}

export type PendingSend = { key: string; input: SendMessageInput };

/** A fresh draft always gets a fresh key. */
export function createPendingSend(
  input: SendMessageInput,
  generateKey: () => string = generateIdempotencyKey,
): PendingSend {
  return { key: generateKey(), input };
}
