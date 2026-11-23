import { useEffect, useMemo, useState } from "react";
import { FlatList, StyleSheet, TextInput, View } from "react-native";
import { exactSender } from "../core/address.ts";
import type { ApiClient } from "../core/apiClient.ts";
import { ChannelSearch, searchSummary } from "../core/search.ts";
import type { Message } from "../core/types.ts";
import { useStore } from "../hooks/useStore.ts";
import { MessageRow } from "./MessageRow.tsx";
import { colors, radius, spacing } from "./theme.ts";
import { Banner, Button, EmptyState, Text } from "./ui.tsx";

const noop = () => {};

/** Board search (ADR 0037): words, "a phrase" or from:name; newest matches first. */
export function SearchView({
  api,
  channel,
  me,
  onShareLink,
  origin,
}: {
  api: ApiClient;
  channel: string;
  me: string;
  onShareLink?: (message: Message) => void;
  origin?: string;
}) {
  const search = useMemo(() => new ChannelSearch(api, channel), [api, channel]);
  useEffect(() => () => search.cancel(), [search]);
  const state = useStore(search.state);
  const [input, setInput] = useState("");
  const submit = () => void search.search(input);

  return (
    <View style={{ flex: 1 }}>
      <View style={styles.bar}>
        <TextInput
          accessibilityLabel="Search this board"
          placeholder={'Search words, "a phrase" or from:name'}
          placeholderTextColor={colors.muted}
          keyboardAppearance="dark"
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
          clearButtonMode="while-editing"
          maxLength={300}
          value={input}
          onChangeText={setInput}
          onSubmitEditing={submit}
          style={styles.input}
        />
        <Button label="Search" onPress={submit} busy={state.loading && state.results.length === 0} />
      </View>
      {state.error ? <Banner tone="warning">{state.error}</Banner> : null}
      {!state.active ? (
        <EmptyState title="Search this board" body="Find earlier messages by words or sender." />
      ) : (
        <FlatList<Message>
          data={state.results}
          keyExtractor={(m) => String(m.id)}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          contentContainerStyle={{ padding: spacing.md, gap: spacing.sm }}
          ListHeaderComponent={
            <Text style={styles.summary} accessibilityRole="summary">
              {state.loading && state.results.length === 0 ? "Searching…" : searchSummary(state)}
            </Text>
          }
          ListFooterComponent={
            state.hasMore ? (
              <Button label="Older matches" busy={state.loading} onPress={() => void search.older()} />
            ) : null
          }
          renderItem={({ item }) => (
            <MessageRow message={item} own={!item.agentUserId && exactSender(item.username, me)} quoted={undefined} selected={false} onReply={noop} replyable={false} onShareLink={onShareLink} origin={origin} />
          )}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.sm,
  },
  input: {
    flex: 1,
    minHeight: 44,
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth * 2,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    color: colors.text,
    paddingHorizontal: spacing.md,
    fontSize: 16,
  },
  summary: { color: colors.muted, fontSize: 13 },
});
