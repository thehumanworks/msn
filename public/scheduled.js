// Send a message later (ADR 0060): the web app's pure helpers. The Worker stores and posts the
// message; these turn the person's local choice into the zoned time it takes, and back.

/** How often an open board re-reads its scheduled list; posting one also refreshes it. */
export const SCHEDULED_REFRESH_MS = 30000;

const pad = (n) => String(n).padStart(2, "0");

/** A Date as the value of an `<input type="datetime-local">`, in this device's zone. */
export function localInput(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * The `sendAt` for a datetime-local value read in this device's zone, as UTC. Returns null when
 * the value is empty, not a time, in the past, or more than 366 days ahead.
 */
export function sendAtFrom(value, now = Date.now()) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(value ?? "")) return null;
  const at = new Date(value).getTime();
  if (!Number.isFinite(at) || at <= now || at - now > 366 * 86400000) return null;
  return new Date(at).toISOString();
}

/**
 * Quick choices: in an hour (to the minute), this evening at 18:00 when that is still over 30
 * minutes away, and the next morning at 9:00. Each is a Date in this device's zone.
 */
export function presets(now = new Date()) {
  const hour = new Date(now.getTime() + 3600000);
  hour.setSeconds(0, 0);
  const choices = [{ label: "In 1 hour", at: hour }];
  const evening = new Date(now);
  evening.setHours(18, 0, 0, 0);
  if (evening.getTime() - now.getTime() > 30 * 60000)
    choices.push({ label: "This evening, 18:00", at: evening });
  const morning = new Date(now);
  morning.setDate(morning.getDate() + 1);
  morning.setHours(9, 0, 0, 0);
  choices.push({ label: "Tomorrow, 9:00", at: morning });
  return choices;
}

/** "today 18:00", "tomorrow 09:00", or "Mon 24 Nov 09:00", in this device's zone. */
export function whenText(iso, now = new Date()) {
  const at = new Date(iso);
  const time = `${pad(at.getHours())}:${pad(at.getMinutes())}`;
  const day = (offset) => {
    const d = new Date(now);
    d.setDate(d.getDate() + offset);
    return d.toDateString();
  };
  if (at.toDateString() === day(0)) return `today ${time}`;
  if (at.toDateString() === day(1)) return `tomorrow ${time}`;
  const date = at.toLocaleDateString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    ...(at.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  });
  return `${date} ${time}`;
}

/** The bar above the composer: how many are waiting and how many failed, or "" for none. */
export function summary(list) {
  if (!list?.length) return "";
  const failed = list.filter((item) => item.status === "failed").length;
  const waiting = list.length - failed;
  const parts = [];
  if (waiting) parts.push(`${waiting} scheduled`);
  if (failed) parts.push(`${failed} failed to post`);
  return parts.join(" · ");
}
