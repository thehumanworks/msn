import { GlassContainer } from "expo-glass-effect";
import * as Haptics from "expo-haptics";
import { SymbolView } from "expo-symbols";
import { forwardRef } from "react";
import { Pressable, StyleSheet, Text, TextInput, type TextInputInstance, View } from "react-native";
import type { Message } from "../lib/shared.ts";
import { color } from "../lib/theme.ts";
import { Glass } from "./Glass.tsx";

/**
 * The floating glass composer: a reply chip, the text field and a send button that merge into
 * one shape through GlassContainer. Return inserts a newline; the button sends.
 */
export const Composer = forwardRef<
  TextInputInstance,
  {
    text: string;
    onChangeText: (text: string) => void;
    onSend: () => void;
    replyTo: Message | null;
    onCancelReply: () => void;
    error: string | null;
    readOnly?: string | null;
  }
>(function Composer({ text, onChangeText, onSend, replyTo, onCancelReply, error, readOnly }, ref) {
  const canSend = text.trim().length > 0;
  if (readOnly) {
    return (
      <Glass style={styles.readOnly}>
        <Text style={styles.readOnlyText}>{readOnly}</Text>
      </Glass>
    );
  }
  return (
    <View style={{ gap: 8 }}>
      {replyTo ? (
        <Glass style={styles.chip}>
          <SymbolView name="arrowshape.turn.up.left.fill" tintColor={color.tint} size={14} />
          <Text style={styles.chipText} numberOfLines={1}>
            Replying to <Text style={{ fontWeight: "700" }}>{replyTo.username}</Text>
          </Text>
          <Pressable onPress={onCancelReply} hitSlop={10} accessibilityLabel="Cancel reply">
            <SymbolView name="xmark.circle.fill" tintColor={color.secondary} size={18} />
          </Pressable>
        </Glass>
      ) : null}
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <GlassContainer spacing={10} style={styles.row}>
        <Glass style={styles.field}>
          <TextInput
            ref={ref}
            value={text}
            onChangeText={onChangeText}
            placeholder="Message"
            placeholderTextColor={color.tertiary as unknown as string}
            multiline
            style={styles.input}
            accessibilityLabel="Message"
          />
        </Glass>
        <Pressable
          onPress={() => {
            if (!canSend) return;
            void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            onSend();
          }}
          disabled={!canSend}
          accessibilityRole="button"
          accessibilityLabel="Send"
        >
          <Glass isInteractive tintColor={canSend ? color.tint : undefined} style={styles.send}>
            <SymbolView name="arrow.up" tintColor={canSend ? "#fff" : color.tertiary} size={20} weight="bold" />
          </Glass>
        </Pressable>
      </GlassContainer>
    </View>
  );
});

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "flex-end", gap: 10 },
  field: { flex: 1, borderRadius: 24, minHeight: 48, justifyContent: "center", paddingHorizontal: 16 },
  input: { fontSize: 17, color: color.label, maxHeight: 140, paddingTop: 12, paddingBottom: 12 },
  send: { width: 48, height: 48, borderRadius: 24, alignItems: "center", justifyContent: "center" },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    alignSelf: "flex-start",
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 18,
    maxWidth: "90%",
  },
  chipText: { fontSize: 14, color: color.label, flexShrink: 1 },
  error: { fontSize: 14, color: color.danger, marginLeft: 12 },
  readOnly: { borderRadius: 24, padding: 14, alignItems: "center" },
  readOnlyText: { fontSize: 15, color: color.secondary },
});
