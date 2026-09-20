import { memo } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import type { Message } from "../core/types.ts";
import { parseTaskActivity } from "../core/taskActivity.ts";
import { formatTime } from "./format.ts";
import { colors, mono, radius, spacing } from "./theme.ts";
import { Text } from "./ui.tsx";

type Props = {
  message: Message;
  own: boolean;
  quoted: Message | undefined;
  selected: boolean;
  onReply: (message: Message) => void;
};

function preview(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 80 ? `${flat.slice(0, 80)}…` : flat;
}

function MessageRowImpl({ message, own, quoted, selected, onReply }: Props) {
  const task = parseTaskActivity(message);
  const structured = message.contentType === "application/json";
  const who = own ? "You" : message.username;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${who}${message.to ? ` to ${message.to}` : ""} at ${formatTime(message.createdAt)}: ${
        task ? `task ${task.body.action} ${task.body.task}` : preview(message.text)
      }`}
      accessibilityHint="Double tap to reply"
      onPress={() => onReply(message)}
      style={[styles.row, own ? styles.own : styles.other, selected && styles.selected]}
    >
      <View style={styles.head}>
        <Text style={[styles.author, own && { color: colors.accent }]} numberOfLines={1}>
          {who}
        </Text>
        {message.to ? (
          <Text style={styles.to} numberOfLines={1}>
            → {message.to}
          </Text>
        ) : null}
        <Text style={styles.time}>{formatTime(message.createdAt)}</Text>
      </View>
      {message.replyTo !== undefined ? (
        <View style={styles.quote}>
          <Text style={styles.quoteText} numberOfLines={2}>
            {quoted ? `${quoted.username}: ${preview(quoted.text)}` : `Reply to message #${message.replyTo}`}
          </Text>
        </View>
      ) : null}
      {task ? (
        <Text style={styles.body}>
          Task <Text style={{ fontWeight: "700" }}>{task.body.task}</Text> · {task.body.action}
          {task.body.title ? ` · ${task.body.title}` : ""}
        </Text>
      ) : structured ? (
        <Text style={[styles.body, { fontFamily: mono, fontSize: 13 }]} numberOfLines={8}>
          {message.text}
        </Text>
      ) : (
        <Text style={styles.body} selectable>
          {message.text}
        </Text>
      )}
    </Pressable>
  );
}

export const MessageRow = memo(MessageRowImpl);

const styles = StyleSheet.create({
  row: {
    borderRadius: radius.md,
    padding: spacing.md,
    gap: spacing.xs,
    maxWidth: "92%",
    minHeight: 44,
  },
  own: { alignSelf: "flex-end", backgroundColor: colors.own },
  other: { alignSelf: "flex-start", backgroundColor: colors.surface },
  selected: { borderWidth: 2, borderColor: colors.accent },
  head: { flexDirection: "row", alignItems: "baseline", gap: spacing.sm },
  author: { fontWeight: "700", fontSize: 14, flexShrink: 1 },
  to: { color: colors.warning, fontSize: 13, flexShrink: 1 },
  time: { color: colors.muted, fontSize: 12, marginLeft: "auto" },
  quote: { borderLeftWidth: 3, borderLeftColor: colors.border, paddingLeft: spacing.sm },
  quoteText: { color: colors.muted, fontSize: 13 },
  body: { fontSize: 16 },
});
