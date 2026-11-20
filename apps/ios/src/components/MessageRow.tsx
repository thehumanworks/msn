import { memo, useMemo } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { linksOf, parse, plainText } from "../core/markdown.ts";
import type { Message } from "../core/types.ts";
import { RECEIPTS_MEANING } from "../core/receipts.ts";
import { parseTaskActivity } from "../core/taskActivity.ts";
import { threadLabel, type ParentState } from "../core/threads.ts";
import { formatTime } from "./format.ts";
import { MarkdownText, openMessageLink } from "./MarkdownText.tsx";
import { colors, mono, radius, spacing } from "./theme.ts";
import { Text } from "./ui.tsx";

type Props = {
  message: Message;
  own: boolean;
  quoted: Message | undefined;
  selected: boolean;
  onReply: (message: Message) => void;
  /** A reply shown inside an open thread (ADR 0041). */
  nested?: boolean;
  /** A thread root's folded replies. */
  thread?: { replies: number; open: boolean; unseen: number };
  onToggleThread?: (root: number) => void;
  /** The parent of a reply whose parent is not loaded, once asked for. */
  parent?: ParentState;
  onLoadParent?: (id: number) => void;
  /** Processed-by line from explicit commits only (ADR 0040), or null. */
  receipts?: string | null;
};

function preview(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 80 ? `${flat.slice(0, 80)}…` : flat;
}

function quoteText(message: Message, quoted: Message | undefined, parent: ParentState | undefined): string {
  if (quoted) return `${quoted.username}: ${preview(quoted.text)}`;
  if (parent?.status === "loading") return `Loading message #${message.replyTo}…`;
  if (parent?.status === "loaded") return `Message #${message.replyTo} is no longer available.`;
  if (parent?.status === "error") return `Could not load #${message.replyTo}: ${parent.error} Tap to retry.`;
  return `Reply to message #${message.replyTo}`;
}

function MessageRowImpl({
  message,
  own,
  quoted,
  selected,
  onReply,
  nested,
  thread,
  onToggleThread,
  parent,
  onLoadParent,
  receipts = null,
}: Props) {
  const task = parseTaskActivity(message);
  const structured = message.contentType === "application/json";
  // Formatted text (ADR 0043): VoiceOver reads the words without markup and offers each link.
  const tree = useMemo(() => (task || structured ? null : parse(message.text)), [task, structured, message.text]);
  const spoken = tree ? plainText(tree) : message.text;
  const links = tree ? linksOf(tree).slice(0, 5) : [];
  const who = own ? "You" : message.username;
  const canLoadParent =
    message.replyTo !== undefined &&
    onLoadParent !== undefined &&
    !quoted &&
    parent?.status !== "loading" &&
    parent?.status !== "loaded";
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${who}${message.to ? ` to ${message.to}` : ""} at ${formatTime(message.createdAt)}: ${
        task ? `task ${task.body.action} ${task.body.task}` : preview(spoken)
      }`}
      accessibilityHint="Double tap to reply. Swipe up or down for more actions."
      // VoiceOver reads the row as one element, so its inner controls are offered as actions.
      accessibilityActions={[
        { name: "activate", label: "Reply" },
        ...(thread && onToggleThread
          ? [{ name: "toggleThread", label: threadLabel(thread.replies, thread.open, thread.unseen) }]
          : []),
        ...(canLoadParent ? [{ name: "loadParent", label: `Load message #${message.replyTo}` }] : []),
        ...links.map((link, index) => ({ name: `link${index}`, label: `Open link ${link.label}` })),
      ]}
      onAccessibilityAction={({ nativeEvent }) => {
        if (nativeEvent.actionName === "activate") onReply(message);
        else if (nativeEvent.actionName === "toggleThread") onToggleThread?.(message.id);
        else if (nativeEvent.actionName === "loadParent" && message.replyTo !== undefined)
          onLoadParent?.(message.replyTo);
        else if (nativeEvent.actionName.startsWith("link")) {
          const link = links[Number(nativeEvent.actionName.slice(4))];
          if (link) openMessageLink(link.href);
        }
      }}
      onPress={() => onReply(message)}
      style={[styles.row, own ? styles.own : styles.other, nested && styles.nested, selected && styles.selected]}
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
        canLoadParent && onLoadParent ? (
          <Pressable
            accessibilityRole="link"
            accessibilityHint="Loads the message this replies to"
            onPress={() => onLoadParent(message.replyTo as number)}
            style={styles.quote}
            hitSlop={8}
          >
            <Text style={[styles.quoteText, styles.link]} numberOfLines={2}>
              {quoteText(message, quoted, parent)}
            </Text>
          </Pressable>
        ) : (
          <View style={styles.quote}>
            <Text style={styles.quoteText} numberOfLines={2}>
              {quoteText(message, quoted, parent)}
            </Text>
          </View>
        )
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
        <MarkdownText text={message.text} style={styles.body} />
      )}
      {receipts ? (
        <Text
          style={styles.receipts}
          accessibilityLabel={`${receipts}. ${RECEIPTS_MEANING}`}
        >
          {receipts}
        </Text>
      ) : null}
      {thread && onToggleThread ? (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: thread.open }}
          onPress={() => onToggleThread(message.id)}
          style={styles.toggle}
          hitSlop={8}
        >
          <Text style={styles.toggleText}>{threadLabel(thread.replies, thread.open, thread.unseen)}</Text>
        </Pressable>
      ) : null}
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
  nested: { marginLeft: spacing.lg, borderLeftWidth: 2, borderLeftColor: colors.border },
  link: { color: colors.accent, textDecorationLine: "underline" },
  toggle: {
    alignSelf: "flex-start",
    minHeight: 32,
    justifyContent: "center",
    paddingHorizontal: spacing.sm,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
  },
  toggleText: { color: colors.accent, fontSize: 13, fontWeight: "600" },
  receipts: { color: colors.muted, fontSize: 12 },
});
