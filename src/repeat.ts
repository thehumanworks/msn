// Repeat a scheduled message (ADR 0072): the rule a send carries, and the pure time arithmetic the
// Durable Object alarm uses to find the next copy. "Daily" and "weekdays" keep a wall-clock time in
// one IANA time zone, so 09:00 stays 09:00 across a daylight-saving change.

import { HttpError, MAX_SCHEDULE_AHEAD_MS, sendAtValue, sendAtWindow } from "./http";

/** The shortest and longest "every N hours". */
export const MIN_REPEAT_HOURS = 1;
export const MAX_REPEAT_HOURS = 168;

const HOUR_MS = 3600_000;

/** What a send asks for, checked for form only. Part of the idempotency digest. */
export type RepeatRequest = {
  every: "daily" | "weekdays" | "hours";
  hours?: number;
  /** Wall-clock `HH:MM` or `HH:MM:SS` in `timeZone`, for daily and weekdays. */
  at?: string;
  timeZone: string;
  /** A zoned RFC 3339 time (kept as UTC), or a `YYYY-MM-DD` date in `timeZone` (through that day). */
  until?: string;
};

/** The stored rule: `at` is always set for daily and weekdays, `until` is always a UTC time. */
export type Repeat = {
  every: "daily" | "weekdays" | "hours";
  hours?: number;
  at?: string;
  timeZone: string;
  until: string;
};

const invalid = (message: string) => new HttpError(400, "invalid_repeat", message);

const formats = new Map<string, Intl.DateTimeFormat>();
function format(timeZone: string): Intl.DateTimeFormat {
  let found = formats.get(timeZone);
  if (!found) {
    found = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    if (formats.size < 64) formats.set(timeZone, found);
  }
  return found;
}

type Local = { year: number; month: number; day: number; hour: number; minute: number; second: number };

/** The wall-clock reading of an instant in a zone. */
export function localParts(ms: number, timeZone: string): Local {
  const parts: Record<string, number> = {};
  for (const part of format(timeZone).formatToParts(new Date(ms)))
    if (part.type !== "literal") parts[part.type] = Number(part.value);
  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: parts.hour % 24,
    minute: parts.minute,
    second: parts.second,
  };
}

const asUtc = (l: Local) => Date.UTC(l.year, l.month - 1, l.day, l.hour, l.minute, l.second);

/**
 * The instant a wall-clock time names in a zone. A time that a spring-forward change skips (02:30
 * on that night) lands the same span after midnight (03:30); a time that a fall-back change
 * repeats takes its first occurrence.
 */
export function zonedTime(local: Local, timeZone: string): number {
  const wanted = asUtc(local);
  const offsetAt = (ms: number) => asUtc(localParts(ms, timeZone)) - ms;
  const first = wanted - offsetAt(wanted);
  const second = wanted - offsetAt(first);
  const exact = [first, second].filter((ms) => asUtc(localParts(ms, timeZone)) === wanted);
  return exact.length ? Math.min(...exact) : Math.max(first, second);
}

function clock(at: string): { hour: number; minute: number; second: number } {
  const [hour, minute, second = 0] = at.split(":").map(Number);
  return { hour, minute, second };
}

/** A civil date `days` after another, as a UTC-midnight number (used only to compare and step). */
const civil = (l: { year: number; month: number; day: number }, days = 0) =>
  Date.UTC(l.year, l.month - 1, l.day + days);

/**
 * The first time after `afterMs` that the wall clock in `timeZone` reads `at`, on a civil date not
 * before `fromDate` (a `civil()` number), Monday to Friday only when `weekdays`.
 */
function nextWallTime(
  afterMs: number,
  at: string,
  timeZone: string,
  weekdays: boolean,
  fromDate = Number.NEGATIVE_INFINITY,
): number {
  const start = Math.max(civil(localParts(afterMs, timeZone)), fromDate);
  // One week always holds a weekday, and one more day covers a time already past today.
  for (let step = 0; step <= 8; step++) {
    const date = new Date(start + step * 86400_000);
    if (weekdays && (date.getUTCDay() === 0 || date.getUTCDay() === 6)) continue;
    const candidate = zonedTime(
      { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate(), ...clock(at) },
      timeZone,
    );
    if (candidate > afterMs) return candidate;
  }
  throw new Error("no next wall time within nine days");
}

function zone(value: unknown): string {
  if (value === undefined || value === null) return "UTC";
  if (typeof value === "string" && /^[A-Za-z][A-Za-z0-9_+\-/]{0,63}$/.test(value)) {
    try {
      format(value);
      return value;
    } catch {
      // Falls through to the error below.
    }
  }
  throw invalid(
    'repeat.timeZone must be an IANA time zone name, like "Europe/Lisbon" or "America/New_York", or "UTC".',
  );
}

/**
 * `repeat` on a send (ADR 0072), checked for form only: the window (first time in the future, end
 * within 366 days) is checked by `repeatStart` after the idempotency lookup, so a late retry still
 * replays. Daily and weekdays take either `at` (the Worker finds the first time) or the send's
 * `sendAt` (the first time, whose wall clock then repeats), never both.
 */
