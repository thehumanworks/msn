// Send a message later (ADR 0060): types, decoding and time choices for the iOS app. The Worker
// stores the message and posts it at sendAt even while the app is closed.
import { ProtocolError } from "./errors.ts";

export type ScheduledMessage = {
  id: number;
  channel: string;
  username: string;
  text: string;
  sendAt: string;
  to?: string;
  replyTo?: number;
  status: "pending" | "failed";
  error?: { code: string; message: string };
  /** True when the message repeats (ADR 0072): sendAt is then its next copy. */
  repeats?: boolean;
};

/** GET …/scheduled: every row must be this board's, with an id, text and a time. */
export function decodeScheduledList(raw: unknown, channel: string): ScheduledMessage[] {
  const bad = (): never => {
    throw new ProtocolError("The server sent an invalid scheduled list.");
  };
  if (typeof raw !== "object" || raw === null) bad();
  const rows = (raw as { scheduled?: unknown }).scheduled;
  if (!Array.isArray(rows)) bad();
  return (rows as unknown[]).map((row) => {
    if (typeof row !== "object" || row === null) bad();
    const r = row as Record<string, unknown>;
    if (
      typeof r.id !== "number" ||
      !Number.isSafeInteger(r.id) ||
      r.channel !== channel ||
      typeof r.username !== "string" ||
      typeof r.text !== "string" ||
      typeof r.sendAt !== "string" ||
      (r.status !== "pending" && r.status !== "failed")
    )
      bad();
    const item: ScheduledMessage = {
      id: r.id as number,
      channel,
      username: r.username as string,
      text: r.text as string,
      sendAt: r.sendAt as string,
      status: r.status as "pending" | "failed",
    };
    if (typeof r.to === "string") item.to = r.to;
    if (typeof r.replyTo === "number") item.replyTo = r.replyTo;
    if (typeof r.repeat === "object" && r.repeat !== null) item.repeats = true;
    const error = r.error as Record<string, unknown> | undefined;
    if (error && typeof error.code === "string")
      item.error = { code: error.code, message: typeof error.message === "string" ? error.message : "" };
    return item;
  });
}

const UNITS: Record<string, number> = { s: 1000, m: 60000, h: 3600000, d: 86400000 };

/**
 * The sendAt for what the person typed: a delay such as 10m, 2h, 1d or 1h30m, or a time with a
 * zone. Returns null when it is neither, in the past, or more than 366 days ahead.
 */
export function sendAtFrom(input: string, now = Date.now()): string | null {
  const value = input.trim().replace(/^\+/, "");
  let at: number;
  if (/^(\d{1,9}[smhd])+$/.test(value)) {
    let total = 0;
    for (const [, n, unit] of value.matchAll(/(\d+)([smhd])/g)) total += Number(n) * UNITS[unit];
    at = now + total;
  } else if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/i.test(value)) {
    at = Date.parse(value);
  } else return null;
  if (!Number.isFinite(at) || at <= now || at - now > 366 * 86400000) return null;
  return new Date(at).toISOString();
}

/** Quick choices in this device's zone: in an hour, and tomorrow at 9:00. */
export function presets(now = new Date()): { label: string; sendAt: string }[] {
  const hour = new Date(now.getTime() + 3600000);
  hour.setSeconds(0, 0);
  const morning = new Date(now);
  morning.setDate(morning.getDate() + 1);
  morning.setHours(9, 0, 0, 0);
  return [
    { label: "In 1 hour", sendAt: hour.toISOString() },
    { label: "Tomorrow 9:00", sendAt: morning.toISOString() },
  ];
}

/** "today 18:00", "tomorrow 09:00" or a short date, in this device's zone. */
export function whenText(iso: string, now = new Date()): string {
  const at = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  const time = `${pad(at.getHours())}:${pad(at.getMinutes())}`;
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  if (at.toDateString() === now.toDateString()) return `today ${time}`;
  if (at.toDateString() === tomorrow.toDateString()) return `tomorrow ${time}`;
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${time}`;
}
