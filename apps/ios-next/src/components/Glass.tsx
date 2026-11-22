import { GlassView, isGlassEffectAPIAvailable, type GlassViewProps } from "expo-glass-effect";
import { useEffect, useState } from "react";
import { AccessibilityInfo, Pressable, type StyleProp, StyleSheet, Text, View, type ViewStyle } from "react-native";
import { color } from "../lib/theme.ts";

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

export function Glass({ style, fallback, ...props }: GlassViewProps & { fallback?: StyleProp<ViewStyle> }) {
  const reduce = useReduceTransparency();
  if (!available || reduce) return <View {...props} style={[{ backgroundColor: color.cell }, style, fallback]} />;
  return <GlassView {...props} style={style} />;
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
  return (
    <Pressable onPress={onPress} disabled={disabled || busy} accessibilityRole="button" accessibilityState={{ disabled, busy }}>
      <Glass isInteractive tintColor={disabled ? undefined : tint} style={[styles.button, style]}>
        <Text style={[styles.buttonText, textColor ? { color: textColor } : null, disabled && styles.disabled]}>{busy ? "…" : label}</Text>
      </Glass>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: { minHeight: 50, borderRadius: 25, paddingHorizontal: 22, alignItems: "center", justifyContent: "center" },
  buttonText: { fontSize: 17, fontWeight: "600", color: "#fff" },
  disabled: { opacity: 0.55 },
});