export function repeatRequest(value: unknown, hasSendAt: boolean): RepeatRequest {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw invalid(
      'repeat must be an object like {"every":"daily","at":"09:00","timeZone":"Europe/Lisbon","until":"2026-12-31"}.',
    );
  const input = value as Record<string, unknown>;
  for (const field of Object.keys(input))
    if (!["every", "hours", "at", "timeZone", "until"].includes(field))
      throw invalid(`Unknown repeat field ${field}; use every, hours, at, timeZone and until.`);
  const every = input.every;
  if (every !== "daily" && every !== "weekdays" && every !== "hours")
    throw invalid('repeat.every must be "daily", "weekdays" or "hours".');
  const timeZone = zone(input.timeZone);
  const request: RepeatRequest = { every, timeZone };
  if (every === "hours") {
    const hours = input.hours;
    if (
      typeof hours !== "number" ||
      !Number.isInteger(hours) ||
      hours < MIN_REPEAT_HOURS ||
      hours > MAX_REPEAT_HOURS
    )
      throw invalid(
        `repeat.hours must be a whole number from ${MIN_REPEAT_HOURS} to ${MAX_REPEAT_HOURS} when every is "hours".`,
      );
    if (input.at !== undefined)
      throw invalid('repeat.at is for "daily" and "weekdays". Give sendAt for the first time instead.');
    request.hours = hours;
  } else {
    if (input.hours !== undefined) throw invalid('repeat.hours is only for every "hours".');
    if (input.at === undefined) {
      if (!hasSendAt)
        throw invalid(
          'Give repeat.at, a wall-clock time like "09:00" in repeat.timeZone, or sendAt for the first time.',
        );
    } else {
      if (hasSendAt)
        throw invalid("Give repeat.at or sendAt, not both: each one names the time of the first copy.");
      if (typeof input.at !== "string" || !/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/.test(input.at))
        throw invalid('repeat.at must be a 24-hour time like "09:00" or "17:30".');
      request.at = input.at;
    }
  }
  if (input.until !== undefined && input.until !== null) {
    const until = input.until;
    const date = typeof until === "string" ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(until) : null;
    if (date) {
      const [year, month, day] = [date[1], date[2], date[3]].map(Number);
      if (month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate())
        throw invalid("repeat.until must be a real date like 2026-12-31, or a time with a zone.");
      request.until = until as string;
    } else {
      try {
        request.until = sendAtValue(until);
      } catch {
        throw invalid(
          "repeat.until must be a date like 2026-12-31 (through that day in repeat.timeZone) or a time with a zone like 2026-12-31T18:00:00Z.",
        );
      }
    }
  }
  return request;
}

const hhmmss = (l: Local) => {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(l.hour)}:${pad(l.minute)}${l.second ? `:${pad(l.second)}` : ""}`;
};

/**
 * Turns a checked request into the stored rule and the first time, as of `now`. The first time is
 * `sendAt` when given; else the next `at` in the zone (a weekday for weekdays), or one interval
 * from now for hours. The end defaults to 366 days from now and is never later than that.
 */
export function repeatStart(
  request: RepeatRequest,
  sendAt: string | null,
  now = Date.now(),
): { repeat: Repeat; sendAt: string } {
  const { timeZone } = request;
  let first: number;
  let at = request.at;
  if (sendAt !== null) {
    first = Date.parse(sendAtWindow(sendAt, now));
    if (request.every !== "hours") {
      const local = localParts(first, timeZone);
      at = hhmmss(local);
      const day = new Date(civil(local)).getUTCDay();
      if (request.every === "weekdays" && (day === 0 || day === 6))
        throw invalid(
          `sendAt falls on a weekend in ${timeZone}. Give a weekday for the first copy, or repeat.at instead.`,
        );
    }
  } else if (request.every === "hours") {
    first = Math.floor(now / 1000) * 1000 + (request.hours as number) * HOUR_MS;
  } else {
    first = nextWallTime(now, at as string, timeZone, request.every === "weekdays");
  }
  let until = now + MAX_SCHEDULE_AHEAD_MS;
  if (request.until !== undefined) {
    const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(request.until);
    until = date
      ? // Through the end of that day: one millisecond before the next day starts in the zone.
        zonedTime(
          {
            year: Number(date[1]),
            month: Number(date[2]),
            day: Number(date[3]) + 1,
            hour: 0,
            minute: 0,
            second: 0,
          },
          timeZone,
        ) - 1
      : Date.parse(request.until);
    if (until < first)
      throw invalid(
        `repeat.until is before the first copy (${new Date(first).toISOString()}). Give a later end, or send it once with sendAt.`,
      );
    if (until - now > MAX_SCHEDULE_AHEAD_MS)
      throw invalid("repeat.until must be at most 366 days ahead. Schedule it again when it ends.");
  }
  return {
    repeat: {
      every: request.every,
      ...(request.hours === undefined ? {} : { hours: request.hours }),
      ...(at === undefined ? {} : { at }),
      timeZone,
      until: new Date(until).toISOString(),
    },
    sendAt: new Date(first).toISOString(),
  };
}

/**
 * The time of the copy after the one due at `dueMs`, or null when the repeat has ended. It is
 * always after `now`: copies missed while the alarm was late are skipped, never sent in a burst.
 * Daily and weekdays never give a second copy on the civil date of `dueMs`, so a copy moved earlier
 * in its day does not post again at the usual time.
 */
export function nextRepeat(repeat: Repeat, dueMs: number, now = Date.now()): number | null {
  let next: number;
  if (repeat.every === "hours") {
    const step = (repeat.hours as number) * HOUR_MS;
    next = dueMs + (Math.floor(Math.max(0, now - dueMs) / step) + 1) * step;
  } else {
    next = nextWallTime(
      Math.max(now, dueMs),
      repeat.at as string,
      repeat.timeZone,
      repeat.every === "weekdays",
      civil(localParts(dueMs, repeat.timeZone), 1),
    );
  }
  return next <= Date.parse(repeat.until) ? next : null;
}
