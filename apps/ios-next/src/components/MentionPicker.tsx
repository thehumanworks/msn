import { useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text } from "react-native";
import { type Persona, people, suggest } from "../../../ios/src/core/mention.ts";
import { MAX_RECIPIENTS } from "../../../ios/src/core/address.ts";
import type { Message } from "../lib/shared.ts";
import { color } from "../lib/theme.ts";
import { Surface } from "./Glass.tsx";

/** Only mounted while typing @. Scroll sideways so the suggestions never displace a tall draft. */
export function MentionPicker({ query, me, messages, load, recipients, onPick, onClose }: {
  query: string;
  me: string;
  messages: readonly Message[];
  load: () => Promise<Persona[]>;
  recipients: string[];
  onPick: (name: string) => void;
  onClose: () => void;
}) {
  const [personas, setPersonas] = useState<Persona[] | null>(null);
  useEffect(() => {
    let current = true;
    void load().then(
      (list) => { if (current) setPersonas(list); },
      () => { if (current) setPersonas([]); }, // Plain channels still suggest people from the conversation.
    );
    return () => { current = false; };
  }, [load]);
  const candidates = useMemo(() => people(personas ?? [], messages, me), [personas, messages, me]);
  const options = suggest(candidates, query);
  const full = recipients.length >= MAX_RECIPIENTS;
  return (
    <Surface strength="chip" style={styles.strip}>
      <ScrollView horizontal keyboardShouldPersistTaps="always" contentContainerStyle={styles.options}
        accessibilityLabel="People to mention" showsHorizontalScrollIndicator={false}>
        {full ? <Text style={styles.note}>Up to {MAX_RECIPIENTS} recipients</Text> : null}
        {options.map(({ name, listening }) => {
          const disabled = full && !recipients.some((kept) => kept.toLowerCase() === name.toLowerCase());
          return (
            <Pressable key={name} onPress={() => onPick(name)} disabled={disabled}
              accessibilityRole="button" accessibilityLabel={`Mention ${name}`}
              accessibilityHint={listening ? "Listening on this board" : undefined}
              style={({ pressed }) => [styles.option, (pressed || disabled) && { opacity: 0.55 }]}>
              <Text style={styles.optionText} numberOfLines={1}>@{name}</Text>
            </Pressable>
          );
        })}
        {!options.length ? <Text style={styles.note}>{personas === null ? "Looking for people…" : "No matching people"}</Text> : null}
      </ScrollView>
      <Pressable accessibilityRole="button" accessibilityLabel="Close mentions" onPress={onClose} style={styles.close}>
        <Text style={styles.note}>Close</Text>
      </Pressable>
    </Surface>
  );
}

const styles = StyleSheet.create({
  strip: { flexDirection: "row", alignItems: "center", borderRadius: 18, paddingHorizontal: 4 },
  options: { alignItems: "center", gap: 2, paddingLeft: 6 },
  option: { minHeight: 44, justifyContent: "center", paddingHorizontal: 8, maxWidth: 220 },
  optionText: { color: color.tint, fontWeight: "600", fontSize: 15 },
  note: { color: color.secondary, fontSize: 14, paddingHorizontal: 4 },
  close: { justifyContent: "center", minHeight: 44, paddingHorizontal: 5 },
});
