import { type ColorValue, View } from "react-native";
import { TICK_OFFSET_PX, tickFrame } from "../core/ticks.ts";

/**
 * WhatsApp-style checks beside the timestamp (ADR 0083). One thin stroke, or two
 * with the second a few pixels to the right so they nearly overlap. `size` matches
 * the timestamp's font size; the stroke is about the cap height of that text.
 * The box is the rotated stroke plus the real offset, so the second check is not clipped.
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
  const frame = tickFrame(size, marks);
  return (
    <View
      accessible
      accessibilityLabel={label}
      style={{ width: frame.width, height: frame.height, marginLeft: 3, alignSelf: "center" }}
    >
      {Array.from({ length: frame.count }, (_, index) => (
        <View
          key={index}
          style={{
            position: "absolute",
            left: frame.overhang + index * TICK_OFFSET_PX,
            bottom: frame.bottom,
            width: frame.markW,
            height: frame.markH,
            borderRightWidth: 1.35,
            borderBottomWidth: 1.35,
            borderColor: color,
            transform: [{ rotate: "45deg" }],
          }}
        />
      ))}
    </View>
  );
}
