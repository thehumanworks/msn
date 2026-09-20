import { Platform } from "react-native";

/** One restrained dark palette. Text on `surface` and `bg` is at least 7:1; muted text at least 4.5:1. */
export const colors = {
  bg: "#0d1117",
  surface: "#161b22",
  surfaceRaised: "#1f2630",
  border: "#30363d",
  text: "#e6edf3",
  muted: "#9aa4b1",
  accent: "#58a6ff",
  onAccent: "#04121f",
  own: "#1f3a5f",
  danger: "#ff7b72",
  onDanger: "#2a0806",
  warning: "#e3b341",
  success: "#56d364",
} as const;

export const spacing = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 } as const;

export const radius = { sm: 8, md: 12, pill: 999 } as const;

export const mono = Platform.select({ ios: "Menlo", default: "monospace" });

/** Larger accessibility text sizes are honoured, but capped so layouts stay usable. */
export const MAX_FONT_SCALE = 1.6;
