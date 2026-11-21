/** "14:05" for today, "12 Mar 14:05" otherwise. Falls back to the raw string for bad input. */
export function formatTime(iso: string, now: Date = new Date()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const time = date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  if (date.toDateString() === now.toDateString()) return time;
  return `${date.toLocaleDateString(undefined, { day: "numeric", month: "short" })} ${time}`;
}

/** "just now", "3 min ago", "2 h ago" or "4 d ago", as the web app words it (ADR 0064). */
export function formatAgo(iso: string, now: number = Date.now()): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return iso;
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds >= 86400) return `${Math.floor(seconds / 86400)} d ago`;
  if (seconds >= 3600) return `${Math.floor(seconds / 3600)} h ago`;
  if (seconds >= 60) return `${Math.floor(seconds / 60)} min ago`;
  return "just now";
}

export function formatCount(n: number, singular: string, plural = `${singular}s`): string {
  return `${n} ${n === 1 ? singular : plural}`;
}

export function formatBytes(n: number): string {
  return n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KiB`;
}
