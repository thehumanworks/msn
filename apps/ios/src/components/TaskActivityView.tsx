import { useMemo } from "react";
import { FlatList, StyleSheet, View } from "react-native";
import type { Message, TaskActivityEntry } from "../core/types.ts";
import { extractTaskActivity } from "../core/taskActivity.ts";
import { formatTime } from "./format.ts";
import { colors, radius, spacing } from "./theme.ts";
import { Banner, EmptyState, Text } from "./ui.tsx";

function details(entry: TaskActivityEntry): string[] {
  const { body } = entry;
  const lines: string[] = [];
  if (body.title) lines.push(body.title);
  if (body.owner) lines.push(`Owner: ${body.owner}`);
  if (body.reviewer) lines.push(`Reviewer: ${body.reviewer}`);
  if (body.dependsOn?.length) lines.push(`Depends on: ${body.dependsOn.join(", ")}`);
  if (body.reason) lines.push(`Reason: ${body.reason}`);
  if (body.acceptance) lines.push(`Acceptance: ${body.acceptance}`);
  if (body.evidence?.length) lines.push(`Evidence: ${body.evidence.map((id) => `#${id}`).join(", ")}`);
  return lines;
}

/** Newest first. Deliberately a log: no task state is computed here (see ADR 0019). */
export function TaskActivityView({ messages, truncated }: { messages: Message[]; truncated: boolean }) {
  const entries = useMemo(() => extractTaskActivity(messages).reverse(), [messages]);
  return (
    <FlatList
      data={entries}
      keyExtractor={(entry) => String(entry.messageId)}
      contentContainerStyle={{ padding: spacing.lg, gap: spacing.sm, flexGrow: 1 }}
      ListHeaderComponent={
        <View style={{ gap: spacing.sm, paddingBottom: spacing.sm }}>
          <Banner>
            Raw task activity from this channel's messages. It is not an authoritative task board: claims, conflicts
            and final states are not resolved here. Use the msn CLI for the effective board.
          </Banner>
          {truncated ? <Banner tone="warning">Only recent messages are loaded, so older task events are missing.</Banner> : null}
        </View>
      }
      ListEmptyComponent={
        <EmptyState title="No task activity" body="No msn.task.v1 messages were found among the loaded messages." />
      }
      renderItem={({ item }) => (
        <View style={styles.row} accessible accessibilityLabel={`${item.actor} ${item.body.action} task ${item.body.task}. ${details(item).join(". ")}`}>
          <View style={styles.head}>
            <Text style={{ fontWeight: "700", flexShrink: 1 }} numberOfLines={1}>
              {item.body.task}
            </Text>
            <View style={styles.badge}>
              <Text style={styles.badgeText}>{item.body.action}</Text>
            </View>
          </View>
          <Text style={styles.meta}>
            {item.actor} · {formatTime(item.createdAt)} · message #{item.messageId}
          </Text>
          {details(item).map((line) => (
            <Text key={line} style={{ fontSize: 14 }}>
              {line}
            </Text>
          ))}
        </View>
      )}
    />
  );
}

const styles = StyleSheet.create({
  row: { backgroundColor: colors.surface, borderRadius: radius.md, padding: spacing.md, gap: spacing.xs },
  head: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  badge: {
    backgroundColor: colors.surfaceRaised,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
  },
  badgeText: { color: colors.accent, fontSize: 12, fontWeight: "700" },
  meta: { color: colors.muted, fontSize: 12 },
});
