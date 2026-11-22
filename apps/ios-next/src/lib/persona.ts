/**
 * A board's shared key (a `#board=…&key=…` link) posts only as a registered persona: the server
 * answers `persona_required` otherwise. Before the first sign-in with such a key this registers
 * the chosen name, or reuses the persona that already has it, exactly as the web app does
 * (public/app.js, connect). Registering is idempotent by name, so repeating a join is safe.
 */
export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

type Persona = { id: string; displayName: string };

const NAME_BYTES = 128;

export function validName(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return "Choose a display name.";
  if (new TextEncoder().encode(trimmed).length > NAME_BYTES) return "Display names are at most 128 bytes.";
  return null;
}

async function json(response: Response): Promise<unknown> {
  if (response.status >= 300 && response.status < 400) throw new Error("The server tried to redirect; nothing was sent.");
  if (response.type === "opaqueredirect") throw new Error("The server tried to redirect; nothing was sent.");
  const data = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
  if (response.status === 401) throw new Error("This board link no longer works. Ask the owner for a new one.");
  if (!response.ok) throw new Error(data?.error?.message ?? `The server answered ${response.status}.`);
  return data;
}

/** Random bytes from the platform: expo-crypto in the app (React Native has no `crypto` global). */
export type RandomBytes = (count: number) => Uint8Array;

function newId(randomBytes: RandomBytes): string {
  const bytes = randomBytes(16);
  return `persona-${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

export async function ensurePersona(
  input: { origin: string; tenant: string; board: string; token: string; name: string },
  fetchImpl: Fetch,
  randomBytes: RandomBytes,
): Promise<Persona> {
  const base = `${input.origin}/api/tenants/${encodeURIComponent(input.tenant)}/channels/${encodeURIComponent(input.board)}/personas`;
  const headers = { Authorization: `Bearer ${input.token}`, Accept: "application/json" };
  const name = input.name.trim();
  const roster = (await json(await fetchImpl(base, { headers, redirect: "manual" }))) as { personas?: unknown };
  const personas = Array.isArray(roster?.personas) ? (roster.personas as Persona[]) : [];
  const existing = personas.find((p) => p && p.displayName === name);
  if (existing) return existing;
  const created = (await json(
    await fetchImpl(`${base}/${newId(randomBytes)}`, {
      method: "PUT",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ displayName: name }),
      redirect: "manual",
    }),
  )) as Persona;
  if (!created || typeof created.id !== "string") throw new Error("The server did not register the name.");
  return created;
}
