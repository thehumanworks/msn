import { useState } from "react";
import { FlatList, Pressable, RefreshControl, StyleSheet, View } from "react-native";
import type { ChannelListController } from "../core/channelList.ts";
import { currentUnread, unreadBadge } from "../core/readMarks.ts";
import type { ChannelSummary } from "../core/types.ts";
import { formatCount, formatTime } from "../components/format.ts";
import { colors, radius, spacing } from "../components/theme.ts";
import { Banner, Button, EmptyState, Field, Text } from "../components/ui.tsx";
import { useStore } from "../hooks/useStore.ts";

const SLUG = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export function ChannelListScreen({
  list,
  onSelect,
}: {
  list: ChannelListController;
  onSelect: (channel: string) => void;
}) {
  const state = useStore(list.state);
  const marks = useStore(list.marks);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  async function create() {
    const channel = name.trim();
    if (!SLUG.test(channel)) {
      setFormError("Use 1–64 lowercase letters, digits, hyphens or underscores.");
      return;
    }
    setBusy(true);
    setFormError(null);
    const error = await list.create(channel);
    setBusy(false);
    if (error) return setFormError(error);
    setName("");
    setCreating(false);
    onSelect(channel);
  }

  const header = (
    <View style={{ gap: spacing.md, paddingBottom: spacing.md }}>
      {state.error ? (
        <Banner tone="danger" action={{ label: "Retry", onPress: () => void list.load() }}>
          {state.error}
        </Banner>
      ) : null}
      {creating ? (
        <View style={styles.card}>
          <Field
            label="New channel"
            value={name}
            onChangeText={setName}
            placeholder="general"
            returnKeyType="done"
            onSubmitEditing={create}
            autoFocus
          />
          {formError ? <Banner tone="danger">{formError}</Banner> : null}
          <View style={{ flexDirection: "row", gap: spacing.sm }}>
            <Button label="Cancel" onPress={() => { setCreating(false); setFormError(null); }} style={{ flex: 1 }} />
            <Button label="Create" variant="primary" onPress={create} busy={busy} disabled={!name.trim()} style={{ flex: 1 }} />
          </View>
        </View>
      ) : (
        <Button label="New channel" onPress={() => setCreating(true)} />
      )}
    </View>
  );

  if (state.phase === "loading" && state.channels.length === 0) {
    return (
      <EmptyState title="Loading channels…" />
    );
  }

  return (
    <FlatList<ChannelSummary>
      data={state.channels}
      keyExtractor={(item) => item.name}
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={{ padding: spacing.lg, flexGrow: 1 }}
      ListHeaderComponent={header}
      ListEmptyComponent={
        state.phase === "error" ? (
          <EmptyState title="Channels unavailable" body="Pull down to try again." />
        ) : (
          <EmptyState title="No channels yet" body="Create the first channel to start a conversation." />
        )
      }
      refreshControl={
        <RefreshControl
          refreshing={false}
          onRefresh={() => void list.load()}
          tintColor={colors.muted}
        />
      }
      renderItem={({ item }) => {
        // Unread counts (ADR 0045): only for boards read on this device, and only while the
        // count still matches where the reader stopped.
        const badge = unreadBadge(currentUnread(state.unread, marks, item.name));
        return (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Channel ${item.name}, ${badge ? `${badge.label}, ` : ""}${formatCount(item.messageCount, "message")}`}
            onPress={() => onSelect(item.name)}
            style={({ pressed }) => [styles.row, pressed && { opacity: 0.7 }]}
          >
            <View style={styles.titleRow}>
              <Text style={{ fontWeight: "700", flex: 1 }} numberOfLines={1}>
                #{item.name}
              </Text>
              {badge ? (
                <View style={styles.badges}>
                  <Text style={styles.count}>{badge.count}</Text>
                  {badge.toYou ? <Text style={styles.mine}>{badge.toYou}</Text> : null}
                </View>
              ) : null}
            </View>
            <Text style={styles.meta}>
              {formatCount(item.messageCount, "message")} · {formatCount(item.participantCount, "participant")}
              {item.lastActivityAt ? ` · ${formatTime(item.lastActivityAt)}` : ""}
            </Text>
          </Pressable>
        );
      }}
      ItemSeparatorComponent={() => <View style={{ height: spacing.sm }} />}
    />
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    padding: spacing.md,
    gap: spacing.md,
  },
  row: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    padding: spacing.lg,
    minHeight: 44,
    gap: spacing.xs,
  },
  meta: { color: colors.muted, fontSize: 13 },
  titleRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  badges: { flexDirection: "row", gap: spacing.xs },
  count: {
    minWidth: 24,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: radius.pill,
    overflow: "hidden",
    backgroundColor: colors.surfaceRaised,
    color: colors.text,
    fontSize: 13,
    fontWeight: "700",
    textAlign: "center",
    fontVariant: ["tabular-nums"],
  },
  mine: {
    minWidth: 24,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: radius.pill,
    overflow: "hidden",
    backgroundColor: colors.accent,
    color: colors.onAccent,
    fontSize: 13,
    fontWeight: "700",
    textAlign: "center",
  },
});
