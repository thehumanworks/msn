import { Image, StyleSheet, useColorScheme, useWindowDimensions, View } from "react-native";

const sky = {
  light: require("../../assets/backdrop/sky-light.jpg"),
  dark: require("../../assets/backdrop/sky-dark.jpg"),
};

/**
 * The app's sky, behind every screen: a soft blue day sky with halftone clouds fading to cream
 * and pale green in light mode, a deep navy night sky with blue-grey clouds in dark mode. The
 * view behind the image carries the sky's average colour, so nothing flashes while it loads or
 * where `cover` leaves an edge. Glass surfaces sit on top of it.
 */
export function Backdrop() {
  const dark = useColorScheme() === "dark";
  const { width, height } = useWindowDimensions();
  return (
    <View style={[StyleSheet.absoluteFill, { backgroundColor: dark ? "#07102a" : "#bcdcf4" }]} pointerEvents="none">
      <Image
        source={dark ? sky.dark : sky.light}
        resizeMode="cover"
        fadeDuration={0}
        style={{ width, height }}
        accessibilityIgnoresInvertColors
      />
    </View>
  );
}
