import { PlatformColor } from "react-native";

// System colors follow light and dark mode and the user's contrast settings on their own.
export const color = {
  label: PlatformColor("label"),
  secondary: PlatformColor("secondaryLabel"),
  tertiary: PlatformColor("tertiaryLabel"),
  background: PlatformColor("systemBackground"),
  grouped: PlatformColor("systemGroupedBackground"),
  cell: PlatformColor("secondarySystemGroupedBackground"),
  fill: PlatformColor("tertiarySystemFill"),
  separator: PlatformColor("separator"),
  tint: PlatformColor("systemBlue"),
  danger: PlatformColor("systemRed"),
  warning: PlatformColor("systemOrange"),
  success: PlatformColor("systemGreen"),
  mine: PlatformColor("systemBlue"),
  onTint: "#ffffff",
};

/** A stable hue for a sender's name, so the same agent reads the same color everywhere. */
const HUES = ["systemPurple", "systemTeal", "systemOrange", "systemPink", "systemIndigo", "systemGreen", "systemBrown", "systemCyan"];
export function nameColor(name: string) {
  let hash = 0;
  for (let i = 0; i < name.length; i += 1) hash = (hash * 31 + name.charCodeAt(i)) | 0;
  return PlatformColor(HUES[Math.abs(hash) % HUES.length] as string);
}

export function host(origin: string): string {
  return origin.replace(/^https?:\/\//, "");
}

/** "now", "5m", "3h", "Mon", "12 Nov": short enough for a list row. */
export function shortTime(iso: string | null, now = Date.now()): string {
  if (!iso) return "";
  const at = new Date(iso);
  const seconds = Math.max(0, (now - at.getTime()) / 1000);
  if (seconds < 60) return "now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  if (seconds < 7 * 86400) return at.toLocaleDateString(undefined, { weekday: "short" });
  return at.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

export function clockTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}
