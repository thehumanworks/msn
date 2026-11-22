import { BlurView } from "expo-blur";
import { GlassView, isGlassEffectAPIAvailable, type GlassViewProps } from "expo-glass-effect";
import { useEffect, useState } from "react";
import { AccessibilityInfo, Pressable, type StyleProp, StyleSheet, Text, View, type ViewStyle } from "react-native";
import { color, glassTint } from "../lib/theme.ts";

// Some iOS 26 betas lack the API and crash (expo/expo#40911), so check once before using it.
const available = isGlassEffectAPIAvailable();

/** Reduce Transparency asks for solid surfaces; glass falls back to a plain filled view. */
function useReduceTransparency(): boolean {
  const [reduce, setReduce] = useState(false);
  useEffect(() => {
    void AccessibilityInfo.isReduceTransparencyEnabled().then(setReduce);
    const sub = AccessibilityInfo.addEventListener("reduceTransparencyChanged", setReduce);
    return () => sub.remove();
  }, []);
  return reduce;
}

/** The milky glass tints are see-through; without glass they become the opaque cell color. */
const translucent = new Set<unknown>(Object.values(glassTint));

/**
 * Without glass (no API, or Reduce Transparency on) a solid tint such as the accent of a button,
 * badge or send button stays as the background, so its white label keeps its contrast.
 */
export function Glass({ style, fallback, ...props }: GlassViewProps & { fallback?: StyleProp<ViewStyle> }) {
  const reduce = useReduceTransparency();
  if (!available || reduce) {
    const tint = props.tintColor;
    const backgroundColor = tint && !translucent.has(tint) ? tint : color.cell;
    return <View {...props} style={[{ backgroundColor }, style, fallback]} />;
  }
  return <GlassView {...props} style={style} />;
}

/**
 * Glass for anything that carries text: a material blur under a tinted glass layer, so the
 * backdrop is softened before the glass refracts it and labels keep their contrast.
 * `strength` picks the tint: "surface" for cards, "chip" for small pills over content.
 */
export function Surface({
  style,
  strength = "surface",
  children,
  ...props
}: GlassViewProps & { strength?: keyof typeof glassTint }) {
  const reduce = useReduceTransparency();
  if (!available || reduce)
    return (
      <View {...props} style={[{ backgroundColor: color.cell }, style]}>
        {children}
      </View>
    );
  const radius = StyleSheet.flatten(style)?.borderRadius;
  return (
    <View style={[style, styles.surface]}>
      <BlurView
        intensity={strength === "chip" ? 50 : 70}
        tint="systemMaterial"
        style={[StyleSheet.absoluteFill, { borderRadius: radius, overflow: "hidden" }]}
      />
      <GlassView
        {...props}
        tintColor={glassTint[strength]}
        style={[StyleSheet.absoluteFill, { borderRadius: radius }]}
      />
      {children}
    </View>
  );
}

export function GlassButton({
  label,
  onPress,
  disabled,
  tint,
  busy,
  style,
  textColor,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  tint?: GlassViewProps["tintColor"];
  busy?: boolean;
  style?: StyleProp<ViewStyle>;
  textColor?: string;
}) {
  // A disabled or untinted button sits on the milky surface tint, so its label takes the system label color.
  const solid = tint && !disabled;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || busy}
      accessibilityRole="button"
      accessibilityState={{ disabled, busy }}
    >
      <Glass isInteractive tintColor={solid ? tint : glassTint.surface} style={[styles.button, style]}>
        <Text
          style={[
            styles.buttonText,
            { color: textColor ?? (solid ? color.onTint : color.label) },
            disabled && { color: color.secondary },
          ]}
        >
          {busy ? "…" : label}
        </Text>
      </Glass>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  surface: { overflow: "visible" },
  button: { minHeight: 50, borderRadius: 25, paddingHorizontal: 22, alignItems: "center", justifyContent: "center" },
  buttonText: { fontSize: 17, fontWeight: "600" },
});
