import { type ColorValue, View } from "react-native";
import { TICK_OFFSET_PX } from "../core/ticks.ts";

/**
 * WhatsApp-style checks beside the timestamp (ADR 0083). One thin stroke, or two
 * with the second a few pixels to the right so they nearly overlap. `size` matches
 * the timestamp's font size; the stroke is about the cap height of that text.
 */
export function DeliveryTicks({
  marks,
  color,
  size,
  label,
}: {
  marks: number;
  color: ColorValue;
  size: number;
  label: string;
}) {
  if (marks < 1) return null;
  const count = marks >= 2 ? 2 : 1;
  const stroke = 1.35;
  const markW = size * 0.38;
  const markH = size * 0.7;
  const width = markW + (count === 2 ? TICK_OFFSET_PX : 0) + size * 0.35;
  return (
    <View
      accessible
      accessibilityLabel={label}
      style={{ width, height: size, marginLeft: 3, alignSelf: "center" }}
    >
      {Array.from({ length: count }, (_, index) => (
        <View
          key={index}
          style={{
            position: "absolute",
            left: index * TICK_OFFSET_PX,
            bottom: 0,
            width: markW,
            height: markH,
            borderRightWidth: stroke,
            borderBottomWidth: stroke,
            borderColor: color,
            transform: [{ rotate: "45deg" }],
          }}
        />
      ))}
    </View>
  );
}
