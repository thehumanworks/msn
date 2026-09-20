import { useEffect, useState } from "react";
import { StyleSheet, TextInput, View } from "react-native";
import type { ChannelController, Draft } from "../core/channelController.ts";
import type { Message } from "../core/types.ts";
import { useKeyboardVisible } from "../hooks/useKeyboardVisible.ts";
import { colors, MAX_FONT_SCALE, radius, spacing } from "./theme.ts";
import { Banner, Button, Text } from "./ui.tsx";

type Props = {
  channel: ChannelController;
  replyTo: Message | null;
  onClearReply: () => void;
  bottomInset: number;
  /** A rejected message returned for editing; `n` changes each time so the same text can be restored twice. */
  restored: { draft: Draft; n: number } | null;
};

/** Multiline composer. Return sends by default (toggleable to a newline); Send is always visible. */
export function Composer({ channel, replyTo, onClearReply, bottomInset, restored }: Props) {
  const keyboardVisible = useKeyboardVisible();
  const [text, setText] = useState("");
  const [to, setTo] = useState("");
  const [showTo, setShowTo] = useState(false);
  const [returnSends, setReturnSends] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!restored) return;
    setText(restored.draft.text);
    setTo(restored.draft.to ?? "");
    setShowTo(!!restored.draft.to);
    setError(null);
  }, [restored]);

  function send() {
    const draft: Draft = { text, ...(to.trim() ? { to: to.trim() } : {}), ...(replyTo ? { replyTo: replyTo.id } : {}) };
    const result = channel.send(draft);
    if (!result.ok) return setError(result.error);
    setError(null);
    setText("");
    onClearReply();
  }

  return (
    <View style={[styles.wrap, { paddingBottom: keyboardVisible ? spacing.sm : Math.max(bottomInset, spacing.sm) }]}>
      {error ? <Banner tone="danger">{error}</Banner> : null}
      {replyTo ? (
        <View style={styles.reply}>
          <Text style={{ flex: 1, color: colors.muted, fontSize: 13 }} numberOfLines={1}>
            Replying to {replyTo.username}: {replyTo.text.replace(/\s+/g, " ").slice(0, 60)}
          </Text>
          <Button label="Cancel reply" variant="ghost" onPress={onClearReply} />
        </View>
      ) : null}
      {showTo ? (
        <TextInput
          accessibilityLabel="Recipient (optional)"
          placeholder="Recipient (optional)"
          placeholderTextColor={colors.muted}
          keyboardAppearance="dark"
          autoCapitalize="none"
          autoCorrect={false}
          maxFontSizeMultiplier={MAX_FONT_SCALE}
          value={to}
          onChangeText={setTo}
          style={[styles.input, { minHeight: 40 }]}
        />
      ) : null}
      <View style={styles.line}>
        <TextInput
          accessibilityLabel="Message"
          placeholder="Message"
          placeholderTextColor={colors.muted}
          keyboardAppearance="dark"
          multiline
          maxFontSizeMultiplier={MAX_FONT_SCALE}
          value={text}
          onChangeText={(value) => {
            setText(value);
            if (error) setError(null);
          }}
          returnKeyType={returnSends ? "send" : "default"}
          submitBehavior={returnSends ? "submit" : "newline"}
          onSubmitEditing={returnSends ? send : undefined}
          style={[styles.input, styles.message]}
        />
        <Button label="Send" variant="primary" onPress={send} disabled={!text.trim()} />
      </View>
      <View style={styles.options}>
        <Button
          label={showTo ? "Remove recipient" : "Add recipient"}
          variant="ghost"
          onPress={() => {
            if (showTo) setTo("");
            setShowTo(!showTo);
          }}
        />
        <Button
          label={returnSends ? "Return key: send" : "Return key: new line"}
          variant="ghost"
          accessibilityHint="Switches what the return key does"
          onPress={() => setReturnSends(!returnSends)}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    backgroundColor: colors.bg,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm,
    gap: spacing.sm,
  },
  line: { flexDirection: "row", alignItems: "flex-end", gap: spacing.sm },
  input: {
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth * 2,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    color: colors.text,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    fontSize: 16,
  },
  message: { flex: 1, minHeight: 44, maxHeight: 140, paddingTop: 10 },
  reply: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  options: { flexDirection: "row", justifyContent: "space-between" },
});
