import { memo } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { sentByViewer } from "../../../ios/src/core/address.ts";
import { DeliveryTicks } from "../../../ios/src/components/DeliveryTicks.tsx";
import { boardNotice } from "../lib/notice.ts";
import {
  addressedTo,
  mayAnswer,
  tickLabel,
  tickLayout,
  type Message,
  type OutboxItem,
} from "../lib/shared.ts";
import { tickColor } from "../lib/tickColors.ts";
import { clockTime, color, nameColor } from "../lib/theme.ts";
import { Glass } from "./Glass.tsx";
import { Markdown } from "./Markdown.tsx";

const MINE_TEXT = "#ffffff";

export type Row =
  | { kind: "message"; message: Message; mine: boolean; showName: boolean; replied: Message | null; me: string }
  | { kind: "outbox"; item: OutboxItem };

function snippet(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > 90 ? `${line.slice(0, 90)}…` : line;
}

export const MessageBubble = memo(function MessageBubble({
  row,
  onLongPress,
  onAnswer,
}: {
  row: Extract<Row, { kind: "message" }>;
  onLongPress: (message: Message) => void;
  onAnswer: (message: Message, choice: string) => void;
}) {
  const { message, mine, showName, replied, me } = row;
  const notice = boardNotice(message);
  if (notice) {
    return (
      <Pressable onLongPress={() => onLongPress(message)} delayLongPress={300} style={styles.notice}>
        <Text style={styles.noticeText}>
          {notice} · {clockTime(message.createdAt)}
        </Text>
      </Pressable>
    );
  }
  const recipients = message.recipients ?? (message.to ? [message.to] : []);
  // The same case-insensitive name match the shared engine uses for questions and mentions.
  const toMe = recipients.some((name) => addressedTo(me, name));
  const json = message.contentType === "application/json";
  const canAnswer = Boolean(message.choices?.length) && !message.answered && mayAnswer(message, me);
  const textColor = mine ? MINE_TEXT : color.label;
  const ticks = tickLayout(sentByViewer(message.username, me), message.delivery);

  return (
    <View style={[styles.wrap, mine ? styles.right : styles.left, showName && { marginTop: 10 }]}>
      {showName && !mine ? (
        <Text style={[styles.name, { color: nameColor(message.username) }]}>{message.username}</Text>
      ) : null}
      <Pressable
        onLongPress={() => onLongPress(message)}
        delayLongPress={300}
        accessibilityHint="Long press for reply and copy"
        style={({ pressed }) => [
          styles.bubble,
          mine ? styles.mine : styles.theirs,
          toMe && !mine && styles.toMe,
          pressed && { opacity: 0.75 },
        ]}
      >
        {replied ? (
          <View style={[styles.reply, mine && { borderLeftColor: "rgba(255,255,255,0.7)" }]}>
            <Text
              style={[styles.replyName, { color: mine ? MINE_TEXT : nameColor(replied.username) }]}
              numberOfLines={1}
            >
              {replied.username}
            </Text>
            <Text style={[styles.replyText, mine && { color: "rgba(255,255,255,0.85)" }]} numberOfLines={2}>
              {snippet(replied.text)}
            </Text>
          </View>
        ) : null}
        {recipients.length ? (
          <Text style={[styles.to, mine && { color: "rgba(255,255,255,0.85)" }]}>→ {recipients.join(", ")}</Text>
        ) : null}
        {json ? (
          <Text style={[styles.json, { color: textColor }]} selectable>
            {message.text}
          </Text>
        ) : (
          <Markdown text={message.text} color={textColor} tint={mine ? MINE_TEXT : color.tint} />
        )}
        <View style={styles.timeRow}>
          <Text style={[styles.time, mine && { color: "rgba(255,255,255,0.75)" }]}>
            {message.claim ? `${message.claim.username} is on it · ` : ""}
            {message.editedAt ? "edited · " : ""}
            {clockTime(message.createdAt)}
          </Text>
          {ticks.marks > 0 ? (
            <DeliveryTicks
              marks={ticks.marks}
              color={tickColor(ticks.tone)}
              size={11}
              label={tickLabel(message.delivery)}
            />
          ) : null}
        </View>
      </Pressable>
      {message.answered ? (
        <Text style={styles.answered}>
          {message.answered.username} chose “{message.answered.choice}”
        </Text>
      ) : null}
      {canAnswer ? (
        <View style={styles.choices}>
          {message.choices?.map((choice) => (
            <Pressable key={choice} onPress={() => onAnswer(message, choice)} accessibilityRole="button">
              <Glass isInteractive tintColor={color.tint} style={styles.choice}>
                <Text style={styles.choiceText}>{choice}</Text>
              </Glass>
            </Pressable>
          ))}
        </View>
      ) : null}
    </View>
  );
});

const STATUS: Record<OutboxItem["status"], string> = {
  queued: "Waiting to send",
  sending: "Sending…",
  uncertain: "Not confirmed · tap to retry or discard",
  rejected: "Not sent · tap to edit or discard",
};

export function OutboxBubble({ item, onPress }: { item: OutboxItem; onPress: (item: OutboxItem) => void }) {
  const failed = item.status === "uncertain" || item.status === "rejected";
  return (
    <View style={[styles.wrap, styles.right, { marginTop: 4 }]}>
      <Pressable
        onPress={() => onPress(item)}
        disabled={!failed}
        style={[styles.bubble, styles.mine, { opacity: failed ? 1 : 0.6 }, failed && { backgroundColor: color.danger }]}
      >
        <Text style={[styles.plain, { color: MINE_TEXT }]}>{item.input.text}</Text>
      </Pressable>
      <Text style={[styles.status, failed && { color: color.danger }]}>{item.error ?? STATUS[item.status]}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { maxWidth: "84%", marginVertical: 2 },
  left: { alignSelf: "flex-start" },
  right: { alignSelf: "flex-end", alignItems: "flex-end" },
  name: { fontSize: 13, fontWeight: "600", marginLeft: 12, marginBottom: 3 },
  bubble: { borderRadius: 20, paddingHorizontal: 14, paddingVertical: 9, gap: 4, borderCurve: "continuous" },
  mine: { backgroundColor: color.mine },
  theirs: { backgroundColor: color.cell },
  toMe: { borderWidth: 1.5, borderColor: color.tint },
  reply: { borderLeftWidth: 3, borderLeftColor: color.tint, paddingLeft: 8, marginBottom: 2 },
  replyName: { fontSize: 13, fontWeight: "600" },
  replyText: { fontSize: 13, color: color.secondary },
  to: { fontSize: 13, fontWeight: "600", color: color.secondary },
  json: { fontFamily: "Menlo", fontSize: 13 },
  plain: { fontSize: 16, lineHeight: 22 },
  timeRow: { flexDirection: "row", alignItems: "center", alignSelf: "flex-end", gap: 3 },
  time: { fontSize: 11, color: color.secondary },
  answered: { fontSize: 12, color: color.secondary, marginTop: 3, marginHorizontal: 12 },
  choices: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 6 },
  choice: { borderRadius: 18, paddingHorizontal: 14, paddingVertical: 8 },
  choiceText: { fontSize: 15, fontWeight: "600", color: "#fff" },
  notice: { alignSelf: "center", maxWidth: "90%", marginVertical: 8 },
  noticeText: { fontSize: 12, color: color.secondary, textAlign: "center" },
  status: { fontSize: 12, color: color.secondary, marginTop: 3, marginRight: 6 },
});
