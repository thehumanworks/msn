import { useEffect, useState } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import type { AgentStatus } from "../core/types.ts";
import { formatAgo, formatTime } from "./format.ts";
import { colors, radius, spacing } from "./theme.ts";
import { Text } from "./ui.tsx";

/**
 * What each name on the board says it is doing (ADR 0064), beside the name, with how long ago it
 * was set. Only what the agent said: the text is shown as plain text and never inferred.
 */
export function StatusStrip({ statuses }: { statuses: AgentStatus[] }) {
  const [open, setOpen] = useState(true);
  const [now, setNow] = useState(() => Date.now());
  // "3 min ago" moves on by itself, once a minute while the strip is on screen.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  if (!statuses.length) return null;
  return (
    <View style={styles.root}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={`${open ? "Hide" : "Show"} ${statuses.length} agent statuses`}
        onPress={() => setOpen((value) => !value)}
        hitSlop={8}
        style={styles.header}
      >
        <Text style={styles.title}>
          {open ? "▾" : "▸"} Agent status · {statuses.length}
        </Text>
      </Pressable>
      {open ? (
        <ScrollView style={styles.list} nestedScrollEnabled>
          {statuses.map((status) => (
            <View
              key={status.name}
              style={styles.row}
              accessible
              accessibilityLabel={`${status.name}: ${status.text}, set ${formatAgo(status.setAt, now)}`}
            >
              {/* Three separate Text views, so nothing in one can reorder the others. */}
              <Text style={styles.name}>{status.name}</Text>
              <Text style={styles.text}>“{status.text}”</Text>
              <Text style={styles.when}>
                {formatAgo(status.setAt, now)} · {formatTime(status.setAt)}
              </Text>
            </View>
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
  header: { minHeight: 32, justifyContent: "center" },
  title: { color: colors.accent, fontWeight: "700", fontSize: 14 },
  list: { maxHeight: 140, marginTop: spacing.xs },
  row: { paddingVertical: 2, flexDirection: "row", flexWrap: "wrap", alignItems: "baseline", columnGap: 6 },
  text: { fontSize: 14, lineHeight: 19 },
  name: { fontWeight: "700", fontSize: 14 },
  when: { color: colors.muted, fontSize: 12, lineHeight: 19 },
});
