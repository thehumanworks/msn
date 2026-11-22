import { LinearGradient } from "expo-linear-gradient";
import { StyleSheet, useColorScheme } from "react-native";

/**
 * The app's sky: a soft blue day sky fading to cream and pale green in light mode, a deep navy
 * night sky with a hint of teal in dark mode. Glass surfaces sit on top of it.
 */
export function Backdrop() {
  const dark = useColorScheme() === "dark";
  return (
    <LinearGradient
      colors={dark ? ["#050d24", "#0b1a3a", "#10284a", "#123a4a"] : ["#8cc4ee", "#cfe5f6", "#f8f2e2", "#dcebd0"]}
      locations={[0, 0.4, 0.75, 1]}
      style={StyleSheet.absoluteFill}
    />
  );
}
