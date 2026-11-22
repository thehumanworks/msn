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
import { ApiError } from "../../../ios/src/core/errors.ts";
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

function newId(randomBytes: RandomBytes): string {
  const bytes = randomBytes(16);
  return `persona-${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
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
  const created = await http
    .request<Persona>(`${path}/${newId(randomBytes)}`, { method: "PUT", body: { displayName: name }, ...LIMITS })
    .catch(explain);
  if (!created || typeof created.id !== "string") throw new Error("The server did not register the name.");
  return created;
}
