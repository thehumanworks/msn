import { SymbolView } from "expo-symbols";
import type { ReactNode } from "react";
import {
  Pressable,
  type StyleProp,
  StyleSheet,
  Text,
  TextInput,
  type TextInputProps,
  View,
  type ViewStyle,
} from "react-native";
import { color } from "../lib/theme.ts";

// Grouped form pieces for sheets, in the system's inset-grouped look: solid cells on the grouped
// background, so text entry stays legible. Glass is kept for the floating controls (ADR 0078).

export function Card({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[styles.card, style]}>{children}</View>;
}

export function Heading({ children }: { children: string }) {
  return <Text style={styles.heading}>{children}</Text>;
}

export function Note({ children, tone }: { children: ReactNode; tone?: "danger" }) {
  return <Text style={[styles.note, tone === "danger" && { color: color.danger }]}>{children}</Text>;
}

/** A cell with a label and, on the right, a value or a control. */
export function Cell({ label, children, last }: { label: string; children?: ReactNode; last?: boolean }) {
  return (
    <View style={[styles.cell, !last && styles.divider]}>
      <Text style={styles.label}>{label}</Text>
      {children}
    </View>
  );
}

/** One of several choices; the chosen one carries a checkmark. */
export function Choice({
  label,
  detail,
  selected,
  onPress,
  last,
}: {
  label: string;
  detail?: string;
  selected: boolean;
  onPress: () => void;
  last?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="radio"
      accessibilityState={{ selected }}
      style={({ pressed }) => [styles.cell, !last && styles.divider, pressed && { opacity: 0.6 }]}
    >
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={styles.label}>{label}</Text>
        {detail ? <Text style={styles.detail}>{detail}</Text> : null}
      </View>
      {selected ? <SymbolView name="checkmark" tintColor={color.tint} size={17} weight="semibold" /> : null}
    </Pressable>
  );
}

export function Field({ last, style, ...props }: TextInputProps & { last?: boolean }) {
  return (
    <View style={[styles.fieldCell, !last && styles.divider]}>
      <TextInput
        placeholderTextColor={color.tertiary as unknown as string}
        autoCapitalize="none"
        autoCorrect={false}
        spellCheck={false}
        clearButtonMode="while-editing"
        {...props}
        style={[styles.field, style]}
      />
    </View>
  );
}

/** A full-width text button inside a card: the system style for an action in a grouped form. */
export function Action({
  label,
  detail,
  onPress,
  tone,
  disabled,
  busy,
  last,
}: {
  label: string;
  detail?: string;
  onPress: () => void;
  tone?: "danger";
  disabled?: boolean;
  busy?: boolean;
  last?: boolean;
}) {
  const off = disabled || busy;
  return (
    <Pressable
      onPress={onPress}
      disabled={off}
      accessibilityRole="button"
      accessibilityState={{ disabled: off, busy }}
      style={({ pressed }) => [styles.cell, !last && styles.divider, pressed && { opacity: 0.6 }]}
    >
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={[styles.action, tone === "danger" && { color: color.danger }, off && { color: color.tertiary }]}>
          {busy ? "Working…" : label}
        </Text>
        {detail ? <Text style={styles.detail}>{detail}</Text> : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: color.cell, borderRadius: 22, paddingHorizontal: 16, borderCurve: "continuous" },
  heading: {
    fontSize: 13,
    fontWeight: "600",
    color: color.secondary,
    textTransform: "uppercase",
    letterSpacing: 0.4,
    paddingHorizontal: 8,
    marginBottom: -8,
  },
  note: { fontSize: 13, lineHeight: 18, color: color.secondary, paddingHorizontal: 8 },
  cell: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    minHeight: 48,
    paddingVertical: 10,
    gap: 12,
  },
  divider: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: color.separator },
  label: { fontSize: 16, color: color.label },
  detail: { fontSize: 13, color: color.secondary },
  fieldCell: { minHeight: 48, justifyContent: "center" },
  field: { fontSize: 16, color: color.label, paddingVertical: 12 },
  action: { fontSize: 16, color: color.tint },
});
