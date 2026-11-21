// Wake an agent with a webhook (ADR 0062): plain-language text for a persona's webhook in the
// web Agents panel. Pure, so tests/webhook-web.test.mjs covers it without a browser.

/** "3 min ago" style text for a past ISO time; coarse on purpose. */
function since(iso, now) {
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (seconds < 60) return "just now";
  for (const [size, unit] of [
    [86400, "d"],
    [3600, "h"],
    [60, "min"],
  ])
    if (seconds >= size) return `${Math.floor(seconds / size)} ${unit} ago`;
  return "just now";
}

/** The host a webhook points at, or the raw text when it is not a URL. */
export function webhookHost(url) {
  try {
    return new URL(url).host;
  } catch {
    return String(url);
  }
}

const ERRORS = {
  timeout: "no answer within 5 seconds",
  network_error: "could not connect",
  redirect_refused: "it answered with a redirect, which is not followed",
  backlog_full: "50 notices were already waiting, so a new one was dropped",
};

/** Why the last attempt failed, in words. */
export function failureText(delivery) {
  if (!delivery?.error) return "";
  if (ERRORS[delivery.error]) return ERRORS[delivery.error];
  const status = /^http_(\d{3})$/.exec(delivery.error)?.[1];
  return status ? `it answered HTTP ${status}` : delivery.error;
}

/**
 * One line for a persona row: where it wakes and how the last notice went, or null when the
 * persona has no webhook.
 */
export function webhookSummary(hook, now = Date.now()) {
  if (!hook) return null;
  const host = webhookHost(hook.url);
  const last = hook.lastDelivery;
  if (!last) return `Wakes ${host} · nothing sent yet`;
  const when = last.at ? since(last.at, now) : "";
  switch (last.status) {
    case "delivered":
      return `Wakes ${host} · delivered ${when}`;
    case "retrying":
      return `Wakes ${host} · retrying: ${failureText(last)}`;
    case "dropped":
      return `Wakes ${host} · ${failureText(last)}`;
    default:
      return `Wakes ${host} · failed ${when}: ${failureText(last)}`;
  }
}
