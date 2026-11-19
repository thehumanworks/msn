// Owner notifications through Web Push (ADR 0029). A browser holds one push subscription, so it
// notifies for one workspace at a time; the workspace that owns it is remembered locally.
const OWNER_KEY = "msn.push.tenant";

function remembered() {
  try {
    return localStorage.getItem(OWNER_KEY);
  } catch {
    return null;
  }
}
function remember(tenant) {
  try {
    if (tenant) localStorage.setItem(OWNER_KEY, tenant);
    else localStorage.removeItem(OWNER_KEY);
  } catch {}
}

export function pushSupported() {
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

/** iPhone and iPad only offer Web Push to a web app opened from the Home Screen. */
export function needsHomeScreen() {
  return !pushSupported() && navigator.standalone === false;
}

async function registration() {
  return navigator.serviceWorker.register("/sw.js", { scope: "/" });
}

function keyBytes(value) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4);
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}

/** Is this browser subscribed for `tenant`? */
export async function pushEnabled(tenant) {
  if (!pushSupported() || remembered() !== tenant) return false;
  const current = await (await registration()).pushManager.getSubscription();
  return Boolean(current);
}

/** Must run inside a click: browsers only ask for permission from a user gesture. */
export async function enablePush(tenant, api) {
  if (!pushSupported()) throw new Error("This browser cannot show notifications.");
  const permission = await Notification.requestPermission();
  if (permission !== "granted")
    throw new Error("Notifications are blocked for this site in the browser settings.");
  const { publicKey } = await api("/push");
  const reg = await registration();
  let subscription = await reg.pushManager.getSubscription();
  // A subscription made for another workspace's key cannot be reused.
  if (subscription && remembered() !== tenant) {
    await subscription.unsubscribe();
    subscription = null;
  }
  subscription ??= await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: keyBytes(publicKey),
  });
  await api("/push/subscriptions", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(subscription.toJSON()),
  });
  remember(tenant);
}

/** Best effort: tell the server first, then always drop the browser subscription. */
export async function disablePush(tenant, api) {
  if (!pushSupported() || remembered() !== tenant) return;
  const subscription = await (await registration()).pushManager.getSubscription();
  try {
    if (subscription && api)
      await api("/push/subscriptions", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ endpoint: subscription.endpoint }),
      });
  } finally {
    await subscription?.unsubscribe();
    remember(null);
  }
}
