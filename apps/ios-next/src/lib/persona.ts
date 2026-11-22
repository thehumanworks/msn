/**
 * A board's shared key (a `#board=…&key=…` link) posts only as a registered persona: the server
 * answers `persona_required` otherwise. Before the first sign-in with such a key this registers
 * the chosen name, or reuses the persona that already has it, exactly as the web app does
 * (public/app.js, connect). Registering is idempotent by name, so repeating a join is safe.
 *
 * Both calls go through the shared HttpClient, so they stay on the link's origin, refuse
 * redirects, time out and read at most a bounded response, like every other request.
 */
// Imported from the shared core directly, not through shared.ts, whose hooks need React Native
// and would keep this module out of the Node tests.
import { ApiError, ProtocolError } from "../../../ios/src/core/errors.ts";
import { HttpClient, type FetchLike } from "../../../ios/src/core/httpClient.ts";

export type Fetch = FetchLike;

type Persona = { id: string; displayName: string };

const NAME_BYTES = 128;
/** A join is interactive: give up sooner than the client's default, and roster pages are small. */
const LIMITS = { timeoutMs: 15_000, maxBytes: 512 * 1024 };

export function validName(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return "Choose a display name.";
  if (new TextEncoder().encode(trimmed).length > NAME_BYTES) return "Display names are at most 128 bytes.";
  return null;
}

/** Random bytes from the platform: expo-crypto in the app (React Native has no `crypto` global). */
export type RandomBytes = (count: number) => Uint8Array;

export function randomHex(count: number, randomBytes: RandomBytes): string {
  const bytes = randomBytes(count);
  if (bytes.length !== count) throw new Error("Could not generate random bytes.");
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function newPersonaId(randomBytes: RandomBytes): string {
  return `persona-${randomHex(16, randomBytes)}`;
}

/** Join and explicit registration use the same PUT. Repeating the same ID and name is safe. */
export async function putPersona(
  http: HttpClient, board: string, id: string, name: string, signal?: AbortSignal,
): Promise<Persona> {
  const displayName = name.trim();
  const problem = validName(displayName);
  if (problem) throw new Error(problem);
  if (displayName === "github") throw new Error("The name github is reserved for GitHub messages.");
  const slug = /^[a-z0-9][a-z0-9_-]{0,63}$/;
  if (!slug.test(board) || !slug.test(id)) throw new Error("Invalid board or agent ID.");
  const result = await http.request<Persona & { channel: string }>(
    `/channels/${board}/personas/${id}`,
    { method: "PUT", body: { displayName }, signal, ...LIMITS },
  );
  if (result?.channel !== board || result.id !== id || result.displayName !== displayName)
    throw new ProtocolError("The server did not confirm this agent on this board.");
  return { id, displayName };
}

function explain(error: unknown): never {
  if (error instanceof ApiError && error.status === 401) {
    throw new Error("This board link no longer works. Ask the owner for a new one.");
  }
  throw error;
}

export async function ensurePersona(
  input: { origin: string; tenant: string; board: string; token: string; name: string },
  fetchImpl: Fetch | undefined,
  randomBytes: RandomBytes,
): Promise<Persona> {
  const http = new HttpClient(input.origin, input.tenant, input.token, fetchImpl);
  const path = `/channels/${encodeURIComponent(input.board)}/personas`;
  const name = input.name.trim();
  const roster = await http.request<{ personas?: unknown }>(path, LIMITS).catch(explain);
  const personas = Array.isArray(roster?.personas) ? (roster.personas as Persona[]) : [];
  const existing = personas.find((p) => p && typeof p.id === "string" && p.displayName === name);
  if (existing) return { id: existing.id, displayName: existing.displayName };
  return putPersona(http, input.board, newPersonaId(randomBytes), name).catch(explain);
}
