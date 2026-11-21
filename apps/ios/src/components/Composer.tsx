import { useEffect, useMemo, useState } from "react";
import { Pressable, StyleSheet, TextInput, View } from "react-native";
import type { ChannelController, Draft } from "../core/channelController.ts";
import {
  addressAfterEdit,
  addressAfterPick,
  insertMention,
  mentionAt,
  nextDismissed,
  type Persona,
  people,
  suggest,
} from "../core/mention.ts";
import { presets, sendAtFrom, whenText } from "../core/scheduled.ts";
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
  /** Called with each draft the controller accepted for sending. */
  onSent?: (draft: Draft) => void;
  /** Loaded messages and my name, for @ suggestions (ADR 0055). */
  messages?: readonly Message[];
  me?: string;
  /** The board's personas, asked for the first time @ is typed; rejects on a plain channel. */
  loadPersonas?: () => Promise<Persona[]>;
};

/** Multiline composer. Return sends by default (toggleable to a newline); Send is always visible. */
export function Composer({
  channel,
  replyTo,
  onClearReply,
  bottomInset,
  restored,
  onSent,
  messages = [],
  me = "",
  loadPersonas,
}: Props) {
  const keyboardVisible = useKeyboardVisible();
  const [text, setText] = useState("");
  const [to, setTo] = useState("");
  const [showTo, setShowTo] = useState(false);
  const [returnSends, setReturnSends] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // @ suggestions (ADR 0055): the caret, the name a pick put in To, the @ the reader closed,
  // and the board's personas once asked for (null until then).
  const [selection, setSelection] = useState({ start: 0, end: 0 });
  const [forced, setForced] = useState<{ start: number; end: number } | undefined>(undefined);
  const [mentionTo, setMentionTo] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(-1);
  const [personas, setPersonas] = useState<Persona[] | null>(null);
  const [asked, setAsked] = useState(false);
  // Send later (ADR 0060): the choice panel, a typed delay, and a note after scheduling.
  const [later, setLater] = useState(false);
  const [when, setWhen] = useState("");
  const [scheduling, setScheduling] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const at = selection.start === selection.end ? mentionAt(text, selection.start) : null;
  const open = at !== null && at.start !== dismissed;
  // Once no @ is being typed, a Close is forgotten: typing @ again (even in the same place)
  // opens the list again.
  const forget = nextDismissed(at, dismissed);
  useEffect(() => {
    if (forget !== dismissed) setDismissed(forget);
  }, [forget, dismissed]);
  const options = useMemo(
    () => (open && at ? suggest(people(personas ?? [], messages, me), at.query) : []),
    [open, at?.query, personas, messages, me],
  );

  useEffect(() => {
    if (!open || asked || !loadPersonas) return;
    setAsked(true);
    // A plain channel has no personas: the list keeps the senders it already knows.
    loadPersonas().then(setPersonas, () => setPersonas([]));
  }, [open, asked, loadPersonas]);

  function changeText(value: string) {
    setText(value);
    setForced(undefined);
    const address = addressAfterEdit(to, mentionTo, value);
    setMentionTo(address.mentionTo);
    if (address.to !== to) {
      setTo(address.to);
      if (!address.to) setShowTo(false);
    }
    if (error) setError(null);
  }

  function pick(name: string) {
    if (!at) return;
    const next = insertMention(text, at.start, selection.start, name);
    setText(next.text);
    setSelection({ start: next.caret, end: next.caret });
    setForced({ start: next.caret, end: next.caret });
    const address = addressAfterPick(to, mentionTo, name);
    setTo(address.to);
    setMentionTo(address.mentionTo);
    setShowTo(true);
  }

  useEffect(() => {
    if (!restored) return;
    setText(restored.draft.text);
    setTo(restored.draft.to ?? "");
    setShowTo(!!restored.draft.to);
    setMentionTo(null);
    setError(null);
  }, [restored]);

  // Another board has other people: ask again for its personas.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the board name is the trigger.
  useEffect(() => {
    setPersonas(null);
    setAsked(false);
  }, [channel.channel]);

  function send() {
    const draft: Draft = { text, ...(to.trim() ? { to: to.trim() } : {}), ...(replyTo ? { replyTo: replyTo.id } : {}) };
    const result = channel.send(draft);
    if (!result.ok) return setError(result.error);
    setError(null);
    setText("");
    // To filled by an @ pick belongs to that message; a typed To stays (ADR 0055).
    if (mentionTo !== null && mentionTo === to) {
      setTo("");
      setShowTo(false);
    }
    setMentionTo(null);
    setDismissed(-1);
    onSent?.(draft);
    onClearReply();
  }

  async function sendLater(sendAt: string | null) {
    if (!sendAt) return setError("Use a delay like 10m, 2h or 1d, or a time with a zone.");
    const draft: Draft = { text, ...(to.trim() ? { to: to.trim() } : {}), ...(replyTo ? { replyTo: replyTo.id } : {}) };
    setScheduling(true);
    const failure = await channel.schedule(draft, sendAt);
    setScheduling(false);
    if (failure) return setError(failure);
    setError(null);
    setNote(`Scheduled for ${whenText(sendAt)}. It posts as a normal message then.`);
    setText("");
    setWhen("");
    setLater(false);
    if (mentionTo !== null && mentionTo === to) {
      setTo("");
      setShowTo(false);
    }
    setMentionTo(null);
    onClearReply();
  }

  return (
    <View style={[styles.wrap, { paddingBottom: keyboardVisible ? spacing.sm : Math.max(bottomInset, spacing.sm) }]}>
      {error ? <Banner tone="danger">{error}</Banner> : null}
      {note && !error ? (
        <Text style={{ color: colors.muted, fontSize: 13 }} accessibilityLiveRegion="polite">
          {note}
        </Text>
      ) : null}
      {replyTo ? (
        <View style={styles.reply}>
          <Text style={{ flex: 1, color: colors.muted, fontSize: 13 }} numberOfLines={1}>
            Replying to {replyTo.username}: {replyTo.text.replace(/\s+/g, " ").slice(0, 60)}
          </Text>
          <Button label="Cancel reply" variant="ghost" onPress={onClearReply} />
        </View>
      ) : null}
      {showTo ? (
        <View style={styles.toLine}>
          <Text style={[styles.toLabel, to.trim() ? styles.toLabelSet : null]}>To</Text>
          <TextInput
            accessibilityLabel="Recipient (optional)"
            placeholder="Recipient (optional)"
            placeholderTextColor={colors.muted}
            keyboardAppearance="dark"
            autoCapitalize="none"
            autoCorrect={false}
            maxFontSizeMultiplier={MAX_FONT_SCALE}
            value={to}
            onChangeText={(value) => {
              setTo(value);
              if (value !== mentionTo) setMentionTo(null);
            }}
            style={[styles.input, { minHeight: 40, flex: 1 }]}
          />
        </View>
      ) : null}
      {options.length ? (
        <View style={styles.mentions} accessibilityRole="list" accessibilityLabel="People to mention">
          {options.map((person) => (
            <Pressable
              key={person.name}
              accessibilityRole="button"
              accessibilityLabel={`Mention ${person.name}${person.listening ? ", listening" : ""}`}
              onPress={() => pick(person.name)}
              style={({ pressed }) => [styles.mention, pressed ? styles.mentionPressed : null]}
            >
              <Text style={{ color: colors.text, flex: 1 }} numberOfLines={1}>
                @{person.name}
              </Text>
              {person.listening ? <Text style={{ color: colors.muted, fontSize: 12 }}>listening</Text> : null}
            </Pressable>
          ))}
          <Button label="Close" variant="ghost" onPress={() => at && setDismissed(at.start)} />
        </View>
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
          onChangeText={changeText}
          onSelectionChange={(event) => {
            setSelection(event.nativeEvent.selection);
            setForced(undefined);
          }}
          selection={forced}
          returnKeyType={returnSends ? "send" : "default"}
          submitBehavior={returnSends ? "submit" : "newline"}
          onSubmitEditing={returnSends ? send : undefined}
          style={[styles.input, styles.message]}
        />
        <Button label="Send" variant="primary" onPress={send} disabled={!text.trim()} />
      </View>
      {later ? (
        <View style={styles.later} accessibilityLabel="Send later">
          <View style={styles.presets}>
            {presets().map((choice) => (
              <Button
                key={choice.label}
                label={choice.label}
                disabled={!text.trim()}
                busy={scheduling}
                onPress={() => void sendLater(choice.sendAt)}
              />
            ))}
          </View>
          <View style={styles.toLine}>
            <TextInput
              accessibilityLabel="Send after a delay"
              placeholder="Or a delay: 10m, 2h, 1d"
              placeholderTextColor={colors.muted}
              keyboardAppearance="dark"
              autoCapitalize="none"
              autoCorrect={false}
              maxFontSizeMultiplier={MAX_FONT_SCALE}
              value={when}
              onChangeText={setWhen}
              style={[styles.input, { minHeight: 44, flex: 1 }]}
            />
            <Button
              label="Schedule"
              variant="primary"
              disabled={!text.trim() || !when.trim()}
              busy={scheduling}
              onPress={() => void sendLater(sendAtFrom(when))}
            />
          </View>
        </View>
      ) : null}
      <View style={styles.options}>
        <Button
          label={later ? "Send now instead" : "Send later"}
          variant="ghost"
          accessibilityHint="Choose a time for this message to post, even if the app is closed"
          onPress={() => {
            setLater(!later);
            setNote(null);
          }}
        />
        <Button
          label={showTo ? "Remove recipient" : "Add recipient"}
          variant="ghost"
          onPress={() => {
            if (showTo) {
              setTo("");
              setMentionTo(null);
            }
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
  options: { flexDirection: "row", justifyContent: "space-between", flexWrap: "wrap" },
  later: { gap: spacing.sm },
  presets: { flexDirection: "row", gap: spacing.sm, flexWrap: "wrap" },
  toLine: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  toLabel: { color: colors.muted, fontSize: 13 },
  toLabelSet: { color: colors.accent, fontWeight: "600" },
  mentions: {
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth * 2,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    paddingVertical: spacing.xs,
  },
  mention: { flexDirection: "row", alignItems: "center", minHeight: 44, paddingHorizontal: spacing.md, gap: spacing.sm },
  mentionPressed: { backgroundColor: colors.border },
});
