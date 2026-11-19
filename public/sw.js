// Service worker for owner notifications (ADR 0029). It only shows notifications and opens boards;
// it never caches pages or API responses. Payload text is untrusted and only ever plain text.
const NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;

function clip(value, limit) {
  return typeof value === "string" ? value.slice(0, limit) : "";
}

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let data = null;
  try {
    data = event.data?.json() ?? null;
  } catch {}
  if (data?.schema !== "msn.push.v1" || !NAME.test(data.tenant) || !NAME.test(data.channel)) {
    // Browsers require a visible notification for every push; keep it generic.
    event.waitUntil(self.registration.showNotification("msn", { body: "An agent needs you." }));
    return;
  }
  event.waitUntil(
    self.registration.showNotification(clip(data.title, 80) || `#${data.channel}`, {
      body: clip(data.body, 200),
      tag: `${data.tenant}/${data.channel}`,
      renotify: true,
      icon: "/icon-192.png",
      data: { tenant: data.tenant, channel: data.channel },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = event.notification.data ?? {};
  const channel = NAME.test(target.channel ?? "") ? target.channel : "";
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const open = windows.find((client) => new URL(client.url).origin === self.location.origin);
      if (open) {
        await open.focus();
        if (channel) open.postMessage({ type: "msn.open", tenant: target.tenant, channel });
        return;
      }
      const tenant = NAME.test(target.tenant ?? "") ? target.tenant : "";
      await self.clients.openWindow(
        channel && tenant
          ? `/?tenant=${encodeURIComponent(tenant)}&channel=${encodeURIComponent(channel)}`
          : "/",
      );
    })(),
  );
});
