import { useState } from "react";
import { StyleSheet, TextInput, View } from "react-native";
import type { ChannelController } from "../core/channelController.ts";
import { type ScheduledMessage, sendAtFrom, whenText } from "../core/scheduled.ts";
import { colors, MAX_FONT_SCALE, radius, spacing } from "./theme.ts";
import { Banner, Button, Text } from "./ui.tsx";

type Props = {
  channel: ChannelController;
  scheduled: readonly ScheduledMessage[];
  me: string;
  owner: boolean;
};

/** The board's scheduled messages (ADR 0060): a summary line that opens the list. */
export function ScheduledPanel({ channel, scheduled, me, owner }: Props) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<{ id: number; text: string; when: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!scheduled.length) return null;
  const failed = scheduled.filter((s) => s.status === "failed").length;
  const waiting = scheduled.length - failed;
  const summary = [waiting ? `${waiting} scheduled` : "", failed ? `${failed} failed to post` : ""]
    .filter(Boolean)
    .join(" · ");

  async function run(action: () => Promise<string | null>) {
    setBusy(true);
    const message = await action();
    setBusy(false);
    setError(message);
    if (!message) setEditing(null);
  }

  function save(item: ScheduledMessage) {
    if (!editing) return;
    const change: { text?: string; sendAt?: string } = {};
    if (editing.text !== item.text) change.text = editing.text;
    if (editing.when.trim()) {
      const sendAt = sendAtFrom(editing.when);
      if (!sendAt) return setError("Use a delay like 10m, 2h or 1d, or a time with a zone.");
      change.sendAt = sendAt;
    }
    void run(() => channel.changeScheduled(item.id, change));
  }

  return (
    <View style={styles.wrap}>
      <Button
        label={`${summary} · ${open ? "hide" : "show"}`}
        variant="ghost"
        accessibilityHint="Shows the messages waiting to post on this board"
        onPress={() => setOpen(!open)}
      />
      {open ? (
        <View style={styles.list} accessibilityRole="list" accessibilityLabel="Scheduled messages">
          {error ? <Banner tone="danger">{error}</Banner> : null}
          {scheduled.map((item) => {
            const mine = item.username === me;
            const isEditing = editing?.id === item.id;
            return (
              <View key={item.id} style={styles.item}>
                <Text style={styles.when}>
                  {item.status === "failed" ? "Was due" : item.repeats ? "Repeats, next" : "Posts"} {whenText(item.sendAt)} · {item.username}
                </Text>
                {isEditing ? (
                  <>
                    <TextInput
                      accessibilityLabel="New text"
                      multiline
                      keyboardAppearance="dark"
                      maxFontSizeMultiplier={MAX_FONT_SCALE}
                      value={editing.text}
                      onChangeText={(text) => setEditing({ ...editing, text })}
                      style={[styles.input, { minHeight: 64 }]}
                    />
                    <TextInput
                      accessibilityLabel="New time"
                      placeholder={item.status === "failed" ? "New time: 10m, 2h, 1d" : "New time (blank keeps it)"}
                      placeholderTextColor={colors.muted}
                      keyboardAppearance="dark"
                      autoCapitalize="none"
                      autoCorrect={false}
                      maxFontSizeMultiplier={MAX_FONT_SCALE}
                      value={editing.when}
                      onChangeText={(when) => setEditing({ ...editing, when })}
                      style={styles.input}
                    />
                    <View style={styles.actions}>
                      <Button label="Save" variant="primary" busy={busy} onPress={() => save(item)} />
                      <Button label="Close" variant="ghost" onPress={() => setEditing(null)} />
                    </View>
                  </>
                ) : (
                  <>
                    <Text numberOfLines={4}>{item.text}</Text>
                    {item.status === "failed" ? (
                      <Text style={{ color: colors.danger, fontSize: 13 }}>
                        Not posted: {item.error?.message || item.error?.code || "unknown error"}
                      </Text>
                    ) : null}
                    {mine || owner ? (
                      <View style={styles.actions}>
                        {mine ? (
                          <Button
                            label={item.status === "failed" ? "Pick a new time" : "Change"}
                            variant="ghost"
                            onPress={() => setEditing({ id: item.id, text: item.text, when: "" })}
                          />
                        ) : null}
                        <Button
                          label={item.repeats ? "Stop repeating" : "Cancel message"}
                          variant="ghost"
                          busy={busy}
                          onPress={() => void run(() => channel.cancelScheduled(item.id))}
                        />
                      </View>
                    ) : null}
                  </>
                )}
              </View>
            );
          })}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { backgroundColor: colors.bg, paddingHorizontal: spacing.md },
  list: { gap: spacing.sm, paddingBottom: spacing.sm, maxHeight: 360 },
  item: {
    gap: spacing.xs,
    padding: spacing.sm,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth * 2,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  when: { color: colors.muted, fontSize: 12 },
  actions: { flexDirection: "row", gap: spacing.sm },
  input: {
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth * 2,
    borderColor: colors.border,
    backgroundColor: colors.bg,
    color: colors.text,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    minHeight: 44,
    fontSize: 16,
  },
});
