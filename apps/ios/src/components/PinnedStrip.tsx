import { useState } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import type { PinnedMessage } from "../core/types.ts";
import { colors, radius, spacing } from "./theme.ts";
import { Text } from "./ui.tsx";

/**
 * The board owner's pinned messages above the conversation (ADR 0038). Read-only in this app:
 * pin with the web app or `msn pin`. A tap shows the whole message; text is never interpreted.
 */
export function PinnedStrip({ pinned }: { pinned: PinnedMessage[] }) {
  const [open, setOpen] = useState(true);
  const [expanded, setExpanded] = useState<number | null>(null);
  if (!pinned.length) return null;
  return (
    <View style={styles.root}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={`${open ? "Hide" : "Show"} ${pinned.length} pinned messages`}
        onPress={() => setOpen((value) => !value)}
        hitSlop={8}
      >
        <Text style={styles.title}>
          {open ? "▾" : "▸"} Pinned · {pinned.length}
        </Text>
      </Pressable>
      {open ? (
        <ScrollView style={styles.list} nestedScrollEnabled>
          {pinned.map((pin) => (
            <Pressable
              key={pin.id}
              accessibilityRole="button"
              accessibilityHint="Shows the whole pinned message"
              onPress={() => setExpanded((id) => (id === pin.id ? null : pin.id))}
              style={styles.row}
            >
              <Text numberOfLines={expanded === pin.id ? undefined : 2} style={styles.text}>
                <Text style={styles.name}>{pin.username}: </Text>
                {pin.text}
              </Text>
            </Pressable>
          ))}
        </ScrollView>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    marginHorizontal: spacing.md,
    marginBottom: spacing.sm,
    padding: spacing.sm,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  title: { color: colors.accent, fontWeight: "700", fontSize: 14 },
  list: { maxHeight: 180, marginTop: spacing.xs },
  row: { paddingVertical: spacing.xs, minHeight: 32, justifyContent: "center" },
  text: { fontSize: 14, lineHeight: 19 },
  name: { fontWeight: "700", fontSize: 14 },
});
