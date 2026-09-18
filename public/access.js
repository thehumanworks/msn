// Invitations carry only a short-lived capability, never the sender's workspace key.
export function invitation(value) {
  let code = value.trim();
  if (code.includes("://")) {
    const link = new URL(code);
    if (link.origin !== location.origin || link.pathname !== "/" || link.search)
      throw new Error("Open the invitation on its original server to join.");
    code = new URLSearchParams(link.hash.slice(1)).get("invite") ?? "";
  }
  const match = /^([a-z0-9][a-z0-9_-]{0,63})\.([a-f0-9]{64})$/.exec(code);
  if (!match) throw new Error("Paste a complete invitation link or code.");
  return { tenant: match[1], code };
}

export async function acquire(tenant, method, suffix, input) {
  const response = await fetch(`/api/tenants/${encodeURIComponent(tenant)}${suffix}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message ?? "Could not open workspace.");
  return data;
}

export async function savePassword(connection) {
  if (!window.PasswordCredential || !navigator.credentials?.store) return false;
  try {
    await navigator.credentials.store(
      new PasswordCredential({
        id: `${connection.tenant}/${connection.username}`,
        name: connection.username,
        password: connection.token,
      }),
    );
    return true;
  } catch {
    // Password-manager support and user preference must never prevent access.
    return false;
  }
}
