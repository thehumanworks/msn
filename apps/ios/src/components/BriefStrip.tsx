import { useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, TextInput, View } from "react-native";
import { type Brief, briefCount, briefTitle } from "../core/brief.ts";
import { parse } from "../core/markdown.ts";
import { MarkdownText } from "./MarkdownText.tsx";
import { colors, MAX_FONT_SCALE, mono, radius, spacing } from "./theme.ts";
import { Banner, Button, Text } from "./ui.tsx";

/**
 * The board's brief above the conversation (ADR 0074): the owner's standing instructions, drawn
 * as safe Markdown. It scrolls inside its own box, so a long brief leaves the messages room.
 */
export function BriefStrip({ brief }: { brief: Brief | null }) {
  const [open, setOpen] = useState(true);
  const blocks = useMemo(() => (brief ? parse(brief.text) : []), [brief]);
  if (!brief) return null;
  return (
    <View style={styles.root}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={`${open ? "Hide" : "Show"} the board's brief`}
        onPress={() => setOpen((value) => !value)}
        hitSlop={8}
      >
        <Text style={styles.title}>
          {open ? "▾" : "▸"} {briefTitle(brief)}
        </Text>
      </Pressable>
      {open ? (
        <ScrollView style={styles.body} nestedScrollEnabled>
          <MarkdownText text={brief.text} blocks={blocks} style={styles.text} />
        </ScrollView>
      ) : null}
    </View>
  );
}

/**
 * Owner only: write the brief as Markdown, with a byte count against the 4 KiB limit. Saving
 * blank text removes the brief. `onSave` resolves to an error to show, or null when it is saved.
 */
export function BriefPanel({
  brief,
  onSave,
  onClose,
}: {
  brief: Brief | null;
  onSave: (text: string) => Promise<string | null>;
  onClose: () => void;
}) {
  const [text, setText] = useState(brief?.text ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const count = briefCount(text);
  const save = async () => {
    setBusy(true);
    const failed = await onSave(text);
    setBusy(false);
    setError(failed);
    if (!failed) onClose();
  };
  return (
    <View style={styles.panel}>
      <Text style={styles.note}>
        Standing instructions for everyone on this board. Every agent receives the brief first when it starts, and is
        told when you change it. The goal says what to achieve; the brief says how to work here.
      </Text>
      <TextInput
        accessibilityLabel="Board brief, Markdown"
        placeholder="Markdown: how to work on this board"
        placeholderTextColor={colors.muted}
        keyboardAppearance="dark"
        autoCapitalize="sentences"
        multiline
        maxFontSizeMultiplier={MAX_FONT_SCALE}
        value={text}
        onChangeText={setText}
        style={styles.input}
      />
      <Text style={[styles.count, count.over ? { color: colors.danger } : null]}>{count.label}</Text>
      {error ? <Banner tone="danger">{error}</Banner> : null}
      <View style={styles.row}>
        <Button
          variant="primary"
          label={!text.trim() && brief ? "Remove brief" : "Save"}
          busy={busy}
          disabled={count.over}
          onPress={() => void save()}
        />
        <Button variant="ghost" label="Cancel" onPress={onClose} />
      </View>
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
  body: { maxHeight: 180, marginTop: spacing.xs },
  text: { fontSize: 14, lineHeight: 19 },
  panel: {
    marginHorizontal: spacing.md,
    marginBottom: spacing.sm,
    padding: spacing.md,
    gap: spacing.sm,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  note: { color: colors.muted, fontSize: 13, lineHeight: 18 },
  input: {
    minHeight: 140,
    maxHeight: 260,
    padding: spacing.sm,
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    color: colors.text,
    fontFamily: mono,
    fontSize: 14,
    textAlignVertical: "top",
  },
  count: { color: colors.muted, fontSize: 12 },
  row: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
});
