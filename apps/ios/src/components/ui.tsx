import type { ReactNode } from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text as RNText,
  TextInput,
  View,
  type StyleProp,
  type TextInputProps,
  type TextProps,
  type TextStyle,
  type ViewStyle,
} from "react-native";
import { colors, MAX_FONT_SCALE, radius, spacing } from "./theme.ts";

export function Text({ style, ...rest }: TextProps) {
  return <RNText maxFontSizeMultiplier={MAX_FONT_SCALE} style={[styles.text, style]} {...rest} />;
}

type ButtonProps = {
  label: string;
  onPress: () => void;
  variant?: "primary" | "secondary" | "danger" | "ghost";
  disabled?: boolean;
  busy?: boolean;
  accessibilityHint?: string;
  style?: StyleProp<ViewStyle>;
};

export function Button({ label, onPress, variant = "secondary", disabled, busy, accessibilityHint, style }: ButtonProps) {
  const inactive = disabled || busy;
  const textColor: TextStyle["color"] =
    variant === "primary" ? colors.onAccent : variant === "danger" ? colors.danger : colors.text;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: !!inactive, busy: !!busy }}
      disabled={inactive}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        variant === "primary" && { backgroundColor: colors.accent, borderColor: colors.accent },
        variant === "danger" && { borderColor: colors.danger },
        variant === "ghost" && { borderColor: "transparent", backgroundColor: "transparent" },
        pressed && { opacity: 0.7 },
        inactive && { opacity: 0.45 },
        style,
      ]}
    >
      {busy ? <ActivityIndicator color={textColor} /> : <Text style={[styles.buttonLabel, { color: textColor }]}>{label}</Text>}
    </Pressable>
  );
}

type FieldProps = TextInputProps & { label: string; hint?: string };

export function Field({ label, hint, style, ...rest }: FieldProps) {
  return (
    <View style={{ gap: spacing.xs }}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        placeholderTextColor={colors.muted}
        keyboardAppearance="dark"
        autoCapitalize="none"
        autoCorrect={false}
        maxFontSizeMultiplier={MAX_FONT_SCALE}
        style={[styles.input, style]}
        {...rest}
      />
      {hint ? <Text style={styles.hint}>{hint}</Text> : null}
    </View>
  );
}

export function Banner({
  tone = "info",
  children,
  action,
}: {
  tone?: "info" | "warning" | "danger";
  children: ReactNode;
  action?: { label: string; onPress: () => void };
}) {
  const color = tone === "danger" ? colors.danger : tone === "warning" ? colors.warning : colors.accent;
  return (
    <View accessibilityRole="alert" style={[styles.banner, { borderLeftColor: color }]}>
      <Text style={{ color: colors.text, flex: 1 }}>{children}</Text>
      {action ? <Button label={action.label} onPress={action.onPress} variant="ghost" /> : null}
    </View>
  );
}

export function Centered({ children }: { children: ReactNode }) {
  return <View style={styles.centered}>{children}</View>;
}

export function EmptyState({ title, body, children }: { title: string; body?: string; children?: ReactNode }) {
  return (
    <Centered>
      <Text style={styles.emptyTitle} accessibilityRole="header">
        {title}
      </Text>
      {body ? <Text style={styles.hint}>{body}</Text> : null}
      {children}
    </Centered>
  );
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
}: {
  options: ReadonlyArray<{ value: T; label: string }>;
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <View accessibilityRole="tablist" style={styles.segmented}>
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <Pressable
            key={option.value}
            accessibilityRole="tab"
            accessibilityLabel={option.label}
            accessibilityState={{ selected }}
            onPress={() => onChange(option.value)}
            style={[styles.segment, selected && { backgroundColor: colors.surfaceRaised }]}
          >
            <Text style={[styles.segmentLabel, selected && { color: colors.text }]}>{option.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  text: { color: colors.text, fontSize: 16 },
  button: {
    minHeight: 44,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth * 2,
    borderColor: colors.border,
    backgroundColor: colors.surfaceRaised,
    alignItems: "center",
    justifyContent: "center",
  },
  buttonLabel: { fontWeight: "600" },
  fieldLabel: { color: colors.muted, fontSize: 13, fontWeight: "600" },
  hint: { color: colors.muted, fontSize: 13 },
  input: {
    minHeight: 44,
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth * 2,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    color: colors.text,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    fontSize: 16,
  },
  banner: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    backgroundColor: colors.surface,
    borderLeftWidth: 4,
    paddingLeft: spacing.md,
    paddingVertical: spacing.sm,
    paddingRight: spacing.sm,
  },
  centered: { flex: 1, alignItems: "center", justifyContent: "center", padding: spacing.xl, gap: spacing.md },
  emptyTitle: { fontSize: 18, fontWeight: "700", textAlign: "center" },
  segmented: {
    flexDirection: "row",
    backgroundColor: colors.surface,
    borderRadius: radius.sm,
    padding: 3,
    gap: 3,
  },
  segment: { flex: 1, minHeight: 40, alignItems: "center", justifyContent: "center", borderRadius: radius.sm - 2 },
  segmentLabel: { color: colors.muted, fontWeight: "600", fontSize: 14 },
});
